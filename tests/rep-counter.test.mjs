import test from 'node:test';
import assert from 'node:assert/strict';

import { RepCounter, STATE } from '../public/js/rep-counter.js';

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
function feed(counter, angles, { stepMs = 33, plankAngle = 175, startAt = 1000 } = {}) {
  let last;
  let completions = 0;
  angles.forEach((elbowAngle, i) => {
    last = counter.update({ elbowAngle, plankAngle, timestamp: startAt + i * stepMs });
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

test('counts a single clean rep on the way up', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, REP);
  assert.equal(result.reps, 1);
  assert.equal(result.completions, 1);
  assert.equal(result.state, STATE.UP);
});

test('counts each rep in a set of five, signalling completion exactly once each', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, times(5, REP));
  assert.equal(result.reps, 5);
  assert.equal(result.completions, 5);
});

test('counts a fast set that never reaches a lockout', () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Four reps at ~400 ms each, then a final one finished off at the top.
  const result = feed(counter, [...times(4, FAST_REP), ...repAngles({ frames: 13 })]);
  assert.equal(result.reps, 5, 'speeding up must not cost you push-ups');
  assert.equal(result.completions, 5, 'and must not double-count them either');
});

test('a rep is banked when you turn around, not only when you lock out', () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Up to 140 — short of the 155 up threshold — then straight back down.
  const result = feed(counter, [170, 140, 100, 80, 80, 90, 120, 138, 140, 140, 125, 110]);
  assert.equal(result.reps, 1);
});

test('upTolerance=0 restores a strict full lockout', () => {
  const counter = new RepCounter({ smoothing: 1, upTolerance: 0 });
  const result = feed(counter, [170, 140, 100, 80, 80, 90, 120, 138, 140, 140, 125, 110]);
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.DOWN);
});

test('does not count a partial rep that never reaches depth', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 160, 145, 130, 125, 130, 150, 170]);
  assert.equal(result.reps, 0);
});

test('does not count a descent that never comes back near the top', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 140, 100, 80, 80, 90, 110, 120, 118, 110]);
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.DOWN);
});

test('jitter around a single threshold does not produce phantom reps', () => {
  const counter = new RepCounter({ smoothing: 1 });
  // Oscillating right at the down threshold, never extending to the up threshold.
  const angles = [];
  for (let i = 0; i < 40; i++) angles.push(i % 2 === 0 ? 98 : 104);
  const result = feed(counter, angles);
  assert.equal(result.reps, 0);
});

test('reps faster than minRepMs apart are rejected', () => {
  const counter = new RepCounter({ smoothing: 1, minRepMs: 4000 });
  const result = feed(counter, times(2, REP));
  assert.equal(result.reps, 1);
});

test('a bottom phase shorter than minPhaseMs is rejected', () => {
  const counter = new RepCounter({ smoothing: 1, minPhaseMs: 500 });
  // Single frame at the bottom, 100 ms per frame.
  const result = feed(counter, [170, 80, 170], { stepMs: 100 });
  assert.equal(result.reps, 0);
});

test('sagging hips block the rep while requirePlank is on', () => {
  const counter = new RepCounter({ smoothing: 1, minPlankAngle: 140 });
  const result = feed(counter, REP, { plankAngle: 110 });
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.UNKNOWN);
});

test('a momentary wobble in form does not throw the rep away', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const half = REP.length >> 1;
  let completions = 0;
  REP.forEach((elbowAngle, i) => {
    // Hips dip out of plank for two frames at the bottom, which at speed is a
    // measurement wobble rather than a collapse.
    const plankAngle = i === half || i === half + 1 ? 120 : 175;
    const result = counter.update({ elbowAngle, plankAngle, timestamp: 1000 + i * 33 });
    if (result.repCompleted) completions += 1;
  });
  assert.equal(completions, 1);
});

test('sagging hips are ignored when requirePlank is off', () => {
  const counter = new RepCounter({ smoothing: 1, requirePlank: false });
  const result = feed(counter, REP, { plankAngle: 110 });
  assert.equal(result.reps, 1);
});

test('an unmeasurable plank angle does not block counting', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, REP, { plankAngle: null });
  assert.equal(result.reps, 1);
});

test('a frame or two of motion blur does not cost you the rep', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const half = REP.length >> 1;
  let completions = 0;
  REP.forEach((elbowAngle, i) => {
    // The two blurriest frames are the ones at the bottom of a quick rep.
    const angle = i === half || i === half + 1 ? null : elbowAngle;
    const result = counter.update({ elbowAngle: angle, plankAngle: 175, timestamp: 1000 + i * 33 });
    if (result.repCompleted) completions += 1;
  });
  assert.equal(completions, 1);
});

test('leaving frame for longer than maxGapMs does abandon the rep', () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, [170, 140, 100, 80]);
  const lost = counter.update({ elbowAngle: null, plankAngle: null, timestamp: 5000 });
  assert.equal(lost.state, STATE.NO_POSE);
  assert.equal(lost.reps, 0);

  const after = feed(counter, REP, { startAt: 6000 });
  assert.equal(after.reps, 1);
});

test('records the depth actually reached at the bottom', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, repAngles({ bottom: 78 }));
  assert.equal(result.reps, 1);
  assert.ok(
    Math.abs(result.lastRepDepth - 78) < 2,
    `depth ${result.lastRepDepth} should be within a frame of the real bottom`,
  );
});

test('one bad frame cannot start or finish a rep', () => {
  const counter = new RepCounter();
  // A mis-detected limb reading 20 degrees in the middle of the top position.
  const result = feed(counter, [170, 170, 170, 20, 170, 170, 170]);
  assert.equal(result.reps, 0);
  assert.equal(result.state, STATE.UP);
});

test('reset clears the count, resetPhase keeps it', () => {
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

test('thresholds can be retuned mid-session without losing reps', () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, REP);
  counter.configure({ downAngle: 70 });
  // 78 degrees no longer counts as depth under the tighter threshold.
  const result = feed(counter, REP, { startAt: 10000 });
  assert.equal(result.reps, 1);
});
