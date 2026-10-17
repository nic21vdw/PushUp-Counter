import test from "node:test";
import assert from "node:assert/strict";

import { PoseTracker } from "../public/js/pose-tracker.js";

const W = 1280;
const H = 720;
const GAUGE_RADIUS = Math.max(16, W * 0.03);

class FakeContext {
  constructor() {
    this.calls = [];
    this.depth = 0;
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
  }

  record(op, extra = {}) {
    this.calls.push({
      op,
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      ...extra,
    });
  }

  save() {
    this.depth += 1;
    this.record("save");
  }
  restore() {
    this.depth -= 1;
    this.record("restore");
  }
  beginPath() {
    this.record("beginPath");
  }
  moveTo(x, y) {
    this.record("moveTo", { x, y });
  }
  lineTo(x, y) {
    this.record("lineTo", { x, y });
  }
  arc(x, y, r, from, to) {
    this.record("arc", { x, y, r, from, to });
  }
  stroke() {
    this.record("stroke");
  }
  fill() {
    this.record("fill");
  }
  fillRect(x, y, w, h) {
    this.record("fillRect", { x, y, w, h });
  }
  strokeRect(x, y, w, h) {
    this.record("strokeRect", { x, y, w, h });
  }
  clearRect() {
    this.record("clearRect");
  }
  createLinearGradient(x0, y0, x1, y1) {
    const gradient = { x0, y0, x1, y1, stops: [] };
    gradient.addColorStop = (at, color) => gradient.stops.push([at, color]);
    this.calls.push({ op: "gradient", gradient });
    return gradient;
  }

  count(op) {
    return this.calls.filter((c) => c.op === op).length;
  }
  clear() {
    this.calls.length = 0;
  }
}

function makeTracker() {
  const ctx = new FakeContext();
  const canvas = { width: W, height: H, getContext: () => ctx };
  const tracker = new PoseTracker({ video: {}, canvas, onPose() {} });
  return { tracker, ctx };
}

const norm = (px, py) => ({ x: px / W, y: py / H, z: 0, visibility: 0.95 });

/** Interior elbow angle `theta` in pixel space, upper arm pointing straight up. */
function pose({ left = 170, right = 170, rightElbowX = 800 } = {}) {
  const lm = Array.from({ length: 33 }, () => norm(640, 360));
  const arm = (shoulder, elbow, wrist, ex, theta) => {
    const rad = (theta * Math.PI) / 180;
    lm[shoulder] = norm(ex, 300);
    lm[elbow] = norm(ex, 450);
    lm[wrist] = norm(ex + 150 * Math.sin(rad), 450 - 150 * Math.cos(rad));
  };
  arm(11, 13, 15, 400, left);
  arm(12, 14, 16, rightElbowX, right);
  lm[0] = norm(600, 200);
  lm[23] = norm(420, 520);
  lm[24] = norm(780, 520);
  lm[25] = norm(430, 620);
  lm[26] = norm(770, 620);
  lm[27] = norm(435, 690);
  lm[28] = norm(765, 690);
  lm[31] = norm(450, 700);
  lm[32] = norm(750, 700);
  return lm;
}

const hueOf = (color) => Number(/^hsl\((\d+)/.exec(color)?.[1]);
const gaugeArcs = (ctx) =>
  ctx.calls.filter(
    (c) => c.op === "arc" && Math.abs(c.r - GAUGE_RADIUS) < 1e-6,
  );
const settle = (tracker, landmarks, frames = 12, now = 10_000) => {
  for (let i = 0; i < frames; i++) {
    tracker.drawSkeleton(landmarks, { now, highlight: false });
  }
};

test("draws a body: bones under a head-to-feet gradient, glowing joints, balanced state", () => {
  const { tracker, ctx } = makeTracker();
  tracker.drawSkeleton(pose(), { now: 10_000, highlight: false });
  assert.ok(ctx.count("moveTo") >= 12, "every visible bone is in the path");
  assert.ok(ctx.count("stroke") >= 4, "drawn in glow layers");
  assert.ok(ctx.count("arc") > 20);
  assert.equal(ctx.count("save"), ctx.count("restore"));
  assert.equal(ctx.depth, 0);
  const gradient = ctx.calls.find((c) => c.op === "gradient").gradient;
  assert.equal(gradient.stops.length, 3);
  assert.ok(
    Math.hypot(gradient.x1 - gradient.x0, gradient.y1 - gradient.y0) > 100,
    "the gradient should run along the body, shoulders to feet",
  );
  assert.ok(ctx.calls.some((c) => c.op === "stroke" && c.alpha < 0.2));
  assert.ok(
    ctx.calls.some((c) => c.op === "fill" && c.composite === "lighter"),
  );
});

test("nothing to draw and nothing thrown when the pose is lost", () => {
  const { tracker, ctx } = makeTracker();
  settle(tracker, pose(), 4);
  assert.ok(tracker.trailCount > 0);
  ctx.clear();
  assert.doesNotThrow(() => tracker.drawSkeleton(null));
  assert.doesNotThrow(() => tracker.drawSkeleton([]));
  assert.equal(ctx.calls.length, 0);
  assert.equal(tracker.trailCount, 0);
});

test("landmarks below the visibility floor are not drawn", () => {
  const { tracker, ctx } = makeTracker();
  const hidden = pose().map((p) => ({ ...p, visibility: 0.05 }));
  tracker.drawSkeleton(hidden, { now: 10_000, highlight: false });
  assert.equal(ctx.count("arc"), 0);
  assert.equal(ctx.count("stroke"), 0);
});

test("heat is clamped to 0..1 and starts cold", () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.heat, 0);
  tracker.heat = 0.4;
  assert.equal(tracker.heat, 0.4);
  tracker.heat = 7;
  assert.equal(tracker.heat, 1);
  tracker.heat = -3;
  assert.equal(tracker.heat, 0);
  tracker.heat = NaN;
  assert.equal(tracker.heat, 0);
});

test("heat moves the glow from cyan and violet toward gold and red", () => {
  const joints = (heat) => {
    const { tracker, ctx } = makeTracker();
    tracker.heat = heat;
    tracker.drawSkeleton(pose(), { now: 10_000, highlight: false });
    return ctx.calls
      .filter((c) => c.op === "fill" && /^hsl/.test(c.fillStyle))
      .map((c) => hueOf(c.fillStyle));
  };
  const cold = joints(0);
  const hot = joints(1);
  assert.ok(cold.length > 0 && hot.length > 0);
  assert.ok(Math.min(...cold) >= 180, `cold hues ${[...new Set(cold)]}`);
  assert.ok(
    hot.every((h) => h <= 70 || h >= 330),
    `hot hues ${[...new Set(hot)]}`,
  );
});

test("the elbow gauge is empty at lockout and green at depth, going red to green between", () => {
  const colorAt = (theta) => {
    const { tracker, ctx } = makeTracker();
    settle(tracker, pose({ left: theta, right: 175 }));
    ctx.clear();
    tracker.drawSkeleton(pose({ left: theta, right: 175 }), {
      now: 10_000,
      highlight: false,
    });
    const arcs = gaugeArcs(ctx).filter((a) => Math.abs(a.x - 400) < 1);
    const filled = arcs.filter((a) => /^hsl/.test(a.strokeStyle));
    return { arcs, filled };
  };

  assert.equal(colorAt(172).filled.length, 0, "no fill at lockout");
  assert.ok(colorAt(172).arcs.length >= 1, "but the track is still drawn");

  const mid = colorAt(125);
  const deep = colorAt(80);
  assert.ok(mid.filled.length > 0 && deep.filled.length > 0);
  const midHue = hueOf(mid.filled[0].strokeStyle);
  const deepHue = hueOf(deep.filled[0].strokeStyle);
  assert.ok(midHue > 20 && midHue < 100, `mid hue ${midHue}`);
  assert.ok(deepHue >= 120, `deep hue ${deepHue}`);

  const sweep = (a) => a.to - a.from;
  assert.ok(sweep(deep.filled[0]) > sweep(mid.filled[0]));
  assert.ok(Math.abs(sweep(deep.filled[0]) - Math.PI * 2) < 0.2);
});

test("gaugeTop and gaugeFull retune where the gauge starts and finishes", () => {
  const { tracker, ctx } = makeTracker();
  tracker.gaugeFull = 120;
  settle(tracker, pose({ left: 120, right: 175 }));
  ctx.clear();
  tracker.drawSkeleton(pose({ left: 120, right: 175 }), {
    now: 10_000,
    highlight: false,
  });
  const filled = gaugeArcs(ctx).filter(
    (a) => Math.abs(a.x - 400) < 1 && /^hsl/.test(a.strokeStyle),
  );
  assert.ok(filled.length > 0);
  assert.ok(hueOf(filled[0].strokeStyle) >= 120);
});

test("two elbows that sit on top of each other get one gauge, not two", () => {
  const apart = makeTracker();
  settle(apart.tracker, pose({ left: 100, right: 100, rightElbowX: 800 }));
  apart.ctx.clear();
  apart.tracker.drawSkeleton(
    pose({ left: 100, right: 100, rightElbowX: 800 }),
    {
      now: 10_000,
      highlight: false,
    },
  );
  const together = makeTracker();
  const sideOn = pose({ left: 100, right: 100, rightElbowX: 410 });
  settle(together.tracker, sideOn);
  together.ctx.clear();
  together.tracker.drawSkeleton(sideOn, { now: 10_000, highlight: false });

  const tracks = (ctx) =>
    gaugeArcs(ctx).filter((a) => a.from === 0 && a.to === Math.PI * 2).length;
  assert.equal(tracks(apart.ctx), 2);
  assert.equal(tracks(together.ctx), 1);
});

test("wrists and shoulders leave a trail that fades in and thickens toward now", () => {
  const { tracker, ctx } = makeTracker();
  for (let i = 0; i < 8; i++) {
    const lm = pose();
    lm[15] = norm(500 + i * 30, 300);
    tracker.drawSkeleton(lm, { now: 10_000, highlight: false });
  }
  assert.equal(tracker.trailCount, 8);
  ctx.clear();
  const lm = pose();
  lm[15] = norm(500 + 8 * 30, 300);
  tracker.drawSkeleton(lm, { now: 10_000, highlight: false });

  const segments = [];
  const calls = ctx.calls;
  for (let i = 0; i < calls.length - 2; i++) {
    if (
      calls[i].op === "beginPath" &&
      calls[i + 1].op === "moveTo" &&
      calls[i + 2].op === "lineTo" &&
      calls[i + 3]?.op === "stroke" &&
      Math.abs(calls[i + 1].y - 300) < 1 &&
      calls[i + 1].x >= 500 &&
      calls[i + 1].x !== calls[i + 2].x
    ) {
      segments.push(calls[i + 3]);
    }
  }
  assert.ok(segments.length >= 6, `${segments.length} wrist segments`);
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].alpha >= segments[i - 1].alpha);
    assert.ok(segments[i].lineWidth >= segments[i - 1].lineWidth);
  }
});

test("the trail is capped, and a tracking jump starts it over", () => {
  const { tracker } = makeTracker();
  settle(tracker, pose(), 40);
  assert.equal(tracker.trailCount, 10);

  const jumped = pose();
  jumped[15] = norm(1200, 100);
  tracker.drawSkeleton(jumped, { now: 10_000, highlight: false });
  assert.equal(tracker.trailCount, 1);
});

test("drawing reuses its buffers instead of allocating per frame", () => {
  const { tracker } = makeTracker();
  const { pts, vis, trail } = tracker;
  settle(tracker, pose(), 30);
  assert.equal(tracker.pts, pts);
  assert.equal(tracker.vis, vis);
  assert.equal(tracker.trail, trail);
});

test("flash starts a bright full-tile pulse that fades out", () => {
  const { tracker, ctx } = makeTracker();
  tracker.drawPulse(1000);
  assert.equal(ctx.calls.length, 0, "nothing before a flash");

  tracker.flash();
  const at = tracker.flashAt;
  tracker.drawPulse(at + 10);
  const wash = ctx.calls.find((c) => c.op === "fillRect");
  assert.deepEqual([wash.x, wash.y, wash.w, wash.h], [0, 0, W, H]);
  assert.ok(wash.alpha > 0.25, `wash alpha ${wash.alpha}`);
  assert.equal(wash.composite, "lighter");
  assert.ok(ctx.count("strokeRect") >= 3, "a neon border around the tile");
  assert.equal(ctx.count("save"), ctx.count("restore"));

  ctx.clear();
  tracker.drawPulse(at + 250);
  const later = ctx.calls.find((c) => c.op === "fillRect");
  assert.ok(later.alpha < wash.alpha);

  ctx.clear();
  tracker.drawPulse(at + 2000);
  assert.equal(ctx.calls.length, 0, "and gone once it has faded");
});

test("the pulse runs gold when the heat is up and lime when it is not", () => {
  const colorAt = (heat) => {
    const { tracker, ctx } = makeTracker();
    tracker.heat = heat;
    tracker.flash();
    tracker.drawPulse(tracker.flashAt + 10);
    return hueOf(ctx.calls.find((c) => c.op === "fillRect").fillStyle);
  };
  assert.ok(Math.abs(colorAt(0) - 150) < 5);
  assert.ok(Math.abs(colorAt(1) - 45) < 5);
});

test("highlight is true just after a flash and false afterwards", () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.highlight, false);
  tracker.flash();
  assert.equal(tracker.highlight, true);
  tracker.flashAt = performance.now() - 1000;
  assert.equal(tracker.highlight, false);
});

test("a flash brightens the skeleton as well as washing the tile", () => {
  const joints = (now) => {
    const { tracker, ctx } = makeTracker();
    tracker.flashAt = 10_000;
    tracker.drawSkeleton(pose(), { now, highlight: false });
    return ctx.calls
      .filter((c) => c.op === "fill" && /^hsl/.test(c.fillStyle))
      .map((c) => hueOf(c.fillStyle));
  };
  const during = joints(10_020);
  const after = joints(12_000);
  assert.ok(
    during.some((h) => h < 200 && h > 100),
    `${during}`,
  );
  assert.ok(after.every((h) => h >= 180));
});

test("stopping the tracker clears the trail", () => {
  const { tracker } = makeTracker();
  settle(tracker, pose(), 5);
  assert.ok(tracker.trailCount > 0);
  tracker.stop();
  assert.equal(tracker.trailCount, 0);
});
