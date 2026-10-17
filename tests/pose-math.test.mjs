import test from "node:test";
import assert from "node:assert/strict";

import {
  LM,
  angleDeg,
  allVisible,
  anglesFromLandmarks,
  armReading,
} from "../public/js/pose-math.js";
import { RepCounter } from "../public/js/rep-counter.js";

test("angleDeg measures the interior angle at the middle point", () => {
  const right = angleDeg({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(right - 90) < 1e-6);

  const straight = angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(straight - 180) < 1e-6);
});

test("angleDeg uses z when all three points carry it", () => {
  // Bent purely in depth: 2D projection would collapse to 180.
  const a = { x: 0, y: 0, z: 1 };
  const b = { x: 0, y: 0, z: 0 };
  const c = { x: 1, y: 0, z: 0 };
  assert.ok(Math.abs(angleDeg(a, b, c) - 90) < 1e-6);
});

test("angleDeg handles degenerate and missing input", () => {
  assert.equal(angleDeg({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
  assert.equal(angleDeg(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
});

test("allVisible enforces the visibility floor and treats missing visibility as trusted", () => {
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
  for (const side of ["LEFT", "RIGHT"]) {
    const sign = side === "LEFT" ? -1 : 1;
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

test("anglesFromLandmarks recovers the elbow bend and a straight plank", () => {
  const { elbowAngle, plankAngle, sidesUsed } = anglesFromLandmarks(
    posedBody({ elbowBend: 90 }),
  );
  assert.ok(Math.abs(elbowAngle - 90) < 1);
  assert.ok(Math.abs(plankAngle - 180) < 1);
  assert.deepEqual(sidesUsed, ["left", "right"]);
});

test("anglesFromLandmarks skips sides below the visibility floor", () => {
  const pose = posedBody({ elbowBend: 90 });
  pose[LM.LEFT_WRIST] = { ...pose[LM.LEFT_WRIST], visibility: 0.1 };
  const { elbowAngle, sidesUsed } = anglesFromLandmarks(pose);
  assert.deepEqual(sidesUsed, ["right"]);
  assert.ok(Math.abs(elbowAngle - 90) < 1);
});

test("anglesFromLandmarks returns nulls when nothing is visible enough", () => {
  const { elbowAngle, plankAngle } = anglesFromLandmarks(
    posedBody({ elbowBend: 90, visibility: 0.1 }),
  );
  assert.equal(elbowAngle, null);
  assert.equal(plankAngle, null);
});

test("anglesFromLandmarks rejects a truncated landmark array", () => {
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

test("world landmarks drive the geometry while screen landmarks gate visibility", () => {
  const screen = posedBody({ elbowBend: 90 }); // all visible
  const world = posedBody({ elbowBend: 150, visibility: undefined });
  const { elbowAngle } = anglesFromLandmarks(screen, world);
  assert.ok(Math.abs(elbowAngle - 150) < 1);
});

/**
 * Two arms bent independently, each with its own visibility, and a body held
 * straight. `plank` bends each side's hip so the plank angle can differ too.
 */
function posedArms({
  left,
  right,
  leftVis = 0.9,
  rightVis = 0.9,
  leftPlank = 180,
  rightPlank = 180,
}) {
  const pose = blankPose();
  const arms = [
    ["LEFT", -1, left, leftVis, leftPlank],
    ["RIGHT", 1, right, rightVis, rightPlank],
  ];
  for (const [side, sign, bend, visibility, plank] of arms) {
    const rad = (bend * Math.PI) / 180;
    pose[LM[`${side}_SHOULDER`]] = { x: sign * 0.2, y: 0, z: 0, visibility };
    pose[LM[`${side}_ELBOW`]] = { x: sign * 0.2, y: 0.3, z: 0, visibility };
    pose[LM[`${side}_WRIST`]] = {
      x: sign * 0.2 + 0.3 * Math.sin(rad),
      y: 0.3 - 0.3 * Math.cos(rad),
      z: 0,
      visibility,
    };
    const sag = ((180 - plank) * Math.PI) / 180;
    pose[LM[`${side}_HIP`]] = { x: sign * 0.2, y: -0.5, z: 0, visibility };
    pose[LM[`${side}_KNEE`]] = {
      x: sign * 0.2 + 0.5 * Math.sin(sag),
      y: -0.5 - 0.5 * Math.cos(sag),
      z: 0,
      visibility,
    };
  }
  return pose;
}

test("equal visibility still averages the two arms", () => {
  const { elbowAngle } = anglesFromLandmarks(
    posedArms({ left: 80, right: 100 }),
  );
  assert.ok(Math.abs(elbowAngle - 90) < 0.5, `got ${elbowAngle}`);
});

test("a well-seen near arm outvotes a half-hidden far arm", () => {
  const pose = posedArms({
    left: 90,
    right: 125,
    leftVis: 0.98,
    rightVis: 0.55,
  });
  const { elbowAngle, sidesUsed } = anglesFromLandmarks(pose);
  assert.deepEqual(sidesUsed, ["left", "right"]);
  assert.ok(
    Math.abs(elbowAngle - 90) < 5,
    `fused ${elbowAngle} should hug the near arm, not the 107.5 a plain mean gives`,
  );
  assert.ok(elbowAngle > 90, "the far arm still counts for something");
});

test("arms that disagree wildly resolve to the better-seen one", () => {
  const pose = posedArms({
    left: 80,
    right: 160,
    leftVis: 0.95,
    rightVis: 0.75,
  });
  const { elbowAngle } = anglesFromLandmarks(pose);
  assert.ok(Math.abs(elbowAngle - 80) < 0.5, `got ${elbowAngle}`);
});

test("arms that disagree wildly but are equally well seen are still averaged", () => {
  const pose = posedArms({ left: 80, right: 160 });
  const { elbowAngle } = anglesFromLandmarks(pose);
  assert.ok(Math.abs(elbowAngle - 120) < 0.5, `got ${elbowAngle}`);
});

test("the plank angle is fused by visibility as well", () => {
  const pose = posedArms({
    left: 90,
    right: 90,
    leftVis: 0.97,
    rightVis: 0.55,
    leftPlank: 150,
    rightPlank: 180,
  });
  const { plankAngle } = anglesFromLandmarks(pose);
  assert.ok(Math.abs(plankAngle - 150) < 6, `got ${plankAngle}`);
});

test("armReading reports one arm's angle and a weight that grows with visibility", () => {
  const pose = posedArms({ left: 70, right: 70, leftVis: 0.95, rightVis: 0.6 });
  const left = armReading(pose, null, "left");
  const right = armReading(pose, null, "right");
  assert.ok(Math.abs(left.angle - 70) < 0.5);
  assert.ok(left.weight > right.weight * 4);
  assert.equal(armReading(pose, null, "left", 0.99), null);
  assert.equal(armReading(pose, null, "middle"), null);
  assert.equal(armReading([], null, "left"), null);
});

test("screen landmarks are corrected for the video aspect when there is no world data", () => {
  const W = 1600;
  const H = 900;
  const pose = blankPose();
  const at = (x, y) => ({ x: x / W, y: y / H, visibility: 0.9 });
  pose[LM.LEFT_SHOULDER] = at(700, 350);
  pose[LM.LEFT_ELBOW] = at(800, 450);
  pose[LM.LEFT_WRIST] = at(900, 350);
  const stretched = anglesFromLandmarks(pose, null, 0.5, W / H);
  const naive = anglesFromLandmarks(pose, null, 0.5);
  assert.ok(Math.abs(stretched.elbowAngle - 90) < 0.5);
  assert.ok(Math.abs(naive.elbowAngle - 90) > 5);
});

test("a far arm that reads too straight no longer stops the reps being counted", () => {
  const counter = new RepCounter({ smoothing: 1 });
  let reps = 0;
  let lowestPlainMean = Infinity;
  let frame = 0;
  for (let n = 0; n < 5; n++) {
    for (let i = 0; i < 25; i++) {
      const phase = (i / 24) * 2 * Math.PI;
      const near = 170 - (92 * (1 - Math.cos(phase))) / 2;
      const far = Math.min(178, near + 50);
      const pose = posedArms({
        left: near,
        right: far,
        leftVis: 0.98,
        rightVis: 0.55,
      });
      const { elbowAngle, plankAngle } = anglesFromLandmarks(pose);
      const plainMean =
        (armReading(pose, null, "left").angle +
          armReading(pose, null, "right").angle) /
        2;
      lowestPlainMean = Math.min(lowestPlainMean, plainMean);
      const result = counter.update({
        elbowAngle,
        plankAngle,
        timestamp: 1000 + frame++ * 33,
      });
      if (result.repCompleted) reps += 1;
    }
  }
  assert.ok(
    lowestPlainMean > counter.options.downAngle,
    `a plain mean bottoms out at ${lowestPlainMean}, never reaching depth`,
  );
  assert.equal(reps, 5);
});
