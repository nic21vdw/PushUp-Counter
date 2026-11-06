import { rng } from "../rep-traces.mjs";

export const UPPER_ARM = 0.3;
export const FOREARM = 0.27;
const BODY = 1.42;
const HIP_FROM_ANKLE = 0.9;
const VIEW_W = 3.6;
export const ASPECT = 16 / 9;
const VIEW_H = VIEW_W / ASPECT;
const CAMERA_X = 0.8;
const CAMERA_Y = 0.9;

const HALF_WIDTH = {
  shoulder: 0.19,
  elbow: 0.22,
  wrist: 0.2,
  hip: 0.11,
  knee: 0.1,
  ankle: 0.1,
};

export function gauss(random) {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const rad = (deg) => (deg * Math.PI) / 180;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a) => Math.hypot(a.x, a.y);

export function shoulderToWrist(elbowDeg) {
  return Math.sqrt(
    UPPER_ARM ** 2 +
      FOREARM ** 2 -
      2 * UPPER_ARM * FOREARM * Math.cos(rad(elbowDeg)),
  );
}

function elbowBetween(shoulder, wrist, preferLowX) {
  const d = len(sub(wrist, shoulder));
  const a = (UPPER_ARM ** 2 - FOREARM ** 2 + d ** 2) / (2 * d);
  const h = Math.sqrt(Math.max(0, UPPER_ARM ** 2 - a ** 2));
  const dir = scale(sub(wrist, shoulder), 1 / d);
  const mid = add(shoulder, scale(dir, a));
  const perp = { x: -dir.y, y: dir.x };
  const one = add(mid, scale(perp, h));
  const two = add(mid, scale(perp, -h));
  return one.x < two.x === preferLowX ? one : two;
}

function plankSide({ elbow, sag = 0, x = 0, lean = 6 }) {
  const ankle = { x, y: 0.08 };
  const d = shoulderToWrist(elbow);
  const shoulderY = 0.03 + d * Math.cos(rad(lean));
  const pitch = Math.asin(Math.min(0.95, (shoulderY - ankle.y) / BODY));
  const along = { x: Math.cos(pitch), y: Math.sin(pitch) };
  const shoulder = add(ankle, scale(along, BODY));
  const wrist = { x: shoulder.x + d * Math.sin(rad(lean)), y: 0.03 };
  const elbowPt = elbowBetween(shoulder, wrist, true);
  const down = { x: along.y, y: -along.x };
  const hip = add(add(ankle, scale(along, HIP_FROM_ANKLE)), scale(down, sag));
  const knee = scale(add(ankle, hip), 0.5);
  const headDir = { x: Math.cos(pitch - 0.15), y: Math.sin(pitch - 0.15) };
  const nose = add(shoulder, scale(headDir, 0.24));
  return { shoulder, elbow: elbowPt, wrist, hip, knee, ankle, nose };
}

function standSide({ elbow, x = 0, swing = 0, stride = 0, bow = 2, side = 1 }) {
  const hip = { x, y: 0.95 };
  const shoulder = {
    x: x + 0.5 * Math.sin(rad(bow)),
    y: 0.95 + 0.5 * Math.cos(rad(bow)),
  };
  const armSwing = rad(swing * side);
  const upper = { x: Math.sin(armSwing), y: -Math.cos(armSwing) };
  const elbowPt = add(shoulder, scale(upper, UPPER_ARM));
  const bend = Math.PI - rad(elbow);
  const fore = {
    x: Math.sin(armSwing + bend),
    y: -Math.cos(armSwing + bend),
  };
  const wrist = add(elbowPt, scale(fore, FOREARM));
  const leg = rad(stride * side);
  const knee = add(hip, { x: Math.sin(leg) * 0.45, y: -Math.cos(leg) * 0.45 });
  const ankle = add(knee, { x: Math.sin(leg * 0.5) * 0.45, y: -0.45 });
  const nose = add(shoulder, {
    x: 0.2 * Math.sin(rad(bow)) + 0.08,
    y: 0.2 * Math.cos(rad(bow)),
  });
  return { shoulder, elbow: elbowPt, wrist, hip, knee, ankle, nose };
}

const IDX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
};

function skeleton(body) {
  const sides = {};
  for (const [name, sign] of [
    ["left", 1],
    ["right", -1],
  ]) {
    const flat =
      body.pose === "stand"
        ? standSide({ ...body, side: sign })
        : plankSide(body);
    sides[name] = { flat, sign };
  }
  const points = new Array(33);
  for (const [name, { flat, sign }] of Object.entries(sides)) {
    for (const [joint, i] of Object.entries(IDX[name])) {
      points[i] = {
        x: flat[joint].x,
        y: flat[joint].y,
        z: sign * HALF_WIDTH[joint],
        near: sign > 0,
        arm: joint === "elbow" || joint === "wrist",
      };
    }
  }
  const nose = sides.left.flat.nose;
  for (let i = 0; i <= 10; i += 1)
    points[i] = {
      x: nose.x - 0.02 * (i % 3),
      y: nose.y + 0.01 * (i % 4),
      z: (i % 2 ? -1 : 1) * 0.04 * Math.ceil(i / 2),
      near: i % 2 === 0,
    };
  for (const [i, from] of [
    [17, 15],
    [19, 15],
    [21, 15],
    [18, 16],
    [20, 16],
    [22, 16],
    [29, 27],
    [31, 27],
    [30, 28],
    [32, 28],
  ])
    points[i] = { ...points[from], x: points[from].x + 0.05, arm: false };
  return points;
}

export function makeCamera({
  seed = 1,
  noise = 0.012,
  farNoise = 0.025,
  screenNoise = 0.003,
  rollDeg = 0,
  shake = 0,
  outlierRate = 0.004,
  nearVisibility = 0.96,
  farVisibility = 0.72,
} = {}) {
  const random = rng(seed * 7919 + 13);
  return function render(body) {
    if (!body) return { landmarks: null, worldLandmarks: null };
    const points = skeleton(body);
    const roll = rad(rollDeg * gauss(random));
    const dx = shake * gauss(random);
    const dy = shake * gauss(random);
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const hips = scale(add(points[23], points[24]), 0.5);
    const world = [];
    const screen = [];
    for (const p of points) {
      const sigma = p.near ? noise : farNoise;
      let jx = gauss(random) * sigma;
      let jy = gauss(random) * sigma;
      let jz = gauss(random) * sigma * 2;
      if (p.arm && random() < outlierRate) {
        jx += (random() - 0.5) * 0.3;
        jy += (random() - 0.5) * 0.3;
      }
      const wx = p.x - hips.x + jx;
      const wy = -(p.y - hips.y) + jy;
      world.push({
        x: wx * cos - wy * sin,
        y: wx * sin + wy * cos,
        z: p.z + jz,
      });
      const sx0 = (p.x - CAMERA_X) / VIEW_W;
      const sy0 = -(p.y - CAMERA_Y) / VIEW_H;
      const sx = 0.5 + sx0 * cos - sy0 * sin + dx + gauss(random) * screenNoise;
      const sy = 0.5 + sx0 * sin + sy0 * cos + dy + gauss(random) * screenNoise;
      const inside = sx > -0.02 && sx < 1.02 && sy > -0.02 && sy < 1.02;
      const base =
        body.visibility?.(p) ?? (p.near ? nearVisibility : farVisibility);
      const visibility = inside
        ? Math.min(1, Math.max(0, base + gauss(random) * 0.04))
        : 0.05;
      screen.push({ x: sx, y: sy, z: p.z, visibility });
    }
    return { landmarks: screen, worldLandmarks: world };
  };
}
