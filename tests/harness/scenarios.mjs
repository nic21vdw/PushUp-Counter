import { Timeline } from "./timeline.mjs";
import { makeCamera } from "./pose-synth.mjs";

const hideNearArm = (p) => (p.arm ? 0.25 : undefined);
const hideBothArms = (p) => (p.arm ? 0.2 : undefined);

function clean(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1500);
  for (let r = 0; r < 12; r += 1)
    tl.rep({
      top: tl.rand(164, 174),
      bottom: tl.rand(68, 88),
      downMs: tl.rand(650, 1000),
      upMs: tl.rand(550, 900),
      topMs: tl.rand(200, 700),
    });
  tl.hold(1500);
  return { tl, camera: { seed } };
}

function half(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1500);
  for (let r = 0; r < 16; r += 1) {
    const full = r % 2 === 0 || tl.rand(0, 1) < 0.3;
    const downMs = tl.rand(450, 800);
    let during = null;
    if (r % 3 === 1) {
      const start = tl.t;
      const from = downMs * 0.7;
      const to = from + tl.rand(300, 700);
      during = (body, t) =>
        t - start > from && t - start < to
          ? { ...body, visibility: hideBothArms }
          : body;
    }
    tl.rep({
      top: tl.rand(162, 172),
      bottom: full ? tl.rand(70, 90) : tl.rand(120, 138),
      downMs,
      upMs: tl.rand(400, 700),
      topMs: tl.rand(150, 500),
      counts: full,
      during,
    });
  }
  tl.hold(1500);
  return { tl, camera: { seed } };
}

function fast(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1200);
  for (let r = 0; r < 16; r += 1) {
    const last = r === 15;
    tl.rep({
      top: tl.rand(138, 152),
      endTop: last ? 168 : undefined,
      bottom: tl.rand(80, 94),
      downMs: tl.rand(220, 320),
      upMs: tl.rand(200, 300),
      topMs: last ? 800 : tl.rand(0, 60),
    });
  }
  tl.hold(1200);
  return { tl, camera: { seed } };
}

function paused(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1500);
  for (let r = 0; r < 10; r += 1)
    tl.rep({
      top: tl.rand(162, 172),
      bottom: tl.rand(70, 88),
      downMs: tl.rand(700, 1200),
      upMs: tl.rand(600, 1000),
      bottomHoldMs: r % 2 ? tl.rand(1000, 2500) : tl.rand(0, 300),
      topMs: r % 3 === 0 ? tl.rand(2000, 4000) : tl.rand(300, 800),
    });
  tl.hold(1500);
  return { tl, camera: { seed } };
}

function covered(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1500);
  for (let r = 0; r < 12; r += 1) {
    const kind = r % 4;
    const downMs = tl.rand(600, 900);
    const holdMs = tl.rand(100, 400);
    let during = null;
    if (kind === 1) {
      const from = downMs * 0.75;
      const to = downMs + holdMs + tl.rand(150, 350);
      const start = tl.t;
      during = (body, t) =>
        t - start > from && t - start < to
          ? { ...body, visibility: hideNearArm }
          : body;
    } else if (kind === 2) {
      const start = tl.t;
      const from = downMs * 0.8;
      const to = from + tl.rand(500, 1000);
      during = (body, t) => (t - start > from && t - start < to ? null : body);
    } else if (kind === 3) {
      const start = tl.t;
      const from = downMs * 0.7;
      const to = from + tl.rand(300, 600);
      during = (body, t) =>
        t - start > from && t - start < to
          ? { ...body, visibility: hideBothArms }
          : body;
    }
    tl.rep({
      top: tl.rand(162, 172),
      bottom: tl.rand(70, 88),
      downMs,
      bottomHoldMs: holdMs,
      upMs: tl.rand(600, 900),
      topMs: tl.rand(300, 600),
      during,
    });
    if (kind === 0) tl.cover(tl.rand(1500, 3500)).hold(tl.rand(300, 700));
  }
  tl.hold(1500);
  return { tl, camera: { seed } };
}

function walkThrough(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.cover(500);
  tl.walk(4000, { fromX: -1.0, toX: 2.6, elbow: 155, pump: 10 });
  tl.cover(800);
  tl.walk(3500, { fromX: 2.6, toX: -1.0, elbow: 110, pump: 35 });
  tl.cover(800);
  tl.walk(2500, { fromX: -0.6, toX: 0.6, elbow: 160, pump: 0 });
  tl.getDown(1200);
  tl.hold(1000);
  for (let r = 0; r < 8; r += 1)
    tl.rep({
      top: tl.rand(162, 172),
      bottom: tl.rand(70, 88),
      downMs: tl.rand(600, 900),
      upMs: tl.rand(500, 800),
      topMs: tl.rand(200, 600),
    });
  tl.standUp(1000);
  tl.pickUp(tl.rand(1200, 2200), {
    maxBow: tl.rand(55, 85),
    minElbow: tl.rand(75, 100),
  });
  tl.hold(500, { pose: "stand", x: 0.4, elbow: 165 });
  tl.drink(tl.rand(1500, 2500));
  tl.walk(3000, { fromX: 0.6, toX: 3, elbow: 95, pump: 20 });
  tl.cover(1000);
  return { tl, camera: { seed } };
}

function crossing(seed, fps = 30) {
  const tl = new Timeline({ fps, seed });
  tl.hold(1500);
  for (let r = 0; r < 10; r += 1) {
    let during = null;
    if (r % 3 === 1) {
      const start = tl.t;
      const from = tl.rand(200, 900);
      const to = from + tl.rand(500, 900);
      during = (body, t) =>
        t - start > from && t - start < to
          ? {
              pose: "stand",
              x: 0.2 + (t - start - from) / 400,
              swing: 25 * Math.sin((t - start) / 140),
              stride: 20 * Math.sin((t - start) / 140),
              elbow: 95 + 30 * Math.sin((t - start) / 90),
            }
          : body;
    }
    tl.rep({
      top: tl.rand(162, 172),
      bottom: tl.rand(70, 88),
      downMs: tl.rand(600, 900),
      upMs: tl.rand(550, 850),
      topMs: tl.rand(250, 600),
      during,
    });
  }
  tl.hold(1500);
  return { tl, camera: { seed } };
}

function jitter(seed, fps = 30) {
  const tl = new Timeline({ fps, seed, frameJitterMs: 9, dropRate: 0.06 });
  tl.hold(1500);
  for (let r = 0; r < 12; r += 1)
    tl.rep({
      top: tl.rand(158, 172),
      bottom: tl.rand(72, 92),
      downMs: tl.rand(400, 900),
      upMs: tl.rand(350, 800),
      topMs: tl.rand(100, 600),
    });
  tl.hold(1500);
  return {
    tl,
    camera: {
      seed,
      noise: 0.022,
      farNoise: 0.045,
      screenNoise: 0.008,
      rollDeg: 2.5,
      shake: 0.01,
      outlierRate: 0.03,
    },
  };
}

export const SCENARIOS = {
  clean,
  half,
  fast,
  paused,
  covered,
  "walk-through": walkThrough,
  crossing,
  jitter,
};

export const SEEDS = [1, 2, 3, 4, 5];

export function buildScenario(name, seed, { fps = 30 } = {}) {
  const { tl, camera } = SCENARIOS[name](seed, fps);
  const render = makeCamera(camera);
  const samples = tl.frames.map((f) => ({ t: f.t, ...render(f.body) }));
  return { name, seed, samples, reps: tl.reps, decoys: tl.decoys };
}
