/**
 * The server's one writing endpoint, over real HTTP.
 *
 * The whole design rests on there being no way to move the count except doing a
 * push-up in front of the camera, so these lean hard on the negative cases: the
 * old manual endpoints must be gone, and `/api/rep` must refuse anything that
 * would let you hand a rep back or bank fifty at once.
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
let nextPort = 14931;

// A 'dir' symlink on Windows needs Developer Mode or an elevated shell, so the
// whole suite fails with EPERM on a stock machine. A junction is the same thing
// for our purposes — pointing a directory at another directory — and needs
// neither. Everywhere else 'dir' is the right answer.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Boot server.js in a throwaway cwd so the real state.json is never touched. */
async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-rep-'));
  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  // Serve the real pages, without duplicating 24 MiB of vendored model.
  await fs.symlink(path.join(ROOT, 'public'), path.join(dir, 'public'), LINK_TYPE);

  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('OBS source')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async post(endpoint, body) {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async state() {
      return (await fetch(`${base}/api/state`)).json();
    },
    async raw(endpoint, init) {
      return fetch(`${base}${endpoint}`, init);
    },
    async stop() {
      // Windows keeps the cwd handle open until the process is really gone, so
      // removing the directory the instant after kill() returns EBUSY.
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test('a detected rep brings the number down by one', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const before = await server.state();
  const { status, body } = await server.post('/api/rep', { clientId: 'overlay-a' });

  assert.equal(status, 200);
  assert.equal(body.done, before.done + 1);
  assert.equal(body.rawLeft, before.rawLeft - 1);
});

test('reps default to one, so the overlay need not say so', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/rep', {});
  assert.equal((await server.state()).done, 1);
});

test('a held batch is accepted, so a network blip does not cost you push-ups', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // The overlay queues reps while the server is unreachable and flushes them.
  const { status } = await server.post('/api/rep', { reps: 6, clientId: 'overlay-a' });
  assert.equal(status, 200);
  assert.equal((await server.state()).done, 6);
});

test('you cannot hand a rep back', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/rep', { reps: 5 });

  for (const reps of [-1, -10, 0]) {
    const { status } = await server.post('/api/rep', { reps });
    assert.equal(status, 400, `reps: ${reps} must be rejected`);
  }
  assert.equal((await server.state()).done, 5, 'nothing was taken back');
});

test('fractions and nonsense are rejected rather than coerced', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (const reps of [1.5, 'lots', null, {}, Infinity, NaN]) {
    const { status } = await server.post('/api/rep', { reps });
    assert.equal(status, 400, `reps: ${JSON.stringify(reps)} must be rejected`);
  }
  assert.equal((await server.state()).done, 0);
});

test('a single report cannot bank an entire session', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const { status, body } = await server.post('/api/rep', { reps: 5000 });
  assert.equal(status, 400);
  assert.match(body.error, /between 1 and 50/);
  assert.equal((await server.state()).done, 0);
});

test('the endpoints that could fake the count are gone', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Every one of these existed before and could move the number without a
  // push-up being done. Their absence is the feature.
  for (const endpoint of ['/api/done', '/api/undo', '/api/settings', '/api/pledge', '/api/new-stream']) {
    const { status } = await server.post(endpoint, { amount: 100, done: 0, pledged: 0 });
    assert.equal(status, 404, `${endpoint} must not exist`);
  }
  assert.equal((await server.state()).done, 0);
});

test('the state the overlay draws from adds up', async (t) => {
  const server = await startServer({ PUSHUPS_PER_SUB: '2' });
  t.after(() => server.stop());

  const state = await server.state();
  assert.equal(state.perSub, 2, 'push-ups per sub is configuration, not a page control');
  // No API key in the test environment, so no subs and nothing owed yet.
  assert.equal(state.owed, state.carriedOver + state.fromSubs);
  assert.equal(state.rawLeft, state.owed - state.done);
  assert.equal(state.left, Math.max(0, state.rawLeft));
});

test('left never goes negative, so getting ahead banks nothing', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/rep', { reps: 20 });
  const state = await server.state();

  assert.equal(state.rawLeft, -20, 'the raw figure keeps the overshoot');
  assert.equal(state.left, 0, 'what the overlay shows bottoms out at zero');
});

test('the server reports which page is counting, and forgets non-counters', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  assert.equal((await server.state()).countingClientId, null);

  await server.post('/api/rep', { clientId: 'overlay-a' });
  assert.equal((await server.state()).countingClientId, 'overlay-a');

  // Most recent wins, so a second source can see it has taken over.
  await server.post('/api/rep', { clientId: 'overlay-b' });
  assert.equal((await server.state()).countingClientId, 'overlay-b');
});

test('a hostile client id is bounded and a non-string ignored', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/rep', { clientId: 'x'.repeat(500) });
  assert.equal((await server.state()).countingClientId.length, 64);

  await server.post('/api/rep', { clientId: { evil: true } });
  const state = await server.state();
  assert.equal(state.done, 2, 'the rep still counted');
});

test('reps still count when a page sends no id at all', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const { status } = await server.post('/api/rep', { reps: 3 });
  assert.equal(status, 200);
  assert.equal((await server.state()).done, 3);
});

test('there is no token to get wrong', async (t) => {
  // The control token was the only login-shaped thing in the app. A source that
  // silently banks nothing because a token is missing is exactly the failure
  // this removes.
  const server = await startServer({ CONTROL_TOKEN: 'left-over-from-the-old-config' });
  t.after(() => server.stop());

  const { status } = await server.post('/api/rep', { reps: 2 });
  assert.equal(status, 200, 'a stale CONTROL_TOKEN in .env must not lock the source out');
  assert.equal((await server.state()).done, 2);
});

test('the overlay and its modules are served with usable content types', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (const [file, type] of [
    ['/overlay.html', 'text/html'],
    ['/status.html', 'text/html'],
    ['/js/overlay.js', 'text/javascript'],
    ['/js/overlay-options.js', 'text/javascript'],
    ['/js/counter-client.js', 'text/javascript'],
  ]) {
    const res = await server.raw(file);
    assert.equal(res.status, 200, `${file} should be served`);
    assert.match(res.headers.get('content-type'), new RegExp(type), `${file} content type`);
  }

  // `/` lands on the status page, not the thing you put in OBS.
  const root = await server.raw('/');
  assert.match(await root.text(), /Push-Up Counter — Status/);
});

test('HEAD works on static files — the overlay probes for vendored assets with it', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const res = await server.raw('/js/overlay.js', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});
