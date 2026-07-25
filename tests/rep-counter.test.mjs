import test from 'node:test';
import assert from 'node:assert/strict';

import { RepCounter, STATE } from '../public/js/rep-counter.js';

/**
 * Feed a sequence of elbow angles, one every `stepMs`, starting at t=1000.
 *
 * Returns the final frame's result, plus `completions`: how many frames in the
 * run reported `repCompleted`. A rep closes on the frame where the angle first
 * crosses the up threshold, which is usually not the last frame of the run.
 */
function feed(counter, angles, { stepMs = 100, plankAngle = 175, startAt = 1000 } = {}) {
  let last;
  let completions = 0;
  angles.forEach((elbowAngle, i) => {
    last = counter.update({ elbowAngle, plankAngle, timestamp: startAt + i * stepMs });
    if (last.repCompleted) completions += 1;
  });
  return { ...last, completions };
}

/** One clean rep: extended -> bent -> extended. */
const REP = [170, 160, 140, 120, 100, 85, 80, 85, 110, 140, 160, 170];

test('counts a single clean rep on the way up', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, REP);
  assert.equal(result.reps, 1);
  assert.equal(result.completions, 1);
  assert.equal(result.state, STATE.UP);
});

test('counts each rep in a set of five, signalling completion exactly once each', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const angles = [];
  for (let i = 0; i < 5; i++) angles.push(...REP);
  const result = feed(counter, angles);
  assert.equal(result.reps, 5);
  assert.equal(result.completions, 5);
});

test('does not count a partial rep that never reaches depth', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 160, 145, 130, 125, 130, 150, 170]);
  assert.equal(result.reps, 0);
});

test('does not count a descent that never returns to the top', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 140, 100, 80, 80, 90, 120, 140, 150]);
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
  const counter = new RepCounter({ smoothing: 1, minRepMs: 2000 });
  const result = feed(counter, [...REP, ...REP]);
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

test('losing the pose mid-rep does not count it, and recovery still works', () => {
  const counter = new RepCounter({ smoothing: 1 });
  feed(counter, [170, 140, 100, 80]);
  const lost = counter.update({ elbowAngle: null, plankAngle: null, timestamp: 2000 });
  assert.equal(lost.state, STATE.NO_POSE);
  assert.equal(lost.reps, 0);

  const after = feed(counter, REP, { startAt: 3000 });
  assert.equal(after.reps, 1);
});

test('records the depth actually reached at the bottom', () => {
  const counter = new RepCounter({ smoothing: 1 });
  const result = feed(counter, [170, 120, 78, 95, 170]);
  assert.equal(result.reps, 1);
  assert.equal(result.lastRepDepth, 78);
});

test('smoothing damps a single-frame spike', () => {
  const counter = new RepCounter({ smoothing: 0.3 });
  // One bogus frame reading 20 degrees in the middle of the top position.
  const result = feed(counter, [170, 170, 170, 20, 170, 170, 170]);
  assert.equal(result.reps, 0);
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
  // 80 degrees no longer counts as depth under the tighter threshold.
  const result = feed(counter, REP, { startAt: 10000 });
  assert.equal(result.reps, 1);
});
