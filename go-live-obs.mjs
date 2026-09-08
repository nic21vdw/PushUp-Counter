import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SCENE = "PUSHUPS";
const cfgPath =
  process.env.APPDATA + "/obs-studio/plugin_config/obs-websocket/config.json";

let pw;
try {
  pw = JSON.parse(readFileSync(cfgPath, "utf8")).server_password;
} catch {
  process.exit(0);
}

const sha = (s) => createHash("sha256").update(s).digest("base64");
const ws = new WebSocket("ws://127.0.0.1:4455");
const pending = new Map();
let n = 0;
const req = (requestType, requestData) =>
  new Promise((resolve) => {
    const requestId = "r" + ++n;
    pending.set(requestId, resolve);
    ws.send(
      JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }),
    );
  });

const done = () => {
  try {
    ws.close();
  } catch {}
  process.exit(0);
};

setTimeout(done, 3000);
ws.onerror = done;

ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.op === 0) {
    const a = m.d.authentication;
    ws.send(
      JSON.stringify({
        op: 1,
        d: {
          rpcVersion: 1,
          authentication: a ? sha(sha(pw + a.salt) + a.challenge) : undefined,
          eventSubscriptions: 0,
        },
      }),
    );
  } else if (m.op === 2) {
    await req("SetCurrentProgramScene", { sceneName: SCENE });
    done();
  } else if (m.op === 7) {
    pending.get(m.d.requestId)?.(m.d);
    pending.delete(m.d.requestId);
  }
};
