import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 15081;
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(read, check, ms = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() - start > ms) return value;
    await wait(150);
  }
}

test("the exact Studio count adds one push-up per subscriber, live", async (t) => {
  let exact = { count: 2707, exact: true };
  const feed = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(exact));
  });
  await new Promise((resolve) => feed.listen(0, "127.0.0.1", resolve));
  t.after(() => feed.close());

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-exact-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      carriedOver: 0,
      baselineSubs: 2690,
      done: 0,
      subs: 2700,
      streamStartedAt: now,
      lastSeenAt: now,
    }),
  );

  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      YOUTUBE_API_KEY: "unused-while-exact",
      YOUTUBE_CHANNEL_ID: "UCFAKE",
      EXACT_SUBS_URL: `http://127.0.0.1:${feed.address().port}/subs`,
      EXACT_POLL_SECONDS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (c) => output.push(c.toString()));
  child.stderr.on("data", (c) => output.push(c.toString()));
  t.after(() => child.kill());

  const read = () =>
    fetch(`http://127.0.0.1:${PORT}/api/state`)
      .then((r) => r.json())
      .catch(() => null);

  const switched = await until(read, (s) => s?.subs === 2707);
  assert.equal(switched.subs, 2707, output.join(""));
  assert.equal(switched.subsExact, true);
  assert.equal(
    switched.owed,
    10,
    "moving from the rounded count to the exact one adds no push-ups",
  );
  assert.equal(switched.baselineSubs, 2697);

  exact = { count: 2708, exact: true };
  const gained = await until(read, (s) => s?.subs === 2708, 5_000);
  assert.equal(gained.owed, 11, "one new subscriber is one more push-up");

  exact = { count: 2710, exact: true };
  const two = await until(read, (s) => s?.subs === 2710, 5_000);
  assert.equal(two.owed, 13);

  exact = { count: 2700, exact: false };
  await wait(2_500);
  const held = await read();
  assert.equal(
    held.subs,
    2710,
    "a dropped exact feed holds the last exact count",
  );
  assert.equal(held.owed, 13);

  exact = { count: 2712, exact: true };
  const back = await until(read, (s) => s?.subs === 2712, 5_000);
  assert.equal(
    back.owed,
    15,
    "subscribers gained while the feed was down still add push-ups",
  );
  assert.ok(
    !/googleapis/.test(output.join("")),
    "the API is not called while exact",
  );
});
