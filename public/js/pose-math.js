/**
 * Geometry helpers for turning MediaPipe pose landmarks into the couple of
 * angles the rep counter actually cares about.
 *
 * Everything here is pure so it can be unit tested without a webcam.
 */

/** Indices into MediaPipe's 33-point pose landmark model. */
export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

/**
 * Interior angle at `b` in the path a -> b -> c, in degrees (0..180).
 * Uses z when all three points carry it, so metric world landmarks stay
 * accurate no matter where the camera sits.
 */
export function angleDeg(a, b, c) {
  if (!a || !b || !c) return null;
  const use3d = [a, b, c].every(
    (p) => typeof p.z === "number" && Number.isFinite(p.z),
  );
  const ba = { x: a.x - b.x, y: a.y - b.y, z: use3d ? a.z - b.z : 0 };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: use3d ? c.z - b.z : 0 };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magA = Math.hypot(ba.x, ba.y, ba.z);
  const magC = Math.hypot(bc.x, bc.y, bc.z);
  if (magA === 0 || magC === 0) return null;
  const cos = Math.min(1, Math.max(-1, dot / (magA * magC)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** True when every listed landmark exists and clears the visibility bar. */
export function allVisible(landmarks, indices, minVisibility) {
  return indices.every((i) => {
    const lm = landmarks?.[i];
    if (!lm) return false;
    // World landmarks carry no visibility field; treat that as "trust it".
    const v = typeof lm.visibility === "number" ? lm.visibility : 1;
    return v >= minVisibility;
  });
}

const SIDES = [
  {
    name: "left",
    shoulder: LM.LEFT_SHOULDER,
    elbow: LM.LEFT_ELBOW,
    wrist: LM.LEFT_WRIST,
    hip: LM.LEFT_HIP,
    knee: LM.LEFT_KNEE,
  },
  {
    name: "right",
    shoulder: LM.RIGHT_SHOULDER,
    elbow: LM.RIGHT_ELBOW,
    wrist: LM.RIGHT_WRIST,
    hip: LM.RIGHT_HIP,
    knee: LM.RIGHT_KNEE,
  },
];

const WEIGHT_POWER = 4;
const DISAGREE_DEG = 40;
const DOMINANCE = 1.5;

/**
 * Lowest visibility among the listed landmarks, or null when any is missing or
 * below the floor. A world landmark with no visibility field counts as 1.
 */
function confidence(landmarks, indices, minVisibility) {
  let lowest = 1;
  for (const i of indices) {
    const lm = landmarks?.[i];
    if (!lm) return null;
    const v = typeof lm.visibility === "number" ? lm.visibility : 1;
    if (v < minVisibility) return null;
    if (v < lowest) lowest = v;
  }
  return lowest;
}

const stretched = (p, k) =>
  p ? { x: p.x * k, y: p.y, z: typeof p.z === "number" ? p.z * k : p.z } : p;

function angleAt(points, a, b, c, stretch) {
  if (stretch === 1) return angleDeg(points[a], points[b], points[c]);
  return angleDeg(
    stretched(points[a], stretch),
    stretched(points[b], stretch),
    stretched(points[c], stretch),
  );
}

function geometryFor(screenLandmarks, worldLandmarks, aspect) {
  const world = worldLandmarks && worldLandmarks.length >= 29;
  return {
    points: world ? worldLandmarks : screenLandmarks,
    stretch: world ? 1 : aspect,
  };
}

/**
 * Collapse per-arm readings into one angle. Each arm counts in proportion to
 * its visibility, steeply, so a well-seen near arm outvotes a half-hidden far
 * one instead of being dragged halfway to its guess. When the arms disagree
 * wildly and one is clearly better seen, that arm is simply taken.
 */
function fuse(readings) {
  if (readings.length === 0) return null;
  let best = readings[0];
  for (const r of readings) if (r.weight > best.weight) best = r;
  const dominates = readings.every(
    (r) =>
      r === best ||
      (Math.abs(r.angle - best.angle) > DISAGREE_DEG &&
        best.weight >= DOMINANCE * r.weight),
  );
  return dominates ? best.angle : weightedMean(readings);
}

function mean(values) {
  const nums = values.filter(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function weightedMean(readings) {
  if (readings.length === 0) return null;
  let total = 0;
  let sum = 0;
  for (const r of readings) {
    total += r.weight;
    sum += r.weight * r.angle;
  }
  return total > 0 ? sum / total : mean(readings.map((r) => r.angle));
}

/**
 * One arm's elbow angle and how far to trust it.
 *
 * @param {Array} screenLandmarks Normalized image-space landmarks.
 * @param {Array|null} worldLandmarks Metric 3D landmarks, preferred for geometry.
 * @param {"left"|"right"} side
 * @param {number} [minVisibility]
 * @param {number} [aspect] Width over height; only used when falling back to
 *   screen landmarks, whose x and y are normalized by different lengths.
 * @returns {{angle: number, weight: number}|null}
 */
export function armReading(
  screenLandmarks,
  worldLandmarks,
  side,
  minVisibility = 0.5,
  aspect = 1,
) {
  if (!screenLandmarks || screenLandmarks.length < 29) return null;
  const arm = SIDES.find((s) => s.name === side);
  if (!arm) return null;
  const seen = confidence(
    screenLandmarks,
    [arm.shoulder, arm.elbow, arm.wrist],
    minVisibility,
  );
  if (seen === null) return null;
  const { points, stretch } = geometryFor(
    screenLandmarks,
    worldLandmarks,
    aspect,
  );
  const angle = angleAt(points, arm.shoulder, arm.elbow, arm.wrist, stretch);
  return angle === null ? null : { angle, weight: seen ** WEIGHT_POWER };
}

/**
 * Extract the push-up-relevant angles from a pose.
 *
 * Both arms are fused by visibility (see `fuse`) and so are both hips, rather
 * than averaged blindly: from the side, the far arm is mostly hidden behind the
 * body and its landmarks are guesses.
 *
 * @param {Array} screenLandmarks Normalized image-space landmarks (carry `visibility`).
 * @param {Array} [worldLandmarks] Metric 3D landmarks. Preferred for angles when present
 *   because they are far less sensitive to camera placement.
 * @param {number} [minVisibility]
 * @param {number} [aspect] Video width over height, for the screen-landmark fallback.
 * @returns {{elbowAngle: number|null, plankAngle: number|null, sidesUsed: string[]}}
 */
export function anglesFromLandmarks(
  screenLandmarks,
  worldLandmarks = null,
  minVisibility = 0.5,
  aspect = 1,
) {
  if (!screenLandmarks || screenLandmarks.length < 29) {
    return { elbowAngle: null, plankAngle: null, sidesUsed: [] };
  }
  const { points, stretch } = geometryFor(
    screenLandmarks,
    worldLandmarks,
    aspect,
  );

  const elbows = [];
  const planks = [];
  const sidesUsed = [];

  for (const side of SIDES) {
    const arm = armReading(
      screenLandmarks,
      worldLandmarks,
      side.name,
      minVisibility,
      aspect,
    );
    if (arm) {
      elbows.push(arm);
      sidesUsed.push(side.name);
    }
    const seen = confidence(
      screenLandmarks,
      [side.shoulder, side.hip, side.knee],
      minVisibility,
    );
    if (seen !== null) {
      const angle = angleAt(
        points,
        side.shoulder,
        side.hip,
        side.knee,
        stretch,
      );
      if (angle !== null) planks.push({ angle, weight: seen ** WEIGHT_POWER });
    }
  }

  return {
    elbowAngle: fuse(elbows),
    plankAngle: weightedMean(planks),
    sidesUsed,
  };
}
