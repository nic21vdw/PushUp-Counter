/**
 * The per-stream log and the recap built from it: the pure fold, and the log
 * over real HTTP against a throwaway server in a temp folder. The live
 * state.json is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStreamLog,
  buildRecap,
  listStreams,
} from "../public/js/stream-recap.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
let nextPort = 16131;

const S1 = "2026-11-05T18:00:00.000Z";
const at = (min) => new Date(Date.parse(S1) + min * 60_000).toISOString();
const ev = (min, kind, delta, set, done, extra = {}) => ({
  v: 1,
  stream: S1,
  at: at(min),
  type: "event",
  kind,
  delta,
  set,
  done,
  ...extra,
});

const FIXTURE = [
  {
    v: 1,
    stream: S1,
    at: S1,
    type: "start",
    carriedOver: 12,
    subsEnabled: true,
  },
  ev(1, "set-start", 0, 1, 0),
  ev(2, "camera", 10, 1, 10, { best: 10 }),
  ev(3, "chat-correction", 1, 1, 11, { best: 11 }),
  ev(4, "set-finish", 0, 1, 11, { setReps: 11 }),
  ev(70, "set-start", 0, 2, 11),
  ev(71, "camera", 20, 2, 31, { best: 20 }),
  ev(72, "undo", -1, 2, 30),
  ev(73, "manual-plus", 1, 2, 31),
  {
    v: 1,
    stream: S1,
    at: at(30),
    type: "subs",
    subs: 105,
    delta: 5,
    gained: 5,
    exact: true,
    names: [],
  },
  {
    v: 1,
    stream: S1,
    at: at(80),
    type: "subs",
    subs: 107,
    delta: 2,
    gained: 7,
    exact: true,
    names: [],
  },
  {
    v: 1,
    stream: S1,
    at: at(81),
    type: "subs",
    subs: 207,
    delta: 100,
    gained: 7,
    exact: false,
    switched: true,
    names: [],
  },
];

test("a recap totals the stream, finds the best set and buckets reps by hour", () => {
  const recap = buildRecap(FIXTURE, S1);
  assert.equal(recap.total, 31);
  assert.equal(recap.setCount, 2);
  assert.deepEqual(
    recap.sets.map((s) => [s.set, s.reps]),
    [
      [1, 11],
      [2, 20],
    ],
  );
  assert.equal(recap.bestSet.set, 2);
  assert.equal(recap.bestStreak, 20);
  assert.deepEqual(
    recap.perHour.map((h) => h.reps),
    [11, 20],
  );
  assert.equal(recap.corrections["chat-correction"], 1);
  assert.equal(recap.corrections.undo, 1);
  assert.equal(recap.corrections["manual-plus"], 1);
  assert.equal(recap.subsGained, 7);
  assert.deepEqual(
    recap.subBursts.map((b) => b.delta),
    [5, 2],
    "a source switch is not a burst of subscribers",
  );
  assert.equal(recap.carriedOver, 12);
});

test("without subscriber names the recap says so instead of inventing any", () => {
  const recap = buildRecap(FIXTURE, S1);
  assert.equal(recap.contributors.available, false);
  assert.deepEqual(recap.contributors.names, []);
  assert.deepEqual(
    recap.sources.map((s) => [s.kind, s.reps]),
    [
      ["camera", 30],
      ["chat-correction", 1],
      ["manual-plus", 1],
    ],
  );

  const named = [
    ...FIXTURE,
    {
      v: 1,
      stream: S1,
      at: at(90),
      type: "subs",
      subs: 208,
      delta: 1,
      gained: 8,
      names: ["ada", "bo"],
    },
    {
      v: 1,
      stream: S1,
      at: at(91),
      type: "subs",
      subs: 209,
      delta: 1,
      gained: 9,
      names: ["ada"],
    },
  ];
  const withNames = buildRecap(named, S1);
  assert.equal(withNames.contributors.available, true);
  assert.deepEqual(withNames.contributors.names[0], { name: "ada", subs: 2 });
});

test("a torn last line is skipped and discarded streams leave the list", () => {
  const S2 = "2026-11-06T18:00:00.000Z";
  const text =
    FIXTURE.map((r) => JSON.stringify(r)).join("\n") +
    `\n${JSON.stringify({ v: 1, stream: S2, at: S2, type: "start" })}` +
    `\n${JSON.stringify({ v: 1, stream: S2, at: S2, type: "discard" })}` +
    '\n{"v":1,"stream":"2026-11-0';
  const records = parseStreamLog(text);
  assert.equal(records.length, FIXTURE.length + 2);
  const list = listStreams(records);
  assert.deepEqual(
    list.map((s) => s.id),
    [S1],
  );
  assert.equal(list[0].total, 31);
  assert.equal(list[0].bestSet, 20);
});

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-recap-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  const port = nextPort++;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      EXACT_SUBS_URL: "off",
      YOUTUBE_API_KEY: "",
      YOUTUBE_CHANNEL_ID: "",
      YOUTUBE_HANDLE: "",
      NEW_STREAM_AFTER_HOURS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start")),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("OBS source")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (endpoint, body, headers = {}) =>
    fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  return {
    dir,
    base,
    rep: (ids) => post("/api/rep", { ids, reps: ids.length }),
    control: (action, body = {}) =>
      post("/api/control", { action, ...body }, { "X-Pushup-Control": "1" }),
    get: (endpoint) =>
      fetch(`${base}${endpoint}`).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      })),
    async stop() {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    },
  };
}

test("reps, sets and corrections land in the stream log and come back as a recap", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await s.rep(["a", "b", "c"]);
  await s.rep(["d"]);
  await s.control("chat");
  await s.control("finish");
  await s.rep(["e", "f"]);
  await s.control("undo");

  const { status, body } = await s.get("/api/streams/recap");
  assert.equal(status, 200);
  const { recap } = body;
  assert.equal(recap.live, true);
  assert.equal(recap.total, 6);
  assert.deepEqual(
    recap.sets.map((set) => [set.set, set.reps]),
    [
      [1, 5],
      [2, 1],
    ],
  );
  assert.equal(recap.bestSet.reps, 5);
  assert.equal(recap.corrections["chat-correction"], 1);
  assert.equal(recap.corrections.undo, 1);
  assert.equal(recap.subsEnabled, false);

  const list = await s.get("/api/streams");
  assert.equal(list.body.streams.length, 1);
  assert.equal(list.body.streams[0].current, true);
  assert.equal(list.body.streams[0].id, recap.id);

  const log = await fs.readFile(path.join(s.dir, "stream-log.jsonl"), "utf8");
  const lines = log
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "start");
  assert.ok(lines.every((l) => l.stream === recap.id && l.v === 1));

  const saved = JSON.parse(
    await fs.readFile(path.join(s.dir, "state.json"), "utf8"),
  );
  assert.equal(saved.done, 6);
  assert.equal("streamLog" in saved, false, "state.json carries no log");
});

test("a stream reset that is taken back leaves no phantom stream in the list", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.rep(["a"]);
  await s.control("reset-stream", { confirm: "RESET STREAM" });
  await s.control("undo-reset");
  await s.rep(["b"]);

  const list = await s.get("/api/streams");
  assert.equal(list.body.streams.length, 1);
  const { body } = await s.get(
    `/api/streams/recap?id=${encodeURIComponent(list.body.streams[0].id)}`,
  );
  assert.equal(body.recap.total, 2);
});

test("an unknown stream is a 404 and the recap page is served", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const missing = await s.get("/api/streams/recap?id=nope");
  assert.equal(missing.status, 404);
  const page = await fetch(`${s.base}/recap.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /drawRecapCard/);
});
