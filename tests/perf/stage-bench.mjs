#!/usr/bin/env node
import {
  SEEDED_RANDOM,
  arg,
  launch,
  processCpu,
  routeAssets,
  startServer,
} from "./lib.mjs";

const PORT = Number(arg("port", "4792"));
const WARMUP_STEPS = Number(arg("warmup", "300"));
const STEPS = Number(arg("steps", "1800"));
const REPEATS = Number(arg("repeats", "3"));
const DPR = Number(arg("dpr", "1"));
const SHOT = arg("screenshot", "");
const PROFILE = arg("profile", "");
const URL = arg("url", "/overlay.html?demo=1&camera=none-such&voice=0");
const THREE_DIR = arg("three", process.env.THREE_DIR ?? "");
const ARMS = [
  ["A", process.env.PERF_PATCH],
  ...(process.env.PERF_PATCH_B ? [["B", process.env.PERF_PATCH_B]] : []),
].map(([name, json]) => ({
  name,
  assets: { threeDir: THREE_DIR, patches: json ? JSON.parse(json) : [] },
}));

const VIRTUAL_CLOCK = () => {
  const realRaf = window.requestAnimationFrame.bind(window);
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  let rafs = new Map();
  performance.now = () => now;
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: now + every, fn, args, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (fn) => {
    const id = nextId++;
    rafs.set(id, fn);
    return id;
  };
  window.cancelAnimationFrame = (id) => rafs.delete(id);
  let stageRenders = 0;
  const clear = WebGL2RenderingContext.prototype.clear;
  WebGL2RenderingContext.prototype.clear = function (mask) {
    if (this.canvas?.getAttribute?.("aria-hidden") === "true")
      stageRenders += 1;
    return clear.call(this, mask);
  };
  const run = (fn, args = []) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(err);
    }
  };
  function step(dt) {
    now += dt;
    for (;;) {
      let due = null;
      for (const [id, t] of timers)
        if (t.at <= now && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      const [id, t] = due;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      if (typeof t.fn === "function") run(t.fn, t.args);
    }
    const callbacks = rafs;
    rafs = new Map();
    for (const fn of callbacks.values()) run(fn, [now]);
  }
  window.__clock = {
    async run(steps, dt) {
      const before = stageRenders;
      for (let i = 0; i < steps; i += 1) {
        step(dt);
        await new Promise((resolve) => realRaf(resolve));
      }
      return stageRenders - before;
    },
    stage: () => Boolean(document.querySelector("canvas[aria-hidden='true']")),
  };
};

async function once(browser, base, assets, label = "") {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: DPR,
  });
  await context.addInitScript(SEEDED_RANDOM);
  await context.addInitScript(VIRTUAL_CLOCK);
  await routeAssets(context, base, assets);
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("page error", err.message));
  const session = await browser.newBrowserCDPSession();
  await page.goto(`${base}${URL}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__clock.stage(), null, {
    timeout: 20000,
  });
  await page.waitForLoadState("networkidle");
  await page.evaluate((n) => window.__clock.run(n, 1000 / 60), WARMUP_STEPS);
  const cdp = PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  const before = await processCpu(session);
  const startedAt = Date.now();
  const renders = await page.evaluate(
    (n) => window.__clock.run(n, 1000 / 60),
    STEPS,
  );
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(
      top.map(([k, ms]) => `${ms.toFixed(0).padStart(7)} ms  ${k}`).join("\n"),
    );
  }
  const wall = (Date.now() - startedAt) / 1000;
  const after = await processCpu(session);
  if (SHOT) await page.screenshot({ path: `${SHOT}-${label}.png` });
  await context.close();
  const used = (type) => after.byType[type] - (before.byType[type] ?? 0);
  return {
    renders,
    wall,
    gpu: used("gpu"),
    renderer: used("renderer"),
  };
}

const server = await startServer(PORT);
const browser = await launch();
const runs = Object.fromEntries(ARMS.map((a) => [a.name, []]));
try {
  for (let i = 0; i < REPEATS; i += 1) {
    for (const arm of ARMS) {
      const r = await once(
        browser,
        server.base,
        arm.assets,
        `${arm.name}${i + 1}`,
      );
      runs[arm.name].push(r);
      console.log(
        `${arm.name} run ${i + 1}: ${r.renders} stage renders over ${STEPS} frames, ${r.wall.toFixed(1)} s wall, gpu process ${r.gpu.toFixed(2)} s CPU, renderer ${r.renderer.toFixed(2)} s CPU`,
      );
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = {};
for (const arm of ARMS) {
  const rs = runs[arm.name];
  summary[arm.name] = {
    gpu: median(rs.map((r) => r.gpu)),
    renderer: median(rs.map((r) => r.renderer)),
    total: median(rs.map((r) => r.gpu + r.renderer)),
    wall: median(rs.map((r) => r.wall)),
  };
  const m = summary[arm.name];
  console.log(
    `${arm.name} median: gpu ${m.gpu.toFixed(2)} s, renderer ${m.renderer.toFixed(2)} s, total ${m.total.toFixed(2)} s CPU, wall ${m.wall.toFixed(1)} s for ${STEPS} frames (${(STEPS / 60).toFixed(0)} s of stage time)`,
  );
}
if (summary.B)
  console.log(
    `B vs A: total CPU ${((100 * (summary.B.total - summary.A.total)) / summary.A.total).toFixed(1)}%, gpu ${((100 * (summary.B.gpu - summary.A.gpu)) / summary.A.gpu).toFixed(1)}%, wall ${((100 * (summary.B.wall - summary.A.wall)) / summary.A.wall).toFixed(1)}%`,
  );
