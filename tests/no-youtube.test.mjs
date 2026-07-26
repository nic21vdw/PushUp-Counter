/**
 * Running with no YouTube key at all.
 *
 * Counting push-ups does not need a Google Cloud project, and a setup that
 * deliberately skips it should not spend the whole stream showing an error
 * about a key it never wanted. These cover that it stays quiet, that the
 * session still opens, and that restarting does not eat your progress.
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

// Each test file needs its own port range: `node --test` runs files at once.
let nextPort = 15031;

// A 'dir' symlink on Windows needs Developer Mode or an elevated shell, so the
// whole suite fails with EPERM on a stock machine. A junction is the same thing
// for our purposes and needs neither.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Boot the server in a throwaway cwd. `dir` is returned so a test can stop the
 * server and start another one over the same state.json — which is what a
 * restart actually is.
 */
async function startServer({ dir = null, env = {} } = {}) {
  const cwd = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pushup-nokey-')));
  if (!dir) {
    await fs.copyFile(path.join(ROOT, 'server.js'), path.join(cwd, 'server.js'));
    await fs.symlink(path.join(ROOT, 'public'), path.join(cwd, 'public'), LINK_TYPE);
  }

  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Explicitly blank, so a .env on the dev machine cannot leak in.
      YOUTUBE_API_KEY: '',
      YOUTUBE_CHANNEL_ID: '',
      YOUTUBE_HANDLE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let banner = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
    child.stdout.on('data', (chunk) => {
      banner += chunk.toString();
      if (banner.includes('Status ')) {
        clearTimeout(timer);
        // Let the rest of the banner arrive before anyone reads it.
        setTimeout(resolve, 120);
      }
    });
    child.on('error', reject);
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    dir: cwd,
    banner: () => banner,
    async rep(reps = 1) {
      return fetch(`${base}/api/rep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reps }),
      });
    },
    async state() {
      return (await fetch(`${base}/api/state`)).json();
    },
    async stop({ keepDir = false } = {}) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      if (!keepDir) {
        await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  };
}

test('with no key there is no error to display', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const state = await server.state();
  assert.equal(state.error, null, 'a deliberate choice must not look like a fault');
  assert.equal(state.subsEnabled, false);
  assert.equal(state.subs, null);
});

test('the banner presents it as a mode rather than a missing key', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const banner = server.banner();
  assert.match(banner, /Subscribers: off/);
  assert.match(banner, /YOUTUBE_API_KEY/, 'still says how to turn it on');
  assert.doesNotMatch(banner, /!\s*YOUTUBE_API_KEY is missing/, 'but not as a warning');
});

test('the stream session opens without a successful poll', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const state = await server.state();
  assert.notEqual(
    state.streamStartedAt,
    null,
    'the session used to wait forever for a poll that never came',
  );
});

test('push-ups still count, and still come off the total', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const before = await server.state();
  await server.rep(4);
  const after = await server.state();

  assert.equal(after.done, before.done + 4);
  assert.equal(after.rawLeft, before.rawLeft - 4);
});

test('a restart does not reset what you still owe', async (t) => {
  // Without a key there is never a baseline sub count, and "no baseline" used
  // to mean "start a new stream" — so every restart wiped the session.
  const first = await startServer();
  const dir = first.dir;

  // Owe 40, do 15 of them, and have been seen a moment ago — so this reads as
  // a crash mid-session, not as coming back the next day.
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({ carriedOver: 40, done: 15, streamStartedAt: now, lastSeenAt: now }),
  );
  await first.stop({ keepDir: true });

  const second = await startServer({ dir });
  t.after(() => second.stop());

  const state = await second.state();
  assert.equal(state.left, 25, 'still owes 25 after a restart');
  assert.equal(state.done, 15, 'and remembers the 15 already done this session');
});

test('turning the key on later switches the mode back', async (t) => {
  const server = await startServer({
    env: { YOUTUBE_API_KEY: 'not-a-real-key', YOUTUBE_CHANNEL_ID: 'UCtest' },
  });
  t.after(() => server.stop());

  assert.equal((await server.state()).subsEnabled, true, 'both halves present means it polls');

  // The key is junk, so an error here is correct — that is a real fault, and
  // the point is that it only appears once something was actually asked for.
  // The first poll is in flight when the banner prints, so wait for it.
  let error = null;
  for (let attempt = 0; attempt < 40 && error === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    error = (await server.state()).error;
  }
  assert.notEqual(error, null, 'a bad key should be reported');
});

test('half a configuration is not a configuration', async (t) => {
  // A key with no channel cannot ask YouTube anything, so it stays off rather
  // than erroring once every poll for the rest of the stream.
  const server = await startServer({ env: { YOUTUBE_API_KEY: 'key-but-no-channel' } });
  t.after(() => server.stop());

  const state = await server.state();
  assert.equal(state.subsEnabled, false);
  assert.equal(state.error, null);
});
