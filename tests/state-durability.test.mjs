/**
 * Keeping the count, and putting it back when it goes.
 *
 * Push-ups already done cannot be recreated: there is no upstream copy, and
 * nobody is going to do them twice. So the count gets a backup, a journal of
 * every change, and a door to set it by hand from this machine — the last of
 * which exists because the alternative, mid-stream, is stopping the server and
 * editing a file by hand while the overlay sits there showing the wrong number.
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

let nextPort = 15931;

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

/** A throwaway copy of the server, so the real count is never in reach. */
async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-state-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  return dir;
}

async function startServer(dir, env = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start: ${output.join("")}`)),
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
  return {
    base,
    output,
    async post(endpoint, body, headers = {}) {
      const res = await fetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async get(endpoint) {
      return (await fetch(`${base}${endpoint}`)).json();
    },
    async stop() {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}

async function cleanup(dir) {
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

async function token(dir) {
  return (await fs.readFile(path.join(dir, ".admin-token"), "utf8")).trim();
}

async function journal(dir) {
  const raw = await fs.readFile(path.join(dir, "state-history.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("every push-up that lands is written down, with what moved the count", async (t) => {
  const dir = await makeDir();
  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  await server.post("/api/rep", { reps: 3 });
  await server.post("/api/rep", { reps: 1 });

  const entries = await journal(dir);
  const reps = entries.filter((e) => e.reason?.includes("counted"));
  assert.equal(reps.length, 2);
  assert.equal(reps[0].done, 3);
  assert.equal(
    reps[1].done,
    4,
    "the journal follows the running total, not the delta",
  );
  assert.ok(
    Date.parse(reps[1].at),
    "every line is timestamped, or it answers nothing",
  );
});

test("the journal is what a page reads back, newest last", async (t) => {
  const dir = await makeDir();
  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  await server.post("/api/rep", { reps: 2 });
  const { entries } = await server.get("/api/history?limit=5");

  assert.ok(entries.length >= 1);
  assert.equal(entries.at(-1).done, 2);
});

test("a count that cannot be read comes back from the backup, loudly", async (t) => {
  const dir = await makeDir();
  const first = await startServer(dir);
  await first.post("/api/rep", { reps: 7 });
  await first.stop();

  // Two saves, so the backup holds a real count rather than an empty start.
  const second = await startServer(dir);
  await second.post("/api/rep", { reps: 1 });
  await second.stop();

  await fs.writeFile(path.join(dir, "state.json"), "{ this is not json");

  const third = await startServer(dir);
  t.after(async () => {
    await third.stop();
    await cleanup(dir);
  });

  const state = await third.get("/api/state");
  assert.equal(
    state.done,
    7,
    "the backup is one save behind, which beats starting from zero",
  );
  assert.match(
    state.warning ?? "",
    /backup/i,
    "and the pages say so rather than showing it silently",
  );
});

test("a count emptied by a power cut comes back, rather than reading as zero", async (t) => {
  const dir = await makeDir();
  const first = await startServer(dir);
  await first.post("/api/rep", { reps: 6 });
  await first.stop();

  const second = await startServer(dir);
  await second.post("/api/rep", { reps: 1 });
  await second.stop();

  // What a machine that loses power leaves behind: the file is there, the name
  // is right, and the bytes never made it out of the write cache.
  await fs.writeFile(path.join(dir, "state.json"), "");

  const third = await startServer(dir);
  t.after(async () => {
    await third.stop();
    await cleanup(dir);
  });

  assert.equal((await third.get("/api/state")).done, 6);
});

test("an unreadable count is kept, not written over", async (t) => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, "state.json"), "half a file");

  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  await server.post("/api/rep", { reps: 1 });

  assert.equal(
    await fs.readFile(path.join(dir, "state.json.broken"), "utf8"),
    "half a file",
  );
  const state = await server.get("/api/state");
  assert.match(state.warning ?? "", /could not be read/i);
});

test("a count edited by hand on Windows is still readable", async (t) => {
  const dir = await makeDir();
  // What Notepad and PowerShell both write. Someone hand-editing this file is
  // someone already having a bad day, and refusing to read it afterwards turns
  // a repair into a second outage — this was found doing exactly that.
  await fs.writeFile(
    path.join(dir, "state.json"),
    `﻿${JSON.stringify({ carriedOver: 40, done: 15 })}`,
  );

  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  const state = await server.get("/api/state");
  assert.equal(state.left, 25);
  assert.equal(state.warning, null, "and it is not treated as a damaged file");
});

test("a doubt about the count outlives a good poll", async (t) => {
  const dir = await makeDir();
  const first = await startServer(dir);
  await first.post("/api/rep", { reps: 5 });
  await first.stop();

  const second = await startServer(dir);
  await second.post("/api/rep", { reps: 1 });
  await second.stop();

  await fs.writeFile(path.join(dir, "state.json"), "");

  const third = await startServer(dir);
  t.after(async () => {
    await third.stop();
    await cleanup(dir);
  });

  // The YouTube line clears itself every time a poll succeeds. A restored count
  // has to say so until a person settles it, or the warning is gone in thirty
  // seconds and the number looks as trustworthy as any other.
  assert.match((await third.get("/api/state")).warning ?? "", /backup/i);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.match((await third.get("/api/state")).warning ?? "", /backup/i);

  await third.post(
    "/api/count",
    { left: 5 },
    { "x-pushup-admin": await token(dir) },
  );
  assert.equal(
    (await third.get("/api/state")).warning,
    null,
    "settled by someone saying so",
  );
});

test("a page cannot set the count, because a page has no token", async (t) => {
  const dir = await makeDir();
  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  const refused = await server.post("/api/count", { left: 500 });
  assert.equal(refused.status, 403);

  const guessed = await server.post(
    "/api/count",
    { left: 500 },
    { "x-pushup-admin": "letmein" },
  );
  assert.equal(guessed.status, 403);
  assert.equal(
    (await server.get("/api/state")).left,
    0,
    "and the count did not move",
  );
});

test("someone at this machine can put the number back", async (t) => {
  const dir = await makeDir();
  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  await server.post("/api/rep", { reps: 4 });
  const { status, body } = await server.post(
    "/api/count",
    { left: 40 },
    { "x-pushup-admin": await token(dir) },
  );

  assert.equal(status, 200);
  assert.equal(body.left, 40, "the number you type is the number on screen");
  assert.equal(body.done, 4, "and push-ups already done stay done");

  const entries = await journal(dir);
  assert.match(
    entries.at(-1).reason,
    /set by hand/,
    "a hand-set count is the first thing you",
  );
});

test("a repaired count is still a count — it survives a restart", async (t) => {
  const dir = await makeDir();
  const first = await startServer(dir);
  await first.post(
    "/api/count",
    { left: 25 },
    { "x-pushup-admin": await token(dir) },
  );
  await first.stop();

  const second = await startServer(dir);
  t.after(async () => {
    await second.stop();
    await cleanup(dir);
  });

  assert.equal((await second.get("/api/state")).left, 25);
});

test("a typo for a count is refused rather than believed", async (t) => {
  const dir = await makeDir();
  const server = await startServer(dir);
  t.after(async () => {
    await server.stop();
    await cleanup(dir);
  });

  const admin = { "x-pushup-admin": await token(dir) };
  assert.equal(
    (await server.post("/api/count", { left: -5 }, admin)).status,
    400,
  );
  assert.equal(
    (await server.post("/api/count", { left: 2.5 }, admin)).status,
    400,
  );
  assert.equal(
    (await server.post("/api/count", { left: 10_000_000 }, admin)).status,
    400,
  );
  assert.equal((await server.get("/api/state")).left, 0);
});
