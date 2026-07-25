import test from 'node:test';
import assert from 'node:assert/strict';

import { LM, angleDeg, allVisible, anglesFromLandmarks } from '../public/js/pose-math.js';

test('angleDeg measures the interior angle at the middle point', () => {
  const right = angleDeg({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(right - 90) < 1e-6);

  const straight = angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(straight - 180) < 1e-6);
});

test('angleDeg uses z when all three points carry it', () => {
  // Bent purely in depth: 2D projection would collapse to 180.
  const a = { x: 0, y: 0, z: 1 };
  const b = { x: 0, y: 0, z: 0 };
  const c = { x: 1, y: 0, z: 0 };
  assert.ok(Math.abs(angleDeg(a, b, c) - 90) < 1e-6);
});

test('angleDeg handles degenerate and missing input', () => {
  assert.equal(angleDeg({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
  assert.equal(angleDeg(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
});

test('allVisible enforces the visibility floor and treats missing visibility as trusted', () => {
  const landmarks = [{ visibility: 0.9 }, { visibility: 0.2 }, {}];
  assert.equal(allVisible(landmarks, [0], 0.5), true);
  assert.equal(allVisible(landmarks, [0, 1], 0.5), false);
  assert.equal(allVisible(landmarks, [0, 2], 0.5), true);
  assert.equal(allVisible(landmarks, [0, 99], 0.5), false);
});

/** Build a 33-point landmark array with every point visible at the origin. */
function blankPose(visibility = 0.9) {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }));
}

/** A pose whose arms are bent to `elbow` degrees and body held straight. */
function posedBody({ elbowBend, visibility = 0.9 }) {
  const pose = blankPose(visibility);
  const rad = (elbowBend * Math.PI) / 180;
  for (const side of ['LEFT', 'RIGHT']) {
    const sign = side === 'LEFT' ? -1 : 1;
    pose[LM[`${side}_SHOULDER`]] = { x: sign * 0.2, y: 0, z: 0, visibility };
    pose[LM[`${side}_ELBOW`]] = { x: sign * 0.2, y: 0.3, z: 0, visibility };
    // Rotate the forearm away from the upper arm by the requested bend.
    pose[LM[`${side}_WRIST`]] = {
      x: sign * 0.2 + 0.3 * Math.sin(rad),
      y: 0.3 - 0.3 * Math.cos(rad),
      z: 0,
      visibility,
    };
    // Shoulder -> hip -> knee in a straight line: a 180 degree plank.
    pose[LM[`${side}_HIP`]] = { x: sign * 0.2, y: -0.5, z: 0, visibility };
    pose[LM[`${side}_KNEE`]] = { x: sign * 0.2, y: -1.0, z: 0, visibility };
  }
  return pose;
}

test('anglesFromLandmarks recovers the elbow bend and a straight plank', () => {
  const { elbowAngle, plankAngle, sidesUsed } = anglesFromLandmarks(posedBody({ elbowBend: 90 }));
  assert.ok(Math.abs(elbowAngle - 90) < 1);
  assert.ok(Math.abs(plankAngle - 180) < 1);
  assert.deepEqual(sidesUsed, ['left', 'right']);
});

test('anglesFromLandmarks skips sides below the visibility floor', () => {
  const pose = posedBody({ elbowBend: 90 });
  pose[LM.LEFT_WRIST] = { ...pose[LM.LEFT_WRIST], visibility: 0.1 };
  const { elbowAngle, sidesUsed } = anglesFromLandmarks(pose);
  assert.deepEqual(sidesUsed, ['right']);
  assert.ok(Math.abs(elbowAngle - 90) < 1);
});

test('anglesFromLandmarks returns nulls when nothing is visible enough', () => {
  const { elbowAngle, plankAngle } = anglesFromLandmarks(posedBody({ elbowBend: 90, visibility: 0.1 }));
  assert.equal(elbowAngle, null);
  assert.equal(plankAngle, null);
});

test('anglesFromLandmarks rejects a truncated landmark array', () => {
  assert.deepEqual(anglesFromLandmarks([{ x: 0, y: 0, visibility: 1 }]), {
    elbowAngle: null,
    plankAngle: null,
    sidesUsed: [],
  });
  assert.deepEqual(anglesFromLandmarks(null), {
    elbowAngle: null,
    plankAngle: null,
    sidesUsed: [],
  });
});

test('world landmarks drive the geometry while screen landmarks gate visibility', () => {
  const screen = posedBody({ elbowBend: 90 }); // all visible
  const world = posedBody({ elbowBend: 150, visibility: undefined });
  const { elbowAngle } = anglesFromLandmarks(screen, world);
  assert.ok(Math.abs(elbowAngle - 150) < 1);
});
