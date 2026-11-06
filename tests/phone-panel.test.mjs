/**
 * The phone panel over real HTTP, against a throwaway server in a temp folder.
 * The live state.json is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateAddress } from "../public/js/lan-address.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
let nextPort = 15831;
const PIN = "4321";

async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-phone-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(
    path.join(ROOT, "public"),
    path.join(dir, "public"),
    LINK_TYPE,
  );
  const port = nextPort++;
  const phonePort = nextPort++;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PHONE_PORT: String(phonePort),
      PHONE_HOST: "127.0.0.1",
      PHONE_PIN: PIN,
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
  const phone = `http://127.0.0.1:${phonePort}`;
  const main = `http://127.0.0.1:${port}`;
  const request = async (pathname, { pin = PIN, method, body } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (pin !== null) headers["X-Pushup-Pin"] = pin;
    const res = await fetch(`${phone}${pathname}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, res };
  };
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${phone}/`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return {
    phone,
    main,
    request,
    action: (action, pin) => request("/api/control", { pin, body: { action } }),
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

test("private and loopback addresses are local, public ones are not", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "::ffff:192.168.1.20",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.10.10",
    "fd12:3456::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of [
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "192.169.0.1",
    "2001:4860::8888",
    "",
    undefined,
  ]) {
    assert.equal(isPrivateAddress(ip), false, String(ip));
  }
});

test("the phone page loads and every action needs the PIN", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const page = await s.request("/", { pin: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Start set/);
  assert.match(page.res.headers.get("content-type"), /text\/html/);
  assert.equal((await s.request("/phone.js", { pin: null })).status, 200);

  assert.equal((await s.request("/api/state", { pin: null })).status, 401);
  assert.equal((await s.request("/api/state", { pin: "0000" })).status, 401);
  assert.equal((await s.action("plus", "0000")).status, 401);

  const state = await s.request("/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(Object.keys(state.json).sort(), [
    "done",
    "left",
    "owed",
    "phase",
    "setNumber",
    "setReps",
  ]);
});

test("start, +1, -1, undo and end set drive the same session as the control panel", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  let r = await s.action("start");
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, "active");
  assert.equal(r.json.setNumber, 1);

  r = await s.action("plus");
  r = await s.action("plus");
  assert.equal(r.json.done, 2);
  assert.equal(r.json.setReps, 2);

  r = await s.action("minus");
  assert.equal(r.json.done, 1);

  r = await s.action("undo");
  assert.equal(r.json.done, 0);
  assert.equal(r.json.setReps, 0);

  r = await s.action("undo");
  assert.equal(r.status, 400, "nothing left to undo");

  r = await s.action("finish");
  assert.equal(r.json.phase, "ready");

  const main = await (await fetch(`${s.main}/api/state`)).json();
  assert.equal(main.done, 0);
  assert.equal(main.session.phase, "ready");
});

test("the phone cannot reach anything outside its five actions", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  for (const action of ["reset-stream", "goal", "settings", "boss", "chat"]) {
    const r = await s.action(action);
    assert.equal(r.status, 400, action);
  }
  for (const pathname of [
    "/control.html",
    "/overlay.html",
    "/status.html",
    "/js/session-model.js",
    "/api/count",
    "/api/rep",
  ]) {
    const r = await s.request(pathname);
    assert.equal(r.status, 404, pathname);
  }
  const count = await s.request("/api/count", { body: { left: 0 } });
  assert.equal(count.status, 404);
});

test("five wrong PINs lock the address out for a minute", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  for (let i = 0; i < 5; i++) {
    assert.equal((await s.request("/api/state", { pin: "9999" })).status, 401);
  }
  const locked = await s.request("/api/state");
  assert.equal(locked.status, 429, "even the right PIN waits out the lock");
});

test("without a PIN in .env the phone panel does not listen", async (t) => {
  const s = await startServer({ PHONE_PIN: "" });
  t.after(() => s.stop());
  await assert.rejects(fetch(`${s.phone}/`));
});

test("a PIN that is not 4 to 12 digits leaves the panel off", async (t) => {
  const s = await startServer({ PHONE_PIN: "abc" });
  t.after(() => s.stop());
  await assert.rejects(fetch(`${s.phone}/`));
});
