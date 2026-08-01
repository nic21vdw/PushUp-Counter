/**
 * The advice the tracker gives when it can see you but will not count you.
 *
 * Advice that is wrong is worse than none: being told to move back while you
 * are already at the wall costs a set. So each judgement below is pinned to a
 * pose built out of coordinates, and the ordering is pinned too — when two
 * things are wrong at once, the one you should act on first has to win.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkFraming, FRAMING } from '../public/js/framing.js';
import { LM } from '../public/js/pose-math.js';

/**
 * Build a 33-point landmark array from named joints.
 * Anything not named is absent, which is what an unseen joint looks like.
 */
function pose(points, visibility = 1) {
  const landmarks = new Array(33).fill(null);
  for (const [index, [x, y]] of Object.entries(points)) {
    landmarks[index] = { x, y, visibility };
  }
  return landmarks;
}

/**
 * A well-framed push-up: side-on, horizontal, filling a bit over half the
 * frame, everything comfortably inside the edges.
 */
function goodPose(overrides = {}) {
  return pose({
    [LM.LEFT_SHOULDER]: [0.3, 0.45],
    // Side-on: the far shoulder sits almost behind the near one.
    [LM.RIGHT_SHOULDER]: [0.32, 0.46],
    [LM.LEFT_ELBOW]: [0.26, 0.58],
    [LM.RIGHT_ELBOW]: [0.28, 0.59],
    [LM.LEFT_WRIST]: [0.24, 0.72],
    [LM.RIGHT_WRIST]: [0.26, 0.73],
    [LM.LEFT_HIP]: [0.72, 0.5],
    [LM.RIGHT_HIP]: [0.73, 0.51],
    ...overrides,
  });
}

test('a well-framed push-up is told nothing at all', () => {
  const verdict = checkFraming(goodPose());

  assert.equal(verdict.code, FRAMING.OK);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.message, '', 'advice you do not need is noise on the screen');
});

test('an empty frame asks you to step into it', () => {
  for (const nothing of [null, undefined, [], pose({})]) {
    assert.equal(checkFraming(nothing).code, FRAMING.NO_POSE);
  }
});

test('a body the detector can barely see is not treated as a body', () => {
  const barely = goodPose();
  const verdict = checkFraming(pose(
    Object.fromEntries(barely.map((p, i) => (p ? [i, [p.x, p.y]] : null)).filter(Boolean)),
    0.2,
  ));

  assert.equal(verdict.code, FRAMING.NO_POSE, 'invisible joints are missing joints');
});

test('too small to measure asks you to come closer', () => {
  const far = pose({
    [LM.LEFT_SHOULDER]: [0.47, 0.48],
    [LM.RIGHT_SHOULDER]: [0.475, 0.485],
    [LM.LEFT_ELBOW]: [0.46, 0.5],
    [LM.RIGHT_ELBOW]: [0.465, 0.505],
    [LM.LEFT_WRIST]: [0.45, 0.52],
    [LM.RIGHT_WRIST]: [0.455, 0.525],
    [LM.LEFT_HIP]: [0.52, 0.5],
    [LM.RIGHT_HIP]: [0.525, 0.505],
  });

  const verdict = checkFraming(far);
  assert.equal(verdict.code, FRAMING.TOO_FAR);
  assert.match(verdict.message, /closer/i);
});

test('filling the frame asks you to move back', () => {
  const close = pose({
    [LM.LEFT_SHOULDER]: [0.01, 0.4],
    [LM.RIGHT_SHOULDER]: [0.02, 0.42],
    [LM.LEFT_ELBOW]: [0.4, 0.6],
    [LM.RIGHT_ELBOW]: [0.42, 0.62],
    [LM.LEFT_WRIST]: [0.6, 0.8],
    [LM.RIGHT_WRIST]: [0.62, 0.82],
    [LM.LEFT_HIP]: [0.99, 0.45],
    [LM.RIGHT_HIP]: [0.98, 0.46],
  });

  const verdict = checkFraming(close);
  assert.equal(verdict.code, FRAMING.TOO_CLOSE);
  assert.match(verdict.message, /back/i);
});

test('being cut off names the side, because that is the part you can act on', () => {
  const offLeft = checkFraming(goodPose({ [LM.LEFT_WRIST]: [0.005, 0.72] }));
  assert.equal(offLeft.code, FRAMING.CROPPED);
  assert.match(offLeft.message, /left.*shift right/i);

  const offRight = checkFraming(goodPose({ [LM.LEFT_HIP]: [0.995, 0.5] }));
  assert.equal(offRight.code, FRAMING.CROPPED);
  assert.match(offRight.message, /right.*shift left/i);

  const offBottom = checkFraming(goodPose({ [LM.LEFT_WRIST]: [0.24, 0.995] }));
  assert.equal(offBottom.code, FRAMING.CROPPED);
  assert.match(offBottom.message, /bottom|down/i);
});

test('cut off wins over every measurement taken on the part still showing', () => {
  // Small *and* running off the left edge. The span reading is meaningless on a
  // body that continues past the frame, so the crop is what gets said.
  const both = pose({
    [LM.LEFT_SHOULDER]: [0.01, 0.5],
    [LM.RIGHT_SHOULDER]: [0.015, 0.505],
    [LM.LEFT_ELBOW]: [0.05, 0.52],
    [LM.RIGHT_ELBOW]: [0.055, 0.525],
    [LM.LEFT_WRIST]: [0.08, 0.54],
    [LM.RIGHT_WRIST]: [0.085, 0.545],
    [LM.LEFT_HIP]: [0.2, 0.5],
    [LM.RIGHT_HIP]: [0.205, 0.505],
  });

  assert.equal(checkFraming(both).code, FRAMING.CROPPED);
});

test('hidden arms are called out, because the elbow is the whole measurement', () => {
  const noArms = pose({
    [LM.LEFT_SHOULDER]: [0.3, 0.42],
    [LM.RIGHT_SHOULDER]: [0.32, 0.43],
    [LM.LEFT_HIP]: [0.7, 0.5],
    [LM.RIGHT_HIP]: [0.72, 0.51],
  });

  const verdict = checkFraming(noArms);
  assert.equal(verdict.code, FRAMING.ARMS_HIDDEN);
  assert.match(verdict.message, /arms/i);
});

test('standing up is told there is no push-up to find', () => {
  const upright = pose({
    [LM.LEFT_SHOULDER]: [0.48, 0.2],
    [LM.RIGHT_SHOULDER]: [0.5, 0.21],
    [LM.LEFT_ELBOW]: [0.47, 0.4],
    [LM.RIGHT_ELBOW]: [0.49, 0.41],
    [LM.LEFT_WRIST]: [0.46, 0.6],
    [LM.RIGHT_WRIST]: [0.48, 0.61],
    [LM.LEFT_HIP]: [0.49, 0.7],
    [LM.RIGHT_HIP]: [0.51, 0.71],
  });

  const verdict = checkFraming(upright);
  assert.equal(verdict.code, FRAMING.STANDING);
  assert.match(verdict.message, /plank/i);
});

test('facing the camera is asked to turn side-on', () => {
  // Shoulders a torso apart across the frame: head-on, so the elbow angle the
  // counter measures is largely guesswork.
  const faceOn = pose({
    [LM.LEFT_SHOULDER]: [0.35, 0.45],
    [LM.RIGHT_SHOULDER]: [0.65, 0.45],
    [LM.LEFT_ELBOW]: [0.3, 0.55],
    [LM.RIGHT_ELBOW]: [0.7, 0.55],
    [LM.LEFT_WRIST]: [0.28, 0.62],
    [LM.RIGHT_WRIST]: [0.72, 0.62],
    [LM.LEFT_HIP]: [0.42, 0.6],
    [LM.RIGHT_HIP]: [0.58, 0.6],
  });

  const verdict = checkFraming(faceOn);
  assert.equal(verdict.code, FRAMING.FACE_ON);
  assert.match(verdict.message, /side-on/i);
});

test('a half-sure detector is told the room is the problem, not the pose', () => {
  const murky = checkFraming(goodPose(), { minVisibility: 0.3 });
  assert.equal(murky.code, FRAMING.OK, 'the reference pose is fully visible');

  const dim = pose(
    {
      [LM.LEFT_SHOULDER]: [0.3, 0.45],
      [LM.RIGHT_SHOULDER]: [0.32, 0.46],
      [LM.LEFT_ELBOW]: [0.26, 0.58],
      [LM.RIGHT_ELBOW]: [0.28, 0.59],
      [LM.LEFT_WRIST]: [0.24, 0.72],
      [LM.RIGHT_WRIST]: [0.26, 0.73],
      [LM.LEFT_HIP]: [0.72, 0.5],
      [LM.RIGHT_HIP]: [0.73, 0.51],
    },
    0.55,
  );

  const verdict = checkFraming(dim, { minVisibility: 0.5 });
  assert.equal(verdict.code, FRAMING.UNSURE);
  assert.match(verdict.message, /light|background/i);
});

test('the thresholds can be moved without editing the rules', () => {
  const strict = checkFraming(goodPose(), { minSpan: 0.9 });
  assert.equal(strict.code, FRAMING.TOO_FAR, 'a bigger minimum makes the same pose too small');

  const loose = checkFraming(goodPose(), { maxShoulderSpread: 0 });
  assert.equal(loose.code, FRAMING.FACE_ON, 'and a zero spread makes every pose face-on');
});

test('the span is reported so the readout can show what it judged on', () => {
  const verdict = checkFraming(goodPose());
  assert.ok(verdict.span > 0.4 && verdict.span < 0.55, `span was ${verdict.span}`);
});
