/**
 * The OBS tracker source and the camera page can both count reps. If both do it
 * at once every push-up is counted twice, so the server reports which page most
 * recently counted and the pages surface it. These tests cover that signal, and
 * the CounterClient contract that feeds it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CounterClient } from '../public/js/counter-client.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let nextPort = 14831;

async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-count-'));
  await fs.copyFile(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  await fs.symlink(path.join(ROOT, 'public'), path.join(dir, 'public'), 'dir');

  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
    child.stdout.on('data', (c) => {
      if (c.toString().includes('Control page')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async done(body) {
      const res = await fetch(`${base}/api/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    async state() {
      return (await fetch(`${base}/api/state`)).json();
    },
    async stop() {
      child.kill('SIGKILL');
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('the server reports which page is counting', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  assert.equal((await server.state()).countingClientId, null, 'nobody counting yet');

  await server.done({ amount: 1, source: 'camera', clientId: 'tracker-abc' });
  assert.equal((await server.state()).countingClientId, 'tracker-abc');
});

test('the most recent counter wins, so a page can see it has been taken over', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.done({ amount: 1, source: 'camera', clientId: 'camera-one' });
  await server.done({ amount: 1, source: 'camera', clientId: 'tracker-two' });

  assert.equal((await server.state()).countingClientId, 'tracker-two');
});

test('tapping a button on the control page is not a camera claiming the count', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.done({ amount: 1, source: 'camera', clientId: 'tracker-abc' });
  await server.done({ amount: 25 });

  assert.equal(
    (await server.state()).countingClientId,
    'tracker-abc',
    'a manual set must not clear the camera that is counting',
  );
});

test('reps still count when a page sends no id at all', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const body = await server.done({ amount: 3, source: 'camera' });
  assert.equal(body.done, 3, 'the advisory must never gate the actual count');
  assert.equal((await server.state()).countingClientId, null);
});

test('a hostile client id is bounded and a non-string ignored', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await server.done({ amount: 1, source: 'camera', clientId: 'x'.repeat(500) });
  assert.equal((await server.state()).countingClientId.length, 64);

  await server.done({ amount: 1, source: 'camera', clientId: { evil: true } });
  assert.equal(
    (await server.state()).countingClientId.length,
    64,
    'a non-string id is ignored rather than replacing the holder',
  );
});

/* ------------------------------------------------------- CounterClient wiring */

/** Captures what CounterClient sends, without a network. */
function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

test('CounterClient tags every rep with its source and id', async () => {
  const sent = [];
  await withStubbedFetch(
    async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ done: 1 }) };
    },
    async () => {
      const client = new CounterClient({ clientId: 'tracker-xyz' });
      client.reportReps(1);
      await new Promise((r) => setTimeout(r, 10));
      client.stop();
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/done');
  assert.deepEqual(sent[0].body, { amount: 1, source: 'camera', clientId: 'tracker-xyz' });
});

test('reps counted while the server is down are held, not dropped', async () => {
  let attempts = 0;
  await withStubbedFetch(
    async () => {
      attempts++;
      throw new Error('connection refused');
    },
    async () => {
      const client = new CounterClient({ clientId: 'tracker-xyz' });
      client.reportReps(1);
      client.reportReps(1);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(client.pending, 2, 'both reps still owed');
      assert.ok(attempts >= 1);
      client.stop();
    },
  );
});

test('stopping a client abandons its retries instead of looping forever', async () => {
  let attempts = 0;
  await withStubbedFetch(
    async () => {
      attempts++;
      throw new Error('connection refused');
    },
    async () => {
      const client = new CounterClient({});
      client.reportReps(1);
      await new Promise((r) => setTimeout(r, 20));
      const afterFirst = attempts;
      client.stop();
      // Well past the 2s retry interval: a stopped client must stay quiet.
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(attempts, afterFirst, 'no further attempts after stop()');
      assert.equal(client.retryTimer, null);
    },
  );
});
