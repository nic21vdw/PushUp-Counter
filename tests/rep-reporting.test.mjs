/**
 * CounterClient: the only thing that ever moves the count.
 *
 * It has to be stubborn about delivery — a rep dropped because the server
 * blipped is a push-up you did and did not get credit for — and it has to be
 * incapable of reporting anything other than push-ups that actually happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { CounterClient } from '../public/js/counter-client.js';

/**
 * The client talks to `/api/rep` with `fetch` and subscribes with EventSource.
 * Only fetch matters here, so stand up a real server and point a fetch stub at
 * it — that keeps the request/response contract honest without a browser.
 * `connect()` is never called, so the missing EventSource is not a problem.
 */
async function withServer(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ url: req.url, method: req.method, body });
    handler(req, res, body, requests.length);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(`${base}${url}`, init);
  try {
    await run(requests);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('a detected rep is posted to /api/rep with the page id', async () => {
  await withServer(
    (req, res) => json(res, 200, { left: 41, rawLeft: 41, done: 1, owed: 42 }),
    async (requests) => {
      const client = new CounterClient({ clientId: 'overlay-abc' });
      client.reportReps(1);
      await settle();

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/api/rep');
      assert.equal(requests[0].method, 'POST');
      assert.deepEqual(requests[0].body, { reps: 1, clientId: 'overlay-abc' });
      client.stop();
    },
  );
});

test('it refuses to report anything that is not a whole push-up', async () => {
  await withServer(
    (req, res) => json(res, 200, {}),
    async (requests) => {
      const client = new CounterClient({ clientId: 'overlay-abc' });

      // There is no miscount button any more, and no way to build one from here.
      // (A bare reportReps() means one rep, so `undefined` is not in this list.)
      for (const bogus of [-1, 0, 1.5, NaN, 'two', null]) {
        client.reportReps(bogus);
      }
      await settle();

      assert.equal(requests.length, 0, 'nothing should have been sent');
      assert.equal(client.pending, 0);
      client.stop();
    },
  );
});

test('reps counted while the server is down are held, not dropped', async () => {
  let failing = true;
  let banked = 0;

  await withServer(
    (req, res, body) => {
      if (failing) {
        res.writeHead(503).end();
        return;
      }
      banked += body.reps;
      json(res, 200, { left: 38, rawLeft: 38, done: banked });
    },
    async () => {
      const pending = [];
      const client = new CounterClient({
        clientId: 'overlay-abc',
        onPending: (n) => pending.push(n),
      });

      client.reportReps(1);
      await settle();
      assert.equal(client.pending, 1, 'the rep is still owed to the server');

      // Three more land while it is still down.
      client.reportReps(1);
      client.reportReps(1);
      client.reportReps(1);
      await settle();

      assert.equal(banked, 0, 'nothing banked while the server is unreachable');
      assert.equal(client.pending, 4, 'four push-ups are being held');

      failing = false;
      // Wait past the 2s retry.
      await new Promise((resolve) => setTimeout(resolve, 2600));

      assert.equal(client.pending, 0, 'everything was delivered once the server came back');
      assert.equal(banked, 4, 'all four push-ups — none lost, none double-counted');
      assert.ok(pending.includes(4), 'the page could show the backlog while it waited');
      client.stop();
    },
  );
});

test('a rejected report is dropped rather than retried forever', async () => {
  await withServer(
    (req, res) => json(res, 400, { error: 'reps must be a whole number between 1 and 50' }),
    async (requests) => {
      const errors = [];
      const client = new CounterClient({ clientId: 'overlay-abc', onError: (m) => errors.push(m) });

      client.reportReps(1);
      await new Promise((resolve) => setTimeout(resolve, 400));

      assert.equal(client.pending, 0, 'a 400 will never succeed on retry');
      assert.equal(requests.length, 1, 'so it is not retried');
      assert.match(errors.at(-1), /whole number/);
      client.stop();
    },
  );
});

test('stopping a client abandons its retries instead of looping forever', async () => {
  await withServer(
    (req, res) => res.writeHead(503).end(),
    async (requests) => {
      const client = new CounterClient({ clientId: 'overlay-abc' });
      client.reportReps(1);
      await settle();

      const sentBeforeStop = requests.length;
      client.stop();

      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(requests.length, sentBeforeStop, 'no further attempts after stop()');
    },
  );
});

test('there is no token to send, so a source cannot be locked out', async () => {
  await withServer(
    (req, res) => json(res, 200, { left: 10 }),
    async (requests) => {
      const client = new CounterClient({ clientId: 'overlay-abc' });
      client.reportReps(1);
      await settle();

      assert.equal(
        requests[0].body.token,
        undefined,
        'nothing token-shaped is sent, and nothing is required',
      );
      client.stop();
    },
  );
});
