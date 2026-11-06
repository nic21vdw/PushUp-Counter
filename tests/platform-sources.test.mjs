/**
 * Twitch subs and Kick follows/subs against a local mock of both APIs. No real
 * keys: every base URL points at the mock, and YouTube is blanked so the dev
 * machine's .env and exact-subs feed cannot leak in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
let nextPort = 15211;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, check, ms = 8_000) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() - start > ms) return value;
    await wait(100);
  }
}

function mockPlatforms() {
  const world = {
    twitch: { subs: 50, live: false, fail: false, token: "twitch-token-1" },
    kick: { subs: 7, follows: 300, live: false, fail: false },
    hits: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    world.hits.push(`${req.method} ${url.pathname}`);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/twitch/oauth2/token" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      if (form.get("refresh_token") !== "twitch-refresh")
        return send(400, { message: "Invalid refresh token" });
      world.twitch.token = "twitch-token-2";
      return send(200, { access_token: "twitch-token-2" });
    }
    if (url.pathname.startsWith("/twitch/helix/")) {
      if (req.headers["client-id"] !== "twitch-client")
        return send(401, { message: "Client ID required" });
      if (req.headers.authorization !== `Bearer ${world.twitch.token}`)
        return send(401, { message: "Invalid OAuth token" });
      if (world.twitch.fail)
        return send(503, { message: "Service Unavailable" });
      if (url.pathname === "/twitch/helix/streams") {
        assert.equal(url.searchParams.get("user_id"), "1234");
        return send(200, {
          data: world.twitch.live ? [{ type: "live", user_id: "1234" }] : [],
        });
      }
      if (url.pathname === "/twitch/helix/subscriptions") {
        assert.equal(url.searchParams.get("broadcaster_id"), "1234");
        return send(200, { data: [], total: world.twitch.subs, points: 0 });
      }
    }
    if (url.pathname === "/kick/oauth/token" && req.method === "POST")
      return send(200, { access_token: "kick-app-token", expires_in: 3600 });
    if (url.pathname === "/kick/public/v1/channels") {
      if (req.headers.authorization !== "Bearer kick-app-token")
        return send(401, { message: "Unauthorized" });
      if (world.kick.fail) return send(500, { message: "boom" });
      assert.equal(url.searchParams.get("slug"), "nicv");
      return send(200, {
        data: [
          {
            slug: "nicv",
            active_subscribers_count: world.kick.subs,
            stream: { is_live: world.kick.live },
          },
        ],
        message: "OK",
      });
    }
    if (url.pathname === "/kick/api/v2/channels/nicv")
      return send(200, { followers_count: world.kick.follows });
    send(404, { message: "not mocked" });
  });
  return { world, server };
}

async function startCounter(t, { env = {}, state = null } = {}) {
  const { world, server: mock } = mockPlatforms();
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const m = `http://127.0.0.1:${mock.address().port}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-sources-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify(
      state ?? {
        carriedOver: 0,
        done: 0,
        streamStartedAt: now,
        lastSeenAt: now,
      },
    ),
  );

  const port = nextPort++;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      REQUIRE_ARM: "off",
      YOUTUBE_API_KEY: "",
      YOUTUBE_CHANNEL_ID: "",
      YOUTUBE_HANDLE: "",
      EXACT_SUBS_URL: "off",
      SOURCES_POLL_SECONDS: "1",
      TWITCH_CLIENT_ID: "twitch-client",
      TWITCH_ACCESS_TOKEN: "twitch-token-1",
      TWITCH_BROADCASTER_ID: "1234",
      TWITCH_CLIENT_SECRET: "",
      TWITCH_REFRESH_TOKEN: "",
      TWITCH_API_BASE: `${m}/twitch/helix`,
      TWITCH_AUTH_BASE: `${m}/twitch/oauth2`,
      KICK_CLIENT_ID: "kick-client",
      KICK_CLIENT_SECRET: "kick-secret",
      KICK_ACCESS_TOKEN: "",
      KICK_CHANNEL: "nicv",
      KICK_BROADCASTER_ID: "",
      KICK_API_BASE: `${m}/kick/public/v1`,
      KICK_AUTH_BASE: `${m}/kick`,
      KICK_FOLLOWERS_API_BASE: `${m}/kick/api/v2`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let banner = "";
  child.stdout.on("data", (c) => (banner += c.toString()));
  child.stderr.on("data", (c) => (banner += c.toString()));
  await until(
    async () => banner,
    (b) => b.includes("Status "),
    15_000,
  );
  await wait(150);

  t.after(async () => {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    mock.close();
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const read = () => fetch(`${base}/api/state`).then((r) => r.json());
  const source = (s, id) => s.sources.find((x) => x.id === id);
  return {
    world,
    banner: () => banner,
    read,
    source,
    async toggle(id, enabled, headers = { "X-Pushup-Control": "1" }) {
      return fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ action: "source", source: id, enabled }),
      });
    },
    async rep(reps) {
      return fetch(`${base}/api/rep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reps }),
      });
    },
    hits: () => world.hits,
  };
}

test("configured sources stay off until switched on, and ask nothing", async (t) => {
  const c = await startCounter(t);
  c.world.twitch.live = true;
  await wait(1500);
  const s = await c.read();
  for (const id of ["twitch-subs", "kick-follows", "kick-subs"]) {
    assert.equal(c.source(s, id).configured, true);
    assert.equal(c.source(s, id).enabled, false);
  }
  assert.equal(s.owed, 0);
  assert.deepEqual(c.hits(), [], "no request to a platform that is off");
});

test("an unconfigured source cannot be switched on", async (t) => {
  const c = await startCounter(t, {
    env: { TWITCH_CLIENT_ID: "", KICK_CHANNEL: "", KICK_CLIENT_ID: "" },
  });
  const s = await c.read();
  assert.equal(c.source(s, "twitch-subs").configured, false);
  assert.equal(c.source(s, "kick-subs").configured, false);
  const res = await c.toggle("twitch-subs", true);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not set up/);
  assert.doesNotMatch(c.banner(), /Twitch \/ Kick/);
});

test("the switch needs the control panel's header", async (t) => {
  const c = await startCounter(t);
  const res = await c.toggle("twitch-subs", true, {});
  assert.equal(res.status, 403);
  assert.equal(c.source(await c.read(), "twitch-subs").enabled, false);
});

test("Twitch subs add push-ups only while live", async (t) => {
  const c = await startCounter(t);
  c.world.twitch.live = true;
  c.world.twitch.subs = 50;
  assert.equal((await c.toggle("twitch-subs", true)).status, 200);

  let s = await until(c.read, (v) => c.source(v, "twitch-subs").count === 50);
  assert.equal(c.source(s, "twitch-subs").baseline, 50);
  assert.equal(s.owed, 0, "switching on mid-stream adds nothing by itself");

  c.world.twitch.subs = 53;
  s = await until(c.read, (v) => v.owed === 3);
  assert.equal(s.owed, 3);
  assert.equal(s.left, 3);
  assert.equal(s.fromSources, 3);

  c.world.twitch.live = false;
  c.world.twitch.subs = 60;
  s = await until(c.read, (v) => c.source(v, "twitch-subs").count === 60);
  assert.equal(c.source(s, "twitch-subs").live, false);
  assert.equal(s.owed, 3, "subs after the stream ended are free");

  c.world.twitch.live = true;
  s = await until(c.read, (v) => c.source(v, "twitch-subs").live);
  c.world.twitch.subs = 62;
  s = await until(c.read, (v) => v.owed === 5);
  assert.equal(s.owed, 5);

  await c.rep(2);
  s = await c.read();
  assert.equal(s.left, 3, "push-ups come off the same total");
});

test("a failing source does not move the count", async (t) => {
  const c = await startCounter(t);
  c.world.twitch.live = true;
  await c.toggle("twitch-subs", true);
  await until(c.read, (v) => c.source(v, "twitch-subs").count === 50);
  c.world.twitch.subs = 52;
  await until(c.read, (v) => v.owed === 2);

  c.world.twitch.fail = true;
  c.world.twitch.subs = 90;
  let s = await until(c.read, (v) => c.source(v, "twitch-subs").error);
  assert.match(c.source(s, "twitch-subs").error, /503/);
  assert.equal(s.owed, 2);
  assert.equal(c.source(s, "twitch-subs").count, 52);
  assert.equal(s.error, null, "the YouTube line is not the place for it");

  c.world.twitch.fail = false;
  c.world.twitch.subs = 53;
  s = await until(c.read, (v) => c.source(v, "twitch-subs").count === 53);
  assert.equal(c.source(s, "twitch-subs").error, null);
  assert.equal(s.owed, 3);
});

test("an expired Twitch token is refreshed and the reading goes on", async (t) => {
  const c = await startCounter(t, {
    env: {
      TWITCH_ACCESS_TOKEN: "stale",
      TWITCH_REFRESH_TOKEN: "twitch-refresh",
      TWITCH_CLIENT_SECRET: "twitch-secret",
    },
  });
  c.world.twitch.live = true;
  await c.toggle("twitch-subs", true);
  const s = await until(c.read, (v) => c.source(v, "twitch-subs").count === 50);
  assert.equal(c.source(s, "twitch-subs").error, null);
  assert.ok(c.hits().includes("POST /twitch/oauth2/token"));
  const text = JSON.stringify(s);
  for (const secret of [
    "stale",
    "twitch-token-2",
    "twitch-secret",
    "kick-secret",
  ])
    assert.ok(!text.includes(secret), `${secret} must never reach a page`);
});

test("Kick follows and subs each add their own push-ups", async (t) => {
  const c = await startCounter(t, {
    env: { PUSHUPS_PER_KICK_SUB: "5" },
  });
  c.world.kick.live = true;
  await c.toggle("kick-follows", true);
  await c.toggle("kick-subs", true);
  await until(
    c.read,
    (v) =>
      c.source(v, "kick-follows").count === 300 &&
      c.source(v, "kick-subs").count === 7,
  );
  c.world.kick.follows = 304;
  c.world.kick.subs = 8;
  const s = await until(c.read, (v) => v.owed === 9);
  assert.equal(c.source(s, "kick-follows").owed, 4);
  assert.equal(c.source(s, "kick-subs").owed, 5);
  assert.equal(s.owed, 9);
  assert.ok(c.hits().includes("POST /kick/oauth/token"));
});

test("switching off keeps what was owed and stops adding", async (t) => {
  const c = await startCounter(t);
  c.world.kick.live = true;
  await c.toggle("kick-subs", true);
  await until(c.read, (v) => c.source(v, "kick-subs").count === 7);
  c.world.kick.subs = 9;
  await until(c.read, (v) => v.owed === 2);
  await c.toggle("kick-subs", false);
  c.world.kick.subs = 20;
  await wait(1500);
  const s = await c.read();
  assert.equal(s.owed, 2);
  assert.equal(c.source(s, "kick-subs").enabled, false);
});

test("Kick going down leaves the count where it was", async (t) => {
  const c = await startCounter(t);
  c.world.kick.live = true;
  await c.toggle("kick-follows", true);
  await until(c.read, (v) => c.source(v, "kick-follows").count === 300);
  c.world.kick.fail = true;
  c.world.kick.follows = 999;
  const s = await until(c.read, (v) => c.source(v, "kick-follows").error);
  assert.match(c.source(s, "kick-follows").error, /Kick API 500/);
  assert.equal(s.owed, 0);
});

test("a restart keeps a source's switch and what it gained", async (t) => {
  const now = new Date().toISOString();
  const c = await startCounter(t, {
    state: {
      carriedOver: 0,
      done: 0,
      streamStartedAt: now,
      lastSeenAt: now,
      sources: {
        "twitch-subs": {
          enabled: true,
          count: 50,
          baseline: 48,
          banked: 1,
          live: true,
        },
      },
    },
  });
  c.world.twitch.live = true;
  c.world.twitch.subs = 50;
  const s = await until(c.read, (v) => c.source(v, "twitch-subs").updatedAt);
  assert.equal(c.source(s, "twitch-subs").enabled, true);
  assert.equal(s.owed, 3);
});
