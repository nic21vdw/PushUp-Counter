/**
 * Sets, corrections, streaks, goals and the boss over real HTTP, against a
 * throwaway server in a temp folder. The live state.json is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
let nextPort = 15731;

async function boot(dir, port, env) {
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
      ...env,
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
  return child;
}

async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-session-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  const port = nextPort++;
  let child = await boot(dir, port, env);
  const base = `http://127.0.0.1:${port}`;
  const send = async (endpoint, body, headers = {}) => {
    const res = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const kill = async () => {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  return {
    rep: (body = {}) => send("/api/rep", body),
    control: (action, body = {}, headers = { "X-Pushup-Control": "1" }) =>
      send("/api/control", { action, ...body }, headers),
    state: async () => (await fetch(`${base}/api/state`)).json(),
    async restart() {
      await kill();
      child = await boot(dir, port, env);
    },
    async stop() {
      await kill();
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    },
  };
}

test("the camera counts nothing until a set is started", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const refused = await s.rep({ ids: ["a"], reps: 1 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.notArmed, true);
  assert.equal((await s.state()).done, 0);

  await s.control("start");
  const ok = await s.rep({ ids: ["b"], reps: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.done, 1);
  assert.equal(ok.body.session.phase, "active");
  assert.equal(ok.body.session.setReps, 1);
});

test("a retried rep id is banked once, across a restart too", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("start");

  await s.rep({ ids: ["r1", "r2"], reps: 2 });
  const again = await s.rep({ ids: ["r1", "r2"], reps: 2 });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicates, 2);
  assert.equal(again.body.done, 2);

  await s.restart();
  const replay = await s.rep({ ids: ["r2", "r3"], reps: 2 });
  assert.equal(replay.body.done, 3);
});

test("rest freezes counting and the streak; resume picks both back up", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("start");
  await s.rep({ ids: ["1"], reps: 1 });
  await s.rep({ ids: ["2"], reps: 1 });
  await s.control("rest");

  await new Promise((r) => setTimeout(r, 1700));
  const during = await s.rep({ ids: ["3"], reps: 1 });
  assert.equal(during.status, 400, "a rep while resting is not counted");

  await s.control("resume");
  const after = await s.rep({ ids: ["4"], reps: 1 });
  assert.equal(after.body.done, 3);
  assert.equal(
    after.body.session.streak,
    3,
    "resting did not break the streak",
  );
  assert.equal(after.body.session.setBest, 3);
});

test("corrections, undo and boss health agree with the count", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("goal", { goal: 5 });
  await s.control("start");
  await s.rep({ ids: ["1", "2", "3"], reps: 3 });

  let v = (await s.control("chat")).body;
  assert.equal(v.done, 4);
  assert.equal(v.session.boss.hp, 1);
  assert.equal(v.session.events.at(-1).kind, "chat-correction");

  v = (await s.control("undo")).body;
  assert.equal(v.done, 3);
  assert.equal(v.session.boss.hp, 2);
  assert.equal(v.session.setReps, 3);

  v = (await s.control("minus")).body;
  assert.equal(v.done, 2);
  v = (await s.control("plus")).body;
  assert.equal(v.done, 3);
  assert.equal(v.session.boss.maxHp, 5);
  assert.equal(v.session.boss.hp, v.session.target - v.done);
});

test("reaching the goal celebrates once, and not again after an undo, a re-cross or a restart", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("goal", { goal: 3 });
  await s.control("milestones", {
    milestones: [{ at: 2, label: "Halfway-ish" }],
  });
  await s.control("start");
  await s.rep({ ids: ["1", "2", "3"], reps: 3 });

  const first = (await s.state()).session;
  assert.equal(first.complete, true);
  assert.deepEqual(
    first.celebrations.map((c) => c.kind),
    ["milestone", "boss"],
  );
  assert.equal(first.boss.stage, "Defeated");

  await s.control("undo");
  await s.rep({ ids: ["4"], reps: 1 });
  await s.restart();
  const later = (await s.state()).session;
  assert.equal(later.celebrations.length, 2);
  assert.equal(later.celebrations.at(-1).id, first.celebrations.at(-1).id);
});

test("editing the goal keeps every rep already done", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("goal", { goal: 10 });
  await s.control("start");
  await s.rep({ ids: ["1", "2", "3", "4"], reps: 4 });
  const v = (await s.control("goal", { goal: 40 })).body;
  assert.equal(v.done, 4);
  assert.equal(v.session.target, 40);
  assert.equal(v.session.boss.hp, 36);
  const bad = await s.control("goal", { goal: -3 });
  assert.equal(bad.status, 400);
});

test("a set reset needs typing and can be taken back", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("start");
  await s.rep({ ids: ["1", "2", "3"], reps: 3 });

  assert.equal((await s.control("reset-set")).status, 400);
  let v = (await s.control("reset-set", { confirm: "RESET SET" })).body;
  assert.equal(v.done, 0);
  assert.equal(v.session.canUndoReset, true);
  v = (await s.control("undo-reset")).body;
  assert.equal(v.done, 3);
  assert.equal(v.session.setReps, 3);
});

test("a stream reset can be undone while nothing has been counted since", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("start");
  await s.rep({ ids: ["1", "2"], reps: 2 });
  let v = (await s.control("reset-stream", { confirm: "RESET STREAM" })).body;
  assert.equal(v.done, 0);
  assert.equal(v.session.setNumber, 0);
  v = (await s.control("undo-reset")).body;
  assert.equal(v.done, 2);
  assert.equal(v.session.setNumber, 1);
});

test("control requests need the panel's header and a local origin", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  assert.equal((await s.control("plus", {}, {})).status, 403);
  assert.equal(
    (
      await s.control(
        "plus",
        {},
        {
          "X-Pushup-Control": "1",
          Origin: "https://evil.example",
        },
      )
    ).status,
    403,
  );
  assert.equal((await s.state()).done, 0);
});

test("cutting away from the scene pauses an active set but never starts one", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  let v = (await s.control("scene-away")).body;
  assert.equal(v.session.phase, "ready");
  await s.control("start");
  v = (await s.control("scene-away")).body;
  assert.equal(v.session.phase, "rest");
  assert.equal(v.session.pausedBy, "scene");
});

test("a streak breaks only when the next rep comes later than the streak gap", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.control("settings", { streakGapMs: 2000 });
  await s.control("start");
  await s.rep({ ids: ["1"], reps: 1 });
  await s.rep({ ids: ["2"], reps: 1 });
  await new Promise((r) => setTimeout(r, 2300));
  const v = (await s.rep({ ids: ["3"], reps: 1 })).body;
  assert.equal(v.session.streak, 1);
  assert.equal(v.session.setBest, 2);
  assert.equal(v.session.sessionBest, 2);
});
