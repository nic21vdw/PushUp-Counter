import test from "node:test";
import assert from "node:assert/strict";

import {
  RepCounter,
  STATE,
  DEFAULT_OPTIONS,
  gradeFor,
  scoreRep,
} from "../public/js/rep-counter.js";

/**
 * Feed a sequence of elbow angles, one every `stepMs`, starting at t=1000.
 *
 * `stepMs` defaults to a 30 fps camera, because how many samples a rep is made
 * of is the whole question here — a sequence written at ten frames a second
 * proves nothing about a rep that is over in half a second.
 *
 * Returns the final frame's result, plus `completions`: how many frames in the
 * run reported `repCompleted`. A rep closes on the frame where it is recognised,
 * which is usually not the last frame of the run.
 */
function feed(
  counter,
  angles,
  { stepMs = 33, plankAngle = 175, startAt = 1000 } = {},
) {
  let last;
  let completions = 0;
  angles.forEach((elbowAngle, i) => {
    last = counter.update({
      elbowAngle,
      plankAngle,
      timestamp: startAt + i * stepMs,
    });
    if (last.repCompleted) completions += 1;
  });
  return { ...last, completions };
}

/**
 * One rep as a cosine from the top, down to `bottom`, and back to the top.
 * Starting and ending at the top means reps concatenate into a set.
 */
function repAngles({ top = 170, bottom = 78, frames = 25 } = {}) {
  const angles = [];
  for (let i = 0; i < frames; i++) {
    const phase = (i / (frames - 1)) * 2 * Math.PI;
    angles.push(top - ((top - bottom) * (1 - Math.cos(phase))) / 2);
  }
  return angles;
}

const times = (n, angles) => Array.from({ length: n }, () => angles).flat();

/** A controlled rep: ~790 ms at 30 fps, full range. */
const REP = repAngles();

/**
 * What a fast set actually looks like: quick, and stopping well short of a
 * lockout because nobody straightens their arms fully at that cadence.
 */
const FAST_REP = repAngles({ top: 145, bottom: 82, frames: 13 });

test("counts a single clean rep on the way up", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, REP);
  assert.equal(result.reps, 1);
  assert.equal(result.completions, 1);
  assert.equal(result.state, STATE.UP);
});

test("counts each rep in a set of five, signalling completion exactly once each", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, times(5, REP));
  assert.equal(result.reps, 5);
  assert.equal(result.completions, 5);
});

test("counts a fast set that never reaches a lockout", () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Four reps at ~400 ms each, then a final one finished off at the top.
  const result = feed(counter, [
    ...times(4, FAST_REP),
    ...repAngles({ frames: 13 }),
  ]);
  assert.equal(result.reps, 5, "speeding up must not cost you push-ups");
  assert.equal(result.completions, 5, "and must not double-count them either");
});

test("a rep is banked when you turn around, not only when you lock out", () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Up to 140 — short of the 155 up threshold — then straight back down.
  const result = feed(
    counter,
    [170, 140, 100, 80, 80, 90, 120, 138, 140, 140, 125, 110],
  );
  assert.equal(result.reps, 1);
});

test("upTolerance=0 restores a strict full lockout", () => {
  const counter = new RepCounter({ smoothing: 1, upTolerance: 0 });
  const result = feed(
    counter,
    [170, 140, 100, 80, 80, 90, 120, 138, 140, 140, 125, 110],
  );
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.DOWN);
});

test("does not count a partial rep that never reaches depth", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 160, 145, 130, 125, 130, 150, 170]);
  assert.equal(result.reps, 0);
});

test("does not count a descent that never comes back near the top", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 140, 100, 80, 80, 90, 110, 120, 118, 110]);
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.DOWN);
});

test("jitter around a single threshold does not produce phantom reps", () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Oscillating right at the down threshold, never extending to the up threshold.
  const angles = [];
  for (let i = 0; i < 40; i++) angles.push(i % 2 === 0 ? 98 : 104);
  const result = feed(counter, angles);
  assert.equal(result.reps, 0);
});

test("reps faster than minRepMs apart are rejected", () => {
  const counter = new RepCounter({ smoothing: 1, minRepMs: 4000 });
  const result = feed(counter, times(2, REP));
  assert.equal(result.reps, 1);
});

test("a bottom phase shorter than minPhaseMs is rejected", () => {
  const counter = new RepCounter({ smoothing: 1, minPhaseMs: 500 });
  // Single frame at the bottom, 100 ms per frame.
  const result = feed(counter, [170, 80, 170], { stepMs: 100 });
  assert.equal(result.reps, 0);
});

test("sagging hips block the rep while requirePlank is on", () => {
  const counter = new RepCounter({ smoothing: 1, minPlankAngle: 140 });
  const result = feed(counter, REP, { plankAngle: 110 });
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.UNKNOWN);
});

test("a momentary wobble in form does not throw the rep away", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const half = REP.length >> 1;
  let completions = 0;
  REP.forEach((elbowAngle, i) => {
    // Hips dip out of plank for two frames at the bottom, which at speed is a
    // measurement wobble rather than a collapse.
    const plankAngle = i === half || i === half + 1 ? 120 : 175;
    const result = counter.update({
      elbowAngle,
      plankAngle,
      timestamp: 1000 + i * 33,
    });
    if (result.repCompleted) completions += 1;
  });
  assert.equal(completions, 1);
});

test("sagging hips are ignored when requirePlank is off", () => {
  const counter = new RepCounter({ smoothing: 1, requirePlank: false });
  const result = feed(counter, REP, { plankAngle: 110 });
  assert.equal(result.reps, 1);
});

test("an unmeasurable plank angle does not block counting", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, REP, { plankAngle: null });
  assert.equal(result.reps, 1);
});

test("a frame or two of motion blur does not cost you the rep", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const half = REP.length >> 1;
  let completions = 0;
  REP.forEach((elbowAngle, i) => {
    // The two blurriest frames are the ones at the bottom of a quick rep.
    const angle = i === half || i === half + 1 ? null : elbowAngle;
    const result = counter.update({
      elbowAngle: angle,
      plankAngle: 175,
      timestamp: 1000 + i * 33,
    });
    if (result.repCompleted) completions += 1;
  });
  assert.equal(completions, 1);
});

test("leaving frame for longer than maxGapMs does abandon the rep", () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, [170, 140, 100, 80]);
  const lost = counter.update({
    elbowAngle: null,
    plankAngle: null,
    timestamp: 5000,
  });
  assert.equal(lost.state, STATE.NO_POSE);
  assert.equal(lost.reps, 0);

  const after = feed(counter, REP, { startAt: 6000 });
  assert.equal(after.reps, 1);
});

test("records the depth actually reached at the bottom", () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, repAngles({ bottom: 78 }));
  assert.equal(result.reps, 1);
  assert.ok(
    Math.abs(result.lastRepDepth - 78) < 2,
    `depth ${result.lastRepDepth} should be within a frame of the real bottom`,
  );
});

test("one bad frame cannot start or finish a rep", () => {
  const counter = new RepCounter();
  // A mis-detected limb reading 20 degrees in the middle of the top position.
  const result = feed(counter, [170, 170, 170, 20, 170, 170, 170]);
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.UP);
});

test("reset clears the count, resetPhase keeps it", () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, REP);
  assert.equal(counter.reps, 1);

  counter.resetPhase();
  assert.equal(counter.reps, 1);
  assert.equal(counter.state, STATE.UNKNOWN);

  counter.reset();
  assert.equal(counter.reps, 0);
  assert.equal(counter.state, STATE.NO_POSE);
});

test("thresholds can be retuned mid-session without losing reps", () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, REP);
  counter.configure({ downAngle: 70 });
  // 78 degrees no longer counts as depth under the tighter threshold.
  const result = feed(counter, REP, { startAt: 10000 });
  assert.equal(result.reps, 1);
});

/** Run an angle sequence through a counter and collect every `rep` it hands back. */
function repsFrom(
  angles,
  { stepMs = 33, plankAngle = 175, options = {} } = {},
) {
  const counter = new RepCounter({ smoothing: 1, ...options });
  const reps = [];
  const quiet = [];
  angles.forEach((elbowAngle, i) => {
    const result = counter.update({
      elbowAngle,
      plankAngle,
      timestamp: 1000 + i * stepMs,
    });
    if (result.rep) reps.push(result.rep);
    else quiet.push(result.rep);
  });
  return { reps, quiet };
}

function seeded(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () =>
    Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

/**
 * A set of quick reps as a sine wave, with Gaussian noise on every sample and
 * the occasional single-frame glitch that a mis-detected limb produces.
 */
function noisySet({ reps, periodMs, sigma, spikeRate, seed, fps = 30 }) {
  const { uniform, gauss } = seeded(seed);
  const stepMs = 1000 / fps;
  const lead = 8;
  const total = Math.round((reps * periodMs) / stepMs) + lead * 2;
  const samples = [];
  for (let i = 0; i < total; i++) {
    const t = (i - lead) * stepMs;
    const inSet = t > 0 && t < reps * periodMs;
    const clean = inSet
      ? 168 - (88 * (1 - Math.cos((2 * Math.PI * t) / periodMs))) / 2
      : 168;
    let elbowAngle = clean + sigma * gauss();
    if (uniform() < spikeRate) elbowAngle = uniform() < 0.5 ? 20 : 175;
    samples.push({ elbowAngle, timestamp: 1000 + i * stepMs });
  }
  return samples;
}

function countSet(samples, options = {}) {
  const counter = new RepCounter(options);
  let completions = 0;
  for (const { elbowAngle, timestamp } of samples) {
    const result = counter.update({ elbowAngle, plankAngle: 175, timestamp });
    if (result.repCompleted) completions += 1;
  }
  return completions;
}

test("a completed rep carries depth, top, duration, score and grade; every other frame carries null", () => {
  const { reps, quiet } = repsFrom([
    ...Array(5).fill(170),
    ...repAngles({ bottom: 78 }),
  ]);
  assert.equal(reps.length, 1);
  assert.deepEqual(Object.keys(reps[0]).sort(), [
    "depth",
    "durationMs",
    "grade",
    "score",
    "top",
  ]);
  assert.ok(Math.abs(reps[0].depth - 78) < 2);
  assert.ok(Math.abs(reps[0].top - 170) < 1);
  assert.ok(reps[0].durationMs > 400 && reps[0].durationMs < 800);
  assert.ok(reps[0].score >= 0 && reps[0].score <= 100);
  assert.ok(["perfect", "great", "good", "sloppy"].includes(reps[0].grade));
  assert.ok(quiet.length > 0 && quiet.every((rep) => rep === null));
});

test("lastRepDepth and lastRepTop agree with the rep object", () => {
  const counter = new RepCounter({ smoothing: 1 });
  let rep = null;
  repAngles().forEach((elbowAngle, i) => {
    const result = counter.update({
      elbowAngle,
      plankAngle: 175,
      timestamp: 1000 + i * 33,
    });
    if (result.rep) rep = result.rep;
  });
  assert.equal(counter.lastRepDepth, rep.depth);
  assert.equal(counter.lastRepTop, rep.top);
});

test("a deep, locked-out, straight, controlled rep is perfect", () => {
  const { reps } = repsFrom(repAngles({ bottom: 64, frames: 60 }));
  assert.equal(reps[0].grade, "perfect");
  assert.ok(reps[0].score >= 90);
});

test("a shallow rep that only just counts scores below a deep one", () => {
  const deep = repsFrom(repAngles({ bottom: 66, frames: 60 })).reps[0];
  const shallow = repsFrom(repAngles({ bottom: 97, frames: 60 })).reps[0];
  assert.ok(shallow.score < deep.score - 15);
  assert.notEqual(shallow.grade, "perfect");
});

test("sagging hips cost score without stopping the rep", () => {
  const angles = repAngles({ bottom: 66, frames: 60 });
  const straight = repsFrom(angles, { plankAngle: 175 }).reps[0];
  const sagging = repsFrom(angles, { plankAngle: 146 }).reps[0];
  assert.ok(sagging.score < straight.score - 8);
});

test("an unmeasurable plank costs nothing", () => {
  const angles = repAngles({ bottom: 66, frames: 60 });
  const unknown = repsFrom(angles, { plankAngle: null }).reps[0];
  const straight = repsFrom(angles, { plankAngle: 175 }).reps[0];
  assert.equal(unknown.score, straight.score);
});

test("a bounce scores below the same rep done under control", () => {
  const slow = repsFrom(repAngles({ bottom: 66, frames: 60 })).reps[0];
  const bounce = repsFrom(repAngles({ bottom: 66, frames: 14 })).reps[0];
  assert.ok(bounce.durationMs < slow.durationMs);
  assert.ok(bounce.score < slow.score - 6);
});

test("a rep that never locks out loses lockout points", () => {
  const set = [
    ...times(4, repAngles({ top: 140, bottom: 70, frames: 40 })),
    ...repAngles({ top: 170, bottom: 70, frames: 40 }),
  ];
  const { reps } = repsFrom(set);
  assert.equal(reps.length, 5);
  assert.ok(reps[1].top < 150);
  assert.ok(reps[1].score < reps[4].score);
});

test("each rep in a set carries its own rep object", () => {
  const { reps } = repsFrom(times(3, repAngles({ bottom: 70, frames: 40 })));
  assert.equal(reps.length, 3);
  assert.ok(reps.every((rep) => rep.durationMs > 700 && rep.durationMs < 1400));
});

test("durationMs measures the rep and not the pause at the top before it", () => {
  const pause = Array(90).fill(170);
  const { reps } = repsFrom([
    ...pause,
    ...repAngles({ bottom: 70, frames: 40 }),
  ]);
  assert.equal(reps.length, 1);
  assert.ok(reps[0].durationMs < 1300, `got ${reps[0].durationMs}`);
});

test("scoreRep gives full marks to a textbook rep", () => {
  const result = scoreRep({
    depth: 68,
    top: 172,
    durationMs: 1800,
    plank: 175,
  });
  assert.equal(result.score, 100);
  assert.equal(result.grade, "perfect");
});

test("scoreRep: 70 degrees is full depth, downAngle is weak, in between is linear", () => {
  const at = (depth) =>
    scoreRep({ depth, top: 172, durationMs: 1800, plank: 175 }).parts.depth;
  assert.equal(at(70), 1);
  assert.equal(at(50), 1);
  assert.ok(Math.abs(at(DEFAULT_OPTIONS.downAngle) - 0.2) < 1e-9);
  assert.ok(Math.abs(at(85) - 0.6) < 1e-9);
  assert.ok(at(80) > at(90));
});

test("scoreRep: lockout, plank and tempo each move the score the right way", () => {
  const base = { depth: 68, top: 172, durationMs: 1800, plank: 175 };
  const score = (patch) => scoreRep({ ...base, ...patch }).score;
  assert.ok(score({ top: 150 }) < score({ top: 165 }));
  assert.equal(score({ top: 165 }), score({ top: 180 }));
  assert.ok(score({ plank: 145 }) < score({ plank: 160 }));
  assert.equal(score({ plank: 165 }), score({ plank: 180 }));
  assert.ok(score({ durationMs: 300 }) < score({ durationMs: 700 }));
  assert.equal(score({ durationMs: 1000 }), score({ durationMs: 4000 }));
});

test("scoreRep follows a retuned downAngle", () => {
  const rep = { depth: 100, top: 172, durationMs: 1800, plank: 175 };
  const strict = scoreRep(rep, { ...DEFAULT_OPTIONS, downAngle: 100 });
  const loose = scoreRep(rep, { ...DEFAULT_OPTIONS, downAngle: 120 });
  assert.ok(loose.score > strict.score);
});

test("grades switch at 90, 75 and 55", () => {
  assert.equal(gradeFor(100), "perfect");
  assert.equal(gradeFor(90), "perfect");
  assert.equal(gradeFor(89), "great");
  assert.equal(gradeFor(75), "great");
  assert.equal(gradeFor(74), "good");
  assert.equal(gradeFor(55), "good");
  assert.equal(gradeFor(54), "sloppy");
  assert.equal(gradeFor(0), "sloppy");
});

test("a glitched first frame after acquiring the pose cannot start a rep", () => {
  for (const lead of [[20], [175, 20], [20, 170]]) {
    const counter = new RepCounter();
    const result = feed(counter, [...lead, ...Array(30).fill(170)]);
    assert.equal(result.reps, 0, `lead ${lead} started a rep from nothing`);
  }
});

test("pose reacquired after a long loss does not start a rep from a glitch either", () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, REP);
  counter.update({ elbowAngle: null, plankAngle: null, timestamp: 9000 });
  const result = feed(counter, [20, 170, 170, 170, 170, 170], {
    startAt: 10000,
  });
  assert.equal(result.reps, 1);
});

test("a noisy set of fast reps is counted exactly, seed after seed", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const samples = noisySet({
      reps: 12,
      periodMs: 450,
      sigma: 4,
      spikeRate: 0.01,
      seed,
    });
    assert.equal(countSet(samples), 12, `seed ${seed}`);
  }
});

test("a slower noisy set is counted exactly too", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const samples = noisySet({
      reps: 8,
      periodMs: 900,
      sigma: 5,
      spikeRate: 0.01,
      seed,
    });
    assert.equal(countSet(samples), 8, `seed ${seed}`);
  }
});

test("a noisy fast set stays exact on a 60 fps camera as well", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const samples = noisySet({
      reps: 12,
      periodMs: 400,
      sigma: 4,
      spikeRate: 0.01,
      seed,
      fps: 60,
    });
    assert.equal(countSet(samples), 12, `seed ${seed}`);
  }
});

test("noise at the top of the range with no movement never makes a rep", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const samples = noisySet({
      reps: 0,
      periodMs: 450,
      sigma: 5,
      spikeRate: 0.01,
      seed,
    });
    assert.equal(countSet(samples), 0, `seed ${seed}`);
  }
});

test("a steady set is still exact at 10 samples a second, a throttled window's rate", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const samples = noisySet({
      reps: 10,
      periodMs: 1000,
      sigma: 4,
      spikeRate: 0.01,
      seed,
      fps: 10,
    });
    assert.equal(countSet(samples), 10, `seed ${seed}`);
  }
});

const hold = (angle, frames) => Array(frames).fill(angle);

test("arms that read a little short of lockout count once they settle at the top, not on the next rep", () => {
  const counter = new RepCounter();
  const shortTop = repAngles({ top: 152, bottom: 50, frames: 40 });
  const run = feed(counter, [...hold(152, 10), ...shortTop, ...hold(152, 12)]);
  assert.equal(run.completions, 1);
  assert.equal(counter.reps, 1);
  assert.ok(
    counter.lastRepAt - (1000 + (10 + shortTop.length) * 33) < 400,
    "banked within a moment of reaching the top",
  );
});

test("the last rep of a set is banked even when you stand up straight after it", () => {
  const counter = new RepCounter();
  const shortTop = repAngles({ top: 151, bottom: 48, frames: 40 });
  const set = [...hold(151, 10), ...times(3, [...shortTop, ...hold(151, 10)])];
  const standing = set.length;
  let completions = feed(counter, set).completions;
  completions += feed(counter, hold(160, 30), {
    plankAngle: 110,
    startAt: 1000 + standing * 33,
  }).completions;
  assert.equal(completions, 3);
});

test("a pause near the top counts the rep once, and finishing the lockout adds nothing", () => {
  const counter = new RepCounter();
  const down = repAngles({ top: 170, bottom: 60, frames: 40 }).slice(0, 20);
  const up = [80, 100, 120, 140, 145, ...hold(146, 12), 155, 165, 170];
  const run = feed(counter, [
    ...hold(170, 8),
    ...down,
    ...up,
    ...hold(170, 10),
  ]);
  assert.equal(run.completions, 1);
});

test("sitting at the bottom never counts as holding the top", () => {
  const counter = new RepCounter();
  const down = repAngles({ top: 170, bottom: 60, frames: 40 }).slice(0, 20);
  const run = feed(counter, [...hold(170, 8), ...down, ...hold(62, 60)]);
  assert.equal(run.completions, 0);
});

test("a half rep that stalls below the top band does not count", () => {
  const counter = new RepCounter();
  const down = repAngles({ top: 170, bottom: 60, frames: 40 }).slice(0, 20);
  const run = feed(counter, [
    ...hold(170, 8),
    ...down,
    90,
    105,
    115,
    120,
    ...hold(122, 40),
  ]);
  assert.equal(run.completions, 0);
});
