/**
 * The preferences endpoint, over real HTTP.
 *
 * The options panel and the OBS browser source are two different browsers with
 * separate storage, so the server is the only thing they both see — which is
 * the only reason preferences live on it at all. The line these lean on is that
 * a preference is not a score: nothing here may move the count, no matter how
 * it is spelled.
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

let nextPort = 15731;

// A 'dir' symlink on Windows needs Developer Mode or an elevated shell; a
// junction is the same thing for our purposes and needs neither.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Boot server.js in a throwaway cwd so the real state.json is never touched. */
async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-prefs-'));
  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
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
    async stop() {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test('the panel and the OBS source see the same camera, sound and volume', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const { status } = await server.post('/api/prefs', {
    camera: 'Brio 100',
    sound: 'fahh',
    volume: 0.3,
  });

  assert.equal(status, 200);
  const state = await server.state();
  assert.equal(state.camera, 'Brio 100');
  assert.equal(state.sound, 'fahh');
  assert.equal(state.volume, 0.3);
});

test('only what was sent changes — absent is not the same as null', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/prefs', { camera: 'Brio 100', sound: 'boing', volume: 0.6 });
  await server.post('/api/prefs', { volume: 0.2 });

  const state = await server.state();
  assert.equal(state.camera, 'Brio 100', 'a volume change is not a camera change');
  assert.equal(state.sound, 'boing');
  assert.equal(state.volume, 0.2);
});

test('null is how a preference goes back to the page default', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.post('/api/prefs', { sound: 'boing', camera: 'Brio' });
  await server.post('/api/prefs', { sound: null, camera: null });

  const state = await server.state();
  assert.equal(state.sound, null);
  assert.equal(state.camera, null);
});

test('a volume outside the dial is refused rather than clamped silently', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (const volume of [1.5, -0.2, 'loud']) {
    const { status } = await server.post('/api/prefs', { volume });
    assert.equal(status, 400, `volume=${volume}`);
  }

  assert.equal((await server.state()).volume, null, 'and nothing was written');
});

test('the sound name is taken as a word, not run through a list the server keeps', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // The page owns the list of sounds and falls back on its own when handed a
  // name it cannot place. The server only checks it is short and plain.
  await server.post('/api/prefs', { sound: '  BOING  ' });
  assert.equal((await server.state()).sound, 'boing', 'trimmed and lowercased');

  const { status } = await server.post('/api/prefs', { sound: 42 });
  assert.equal(status, 400, 'but a number is not a name');
});

test('preferences cannot touch the count, whatever they are called', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const before = await server.state();
  const { status } = await server.post('/api/prefs', {
    camera: 'Brio',
    done: 500,
    carriedOver: -1000,
    left: 0,
    owed: 0,
  });

  assert.equal(status, 200, 'the extra keys are ignored, not an error');
  const after = await server.state();
  assert.equal(after.done, before.done, 'done is the detector’s alone');
  assert.equal(after.carriedOver, before.carriedOver);
  assert.equal(after.owed, before.owed);
  assert.equal(after.camera, 'Brio', 'while the real preference still landed');
});

test('the old /api/camera spelling still works, because it is in old notes', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const { status } = await server.post('/api/camera', { camera: 'LifeCam' });

  assert.equal(status, 200);
  assert.equal((await server.state()).camera, 'LifeCam');
});

test('preferences survive a restart, which is the whole point of them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-prefs-keep-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  await fs.symlink(path.join(ROOT, 'public'), path.join(dir, 'public'), LINK_TYPE);

  const port = nextPort++;
  const run = async (fn) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
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
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  };

  await run(async (base) => {
    await fetch(`${base}/api/prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound: 'pop', volume: 0.15 }),
    });
  });

  const state = await run(async (base) => (await fetch(`${base}/api/state`)).json());
  assert.equal(state.sound, 'pop');
  assert.equal(state.volume, 0.15);
});
