export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(random) {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function buildSet({
  reps = 10,
  fps = 30,
  repMs = 1200,
  top = 168,
  bottom = 78,
  restMs = 400,
  bottomHoldMs = 0,
  noiseDeg = 3,
  plank = 172,
  seed = 1,
  jitterFps = 0,
  paceJitter = 0,
} = {}) {
  const random = rng(seed);
  const frames = [];
  let t = 1000;
  const step = () => {
    const base = 1000 / fps;
    t += Math.max(4, base + (jitterFps ? gauss(random) * jitterFps : 0));
  };
  const push = (angle, phase, rep) =>
    frames.push({
      t,
      elbow: angle + gauss(random) * noiseDeg,
      plank: plank + gauss(random) * 2,
      phase,
      rep,
    });

  for (let end = t + restMs; t < end; step()) push(top, "top", -1);
  for (let r = 0; r < reps; r += 1) {
    const dur = repMs * (1 + (paceJitter ? (random() - 0.5) * paceJitter : 0));
    const half = dur / 2;
    const start = t;
    for (; t < start + half; step()) {
      const k = (t - start) / half;
      push(top - ((top - bottom) * (1 - Math.cos(k * Math.PI))) / 2, "down", r);
    }
    for (const holdEnd = t + bottomHoldMs; t < holdEnd; step())
      push(bottom, "bottom", r);
    const upStart = t;
    for (; t < upStart + half; step()) {
      const k = (t - upStart) / half;
      push(
        bottom + ((top - bottom) * (1 - Math.cos(k * Math.PI))) / 2,
        "up",
        r,
      );
    }
    for (const restEnd = t + restMs; t < restEnd; step()) push(top, "top", r);
  }
  return frames;
}

export function dropWindow(frames, predicate) {
  return frames.map((f) => (predicate(f) ? { ...f, elbow: null } : f));
}

export function stall(frames, predicate) {
  return frames.filter((f) => !predicate(f));
}

export function run(counter, frames) {
  let completions = 0;
  let last = null;
  for (const f of frames) {
    last = counter.update({
      elbowAngle: f.elbow,
      plankAngle: f.plank,
      timestamp: f.t,
    });
    if (last.repCompleted) completions += 1;
  }
  return { completions, last };
}
