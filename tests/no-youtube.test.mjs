/**
 * Running without YouTube credentials is the ordinary case, not a broken setup:
 * you set the target yourself and the camera counts reps off it.
 *
 * It used to look broken anyway — an unconfigured server polled regardless,
 * threw, and parked "YOUTUBE_API_KEY is not set" in the `error` field that every
 * page displays. These tests pin down that a bare server is quiet.
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

// Distinct from the other suites' ranges (14731, 14831): `node --test` runs test
// files concurrently, so a shared base port means two servers race for it and the
// loser dies with EADDRINUSE.
let nextPort = 14931;

// See api-done.test.mjs — a 'dir' symlink needs Developer Mode on Windows, a
// junction does not.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Boot server.js in a throwaway cwd with the YouTube settings explicitly blank,
 * so a key in the developer's own environment cannot leak in and make this
 * suite hit the network.
 */
async function startBareServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-bare-'));
  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  await fs.symlink(path.join(ROOT, 'public'), path.join(dir, 'public'), LINK_TYPE);

  const port = nextPort++;
  const out = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      YOUTUBE_API_KEY: '',
      YOUTUBE_CHANNEL_ID: '',
      YOUTUBE_HANDLE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const stderr = [];
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15_000);
    const settle = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    child.stdout.on('data', (chunk) => {
      out.push(chunk.toString());
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
    stdout: () => out.join(''),
    /**
     * The boot banner is printed in several writes, and startup resolves on the
     * first of them — so a later line is not on stdout yet when a test looks.
     */
    async waitForLog(pattern, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(out.join(''))) return out.join('');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`log never matched ${pattern}. Got:\n${out.join('')}`);
    },
    async post(endpoint, body) {
      const res = await fetch(base + endpoint, {
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

// Booting a server costs a process and a port, and `node --test` runs files
// concurrently — so the read-only assertions share one rather than starting five
// and making the whole suite contend for CPU.
test('a bare server is quiet about the credentials it does not have', async (t) => {
  const server = await startBareServer();
  t.after(() => server.stop());

  await t.test('reports no error', async () => {
    const state = await server.state();
    assert.equal(state.configured, false);
    assert.equal(state.error, null, 'a bare server must not surface an error');
    assert.equal(state.subs, null);
    assert.equal(state.subsGained, 0);
    assert.equal(state.fromSubs, 0);
  });

  await t.test('presents it in the banner as a mode, not a missing key', async () => {
    const log = await server.waitForLog(/Subscriber tracking is off/);
    // The old warning read like something needed fixing.
    assert.doesNotMatch(log, /YOUTUBE_API_KEY is missing/);
  });

  await t.test('opens the session even though nothing ever polls', async () => {
    // startNewStream used to be reachable only from the first successful poll,
    // so without credentials the session stayed forever unopened.
    const state = await server.state();
    assert.notEqual(state.streamStartedAt, null);
  });

  await t.test('refreshing plants no error when there is nothing to refresh', async () => {
    const { status, body } = await server.post('/api/refresh');
    assert.equal(status, 200);
    assert.equal(body.error, null);
    assert.equal(body.configured, false);
  });
});

test('reps still come off the target without any subscriber feed', async (t) => {
  // Its own server: this one mutates the count.
  const server = await startBareServer();
  t.after(() => server.stop());

  const before = await server.state();
  const { status, body } = await server.post('/api/done', { amount: 5, source: 'camera' });

  assert.equal(status, 200);
  assert.equal(body.done, 5);
  assert.equal(body.remaining, before.remaining - 5);
  assert.equal(body.error, null);
});
