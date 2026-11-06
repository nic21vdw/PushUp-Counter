#!/usr/bin/env node
import fs from "node:fs/promises";
import {
  SEEDED_RANDOM,
  arg,
  flag,
  launch,
  processCpu,
  routeAssets,
  rss,
  slope,
  startServer,
} from "./lib.mjs";

const PORT = Number(arg("port", "4791"));
const SECONDS = Number(arg("seconds", "60"));
const WARMUP = Number(arg("warmup", "15"));
const SAMPLE_EVERY = Number(arg("every", "10"));
const OUT = arg("out", "");
const VIDEO = arg("video", "");
const SHOTS = arg("screenshots", "");
const VARIANTS = arg("variants", "tracker,stage,both").split(",");
const ASSETS = {
  threeDir: arg("three", process.env.THREE_DIR ?? ""),
  patches: process.env.PERF_PATCH ? JSON.parse(process.env.PERF_PATCH) : [],
  cpuDelegate: flag("cpu-delegate"),
};

const URLS = {
  tracker: "/overlay.html?demo=1&fx=0&voice=0",
  stage: "/overlay.html?demo=1&camera=none-such&voice=0",
  both: "/overlay.html?demo=1&voice=0",
};

const PAGE_PROBE = () => {
  const frames = [];
  let last = performance.now();
  const tick = (now) => {
    frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  let stageFrames = 0;
  const clear = WebGL2RenderingContext.prototype.clear;
  WebGL2RenderingContext.prototype.clear = function (mask) {
    if (this.canvas?.getAttribute?.("aria-hidden") === "true") stageFrames += 1;
    return clear.call(this, mask);
  };
  globalThis.__perf = {
    take() {
      const rendered = stageFrames;
      stageFrames = 0;
      const t = globalThis.__poseTracker;
      return {
        frames: frames.splice(0),
        longTasks: longTasks.splice(0),
        stageFrames: rendered,
        detector: t
          ? {
              running: t.running,
              sampleRate: t.sampleRate,
              inferMs: t.inferMs,
              pose: Boolean(t.worldLandmarks),
            }
          : null,
        stage: Boolean(document.querySelector("canvas[aria-hidden='true']")),
        heap: performance.memory?.usedJSHeapSize ?? null,
      };
    },
  };
};

const pct = (sorted, p) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    : null;
const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

async function measure(browser, base, variant) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await context.addInitScript(SEEDED_RANDOM);
  await context.addInitScript(PAGE_PROBE);
  await routeAssets(context, base, ASSETS);
  const page = await context.newPage();
  page.on("pageerror", (err) =>
    console.error(`[${variant}] page error`, err.message),
  );
  const browserSession = await browser.newBrowserCDPSession();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(`${base}${URLS[variant]}`);
  await page.waitForTimeout(WARMUP * 1000);
  await page.evaluate(() => globalThis.__perf.take());

  const before = await processCpu(browserSession);
  const metrics0 = await cdp.send("Performance.getMetrics");
  const startedAt = Date.now();
  const samples = [];
  const frames = [];
  const rates = [];
  const infers = [];
  let longTasks = 0;
  let stageFrames = 0;
  let posesSeen = 0;
  let stage = false;
  while (Date.now() - startedAt < SECONDS * 1000) {
    const left = SECONDS * 1000 - (Date.now() - startedAt);
    await page.waitForTimeout(Math.min(SAMPLE_EVERY * 1000, left));
    if (SHOTS)
      await page.screenshot({
        path: `${SHOTS}-${variant}-${samples.length}.png`,
      });
    const probe = await page.evaluate(() => globalThis.__perf.take());
    frames.push(...probe.frames);
    longTasks += probe.longTasks.length;
    stageFrames += probe.stageFrames;
    stage = probe.stage;
    if (probe.detector?.running) {
      rates.push(probe.detector.sampleRate);
      if (probe.detector.inferMs !== null) infers.push(probe.detector.inferMs);
      if (probe.detector.pose) posesSeen += 1;
    }
    const { processes } = await processCpu(browserSession);
    const mem = {};
    for (const p of processes) {
      const type = p.type.toLowerCase();
      mem[type] = (mem[type] ?? 0) + ((await rss(p.id)) ?? 0);
    }
    samples.push({
      t: (Date.now() - startedAt) / 1000,
      heap: probe.heap,
      rss: mem,
    });
  }
  const elapsed = (Date.now() - startedAt) / 1000;
  const after = await processCpu(browserSession);
  const metrics1 = await cdp.send("Performance.getMetrics");
  await context.close();

  const metric = (m, name) =>
    m.metrics.find((x) => x.name === name)?.value ?? 0;
  const cpu = {};
  for (const [type, t] of Object.entries(after.byType))
    cpu[type] = t - (before.byType[type] ?? 0);
  const sorted = [...frames].sort((a, b) => a - b);
  const mb = (bytes) => bytes / 2 ** 20;
  const memSlope = (pick) =>
    mb(slope(samples.map((s) => [s.t, pick(s) ?? 0])) * 3600);
  return {
    variant,
    seconds: elapsed,
    stage,
    cpuPercent: Object.fromEntries(
      Object.entries(cpu).map(([k, v]) => [k, (100 * v) / elapsed]),
    ),
    mainThreadBusyPercent:
      (100 *
        (metric(metrics1, "TaskDuration") - metric(metrics0, "TaskDuration"))) /
      elapsed,
    detectorFps: mean(rates),
    inferMs: mean(infers),
    poseSeen: `${posesSeen}/${samples.length}`,
    stageFps: stageFrames / elapsed,
    pageFps: frames.length / elapsed,
    frameMs: {
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      p99: pct(sorted, 0.99),
    },
    longTasks,
    memory: {
      heapMB: mb(samples.at(-1)?.heap ?? 0),
      rendererRssMB: mb(samples.at(-1)?.rss.renderer ?? 0),
      gpuRssMB: mb(samples.at(-1)?.rss.gpu ?? 0),
      heapSlopeMBPerHour: memSlope((s) => s.heap),
      rendererSlopeMBPerHour: memSlope((s) => s.rss.renderer),
      gpuSlopeMBPerHour: memSlope((s) => s.rss.gpu),
    },
    samples,
  };
}

const f = (v, d = 1) =>
  v === null || v === undefined ? "-" : Number(v).toFixed(d);

function report(r) {
  const c = r.cpuPercent;
  const m = r.memory;
  return [
    `${r.variant}: ${f(r.seconds, 0)} s, stage ${r.stage ? "on" : "off"}`,
    `  CPU % of one core: renderer ${f(c.renderer)}, gpu ${f(c.gpu)}, browser ${f(c.browser)}`,
    `  main thread busy ${f(r.mainThreadBusyPercent)}%, long tasks ${r.longTasks}`,
    `  detector ${f(r.detectorFps)} samples/s, inference ${f(r.inferMs)} ms, pose seen in ${r.poseSeen} probes`,
    `  stage ${f(r.stageFps)} renders/s, page ${f(r.pageFps)} fps, frame p50 ${f(r.frameMs.p50)} p95 ${f(r.frameMs.p95)} p99 ${f(r.frameMs.p99)} ms`,
    `  memory: heap ${f(m.heapMB)} MB, renderer RSS ${f(m.rendererRssMB)} MB, gpu RSS ${f(m.gpuRssMB)} MB`,
    `  memory slope: heap ${f(m.heapSlopeMBPerHour)} MB/h, renderer ${f(m.rendererSlopeMBPerHour)} MB/h, gpu ${f(m.gpuSlopeMBPerHour)} MB/h`,
  ].join("\n");
}

const server = await startServer(PORT);
const browser = await launch({
  video: VIDEO,
  cameraFps: Number(arg("camera-fps", "30")),
});
const results = [];
try {
  for (const variant of VARIANTS) {
    const r = await measure(browser, server.base, variant);
    console.log(report(r));
    results.push(r);
  }
} finally {
  await browser.close();
  await server.stop();
}
if (OUT) await fs.writeFile(OUT, JSON.stringify(results, null, 2));
