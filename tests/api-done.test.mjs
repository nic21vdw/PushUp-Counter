/**
 * Exercises the server's /api/done endpoint over real HTTP, with a focus on the
 * webcam path: reps arrive one at a time and must roll up into a single history
 * entry rather than flushing the log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Tests in a file run one after another, so handing out ports in sequence is
// enough to keep the servers from colliding.
let nextPort = 14731;

// A 'dir' symlink on Windows needs Developer Mode or an elevated shell, so the
// whole suite fails with EPERM on a stock machine. A junction is the same thing
// for our purposes — pointing a directory at another directory — and needs
// neither. Everywhere else 'dir' is the right answer.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Boot server.js in a throwaway cwd so the real state.json is never touched. */
async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-test-'));
  // The server writes state.json next to itself, so copy it into the sandbox.
  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  // Serve the real pages, without duplicating 24 MiB of vendored model.
  await fs.symlink(path.join(ROOT, 'public'), path.join(dir, 'public'), LINK_TYPE);

  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listening banner, and fail fast if it dies instead.
  await new Promise((resolve, reject) => {
    const stderr = [];
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15_000);
    const settle = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Control page')) settle(resolve);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => settle(reject, err));
    child.on('exit', (code) =>
      settle(reject, new Error(`server exited with ${code}: ${Buffer.concat(stderr)}`)),
    );
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async post(endpoint, body, headers = {}) {
      const res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async state() {
      return (await fetch(`${base}/api/state`)).json();
    },
    async get(pathname) {
      const res = await fetch(base + pathname);
      return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
    },
    async head(pathname) {
      const res = await fetch(base + pathname, { method: 'HEAD' });
      return {
        status: res.status,
        type: res.headers.get('content-type'),
        length: res.headers.get('content-length'),
        text: await res.text(),
      };
    },
    async stop() {
      // Windows keeps the cwd handle open until the process is really gone, so
      // removing the directory the instant after kill() returns EBUSY. Waiting
      // for `exit` is the fix; it is a no-op everywhere else.
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test('a manual set records one history entry', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const { status, body } = await server.post('/api/done', { amount: 20 });
  assert.equal(status, 200);
  assert.equal(body.done, 20);
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0].source, 'manual');
});

test('detected reps roll up into a single entry instead of flooding history', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (let i = 0; i < 30; i++) {
    await server.post('/api/done', { amount: 1, source: 'camera' });
  }
  const state = await server.state();

  assert.equal(state.done, 30);
  assert.equal(state.history.length, 1, 'thirty reps should be one entry');
  assert.equal(state.history[0].amount, 30);
  assert.equal(state.history[0].source, 'camera');
});

test('undo after a detected set takes back the whole set', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/done', { amount: 100 });
  for (let i = 0; i < 12; i++) await server.post('/api/done', { amount: 1, source: 'camera' });
  assert.equal((await server.state()).done, 112);

  await server.post('/api/undo');
  const state = await server.state();
  assert.equal(state.done, 100, 'the 12 detected reps come back off together');
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].source, 'manual');
});

test('a manual entry between detected reps is not swallowed', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/done', { amount: 1, source: 'camera' });
  await server.post('/api/done', { amount: 50 });
  await server.post('/api/done', { amount: 1, source: 'camera' });

  const state = await server.state();
  assert.equal(state.done, 52);
  assert.deepEqual(
    state.history.map((h) => [h.source, h.amount]),
    [
      ['camera', 1],
      ['manual', 50],
      ['camera', 1],
    ],
  );
});

test('a -1 correction cancels out of the rolled-up run', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/done', { amount: 1, source: 'camera' });
  await server.post('/api/done', { amount: 1, source: 'camera' });
  await server.post('/api/done', { amount: -1, source: 'camera' });

  let state = await server.state();
  assert.equal(state.done, 1);
  assert.equal(state.history[0].amount, 1);

  // Correcting the run down to nothing should not leave an empty entry behind.
  await server.post('/api/done', { amount: -1, source: 'camera' });
  state = await server.state();
  assert.equal(state.done, 0);
  assert.equal(state.history.length, 0);
});

test('remaining reflects detected reps and never goes below zero', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/settings', { pledged: 3, done: 0 });
  for (let i = 0; i < 5; i++) await server.post('/api/done', { amount: 1, source: 'camera' });

  const state = await server.state();
  assert.equal(state.remaining, 0, 'clamped for the overlay');
  assert.equal(state.rawRemaining, -2, 'but the surplus is still tracked');
});

test('a zero or non-numeric amount is rejected', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  assert.equal((await server.post('/api/done', { amount: 0, source: 'camera' })).status, 400);
  assert.equal((await server.post('/api/done', { amount: 'lots' })).status, 400);
  assert.equal((await server.state()).done, 0);
});

test('detected reps require the control token when one is set', async (t) => {
  const server = await startServer({ CONTROL_TOKEN: 'secret' });
  t.after(() => server.stop());

  assert.equal((await server.post('/api/done', { amount: 1, source: 'camera' })).status, 401);
  assert.equal((await server.state()).done, 0);

  const ok = await server.post(
    '/api/done',
    { amount: 1, source: 'camera' },
    { Authorization: 'Bearer secret' },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.done, 1);
});

test('the camera page and its modules are served with usable content types', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await server.get('/camera.html');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /js\/camera\.js/);

  // ES modules must be served as JavaScript or the browser refuses them.
  for (const module of ['camera', 'rep-counter', 'pose-math', 'pose-tracker', 'counter-client']) {
    const res = await server.get(`/js/${module}.js`);
    assert.equal(res.status, 200, `/js/${module}.js should be served`);
    assert.match(res.type, /javascript/, `/js/${module}.js needs a JS content type`);
  }

  // The control page has to be able to reach the camera page.
  const control = await server.get('/control.html');
  assert.match(control.text, /camera\.html/);
});

test('HEAD works on static files — the camera page probes for vendored assets with it', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const head = await server.head('/camera.html');
  assert.equal(head.status, 200, 'a 405 here sends the page to the CDN unnecessarily');
  assert.match(head.type, /text\/html/);
  assert.ok(Number(head.length) > 0, 'Content-Length should describe the real file');
  assert.equal(head.text, '', 'HEAD must not return a body');

  assert.equal((await server.head('/vendor/nope.task')).status, 404);
  // Anything other than GET/HEAD/POST is still refused.
  const res = await fetch(`${server.base}/camera.html`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});

test('the pose runtime is served with types the browser will accept', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const vendored = await server.head('/vendor/tasks-vision/vision_bundle.mjs');
  if (vendored.status === 404) {
    t.skip('run `npm run fetch-assets` to check the vendored asset types');
    return;
  }

  // A module served as octet-stream is refused by import(), and
  // WebAssembly.instantiateStreaming insists on application/wasm.
  assert.match(vendored.type, /javascript/, '.mjs must be served as JavaScript');
  assert.equal(
    (await server.head('/vendor/tasks-vision/wasm/vision_wasm_internal.wasm')).type,
    'application/wasm',
  );
  assert.equal((await server.head('/vendor/models/pose_landmarker_lite.task')).status, 200);
});
