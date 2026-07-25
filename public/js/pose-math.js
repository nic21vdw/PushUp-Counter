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
  const use3d = [a, b, c].every((p) => typeof p.z === 'number' && Number.isFinite(p.z));
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
    const v = typeof lm.visibility === 'number' ? lm.visibility : 1;
    return v >= minVisibility;
  });
}

function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

/**
 * Extract the push-up-relevant angles from a pose.
 *
 * @param {Array} screenLandmarks Normalized image-space landmarks (carry `visibility`).
 * @param {Array} [worldLandmarks] Metric 3D landmarks. Preferred for angles when present
 *   because they are far less sensitive to camera placement.
 * @param {number} [minVisibility]
 * @returns {{elbowAngle: number|null, plankAngle: number|null, sidesUsed: string[]}}
 */
export function anglesFromLandmarks(screenLandmarks, worldLandmarks = null, minVisibility = 0.5) {
  if (!screenLandmarks || screenLandmarks.length < 29) {
    return { elbowAngle: null, plankAngle: null, sidesUsed: [] };
  }
  // Visibility is judged on screen landmarks; geometry uses world when available.
  const geo = worldLandmarks && worldLandmarks.length >= 29 ? worldLandmarks : screenLandmarks;

  const sides = [
    {
      name: 'left',
      shoulder: LM.LEFT_SHOULDER,
      elbow: LM.LEFT_ELBOW,
      wrist: LM.LEFT_WRIST,
      hip: LM.LEFT_HIP,
      knee: LM.LEFT_KNEE,
    },
    {
      name: 'right',
      shoulder: LM.RIGHT_SHOULDER,
      elbow: LM.RIGHT_ELBOW,
      wrist: LM.RIGHT_WRIST,
      hip: LM.RIGHT_HIP,
      knee: LM.RIGHT_KNEE,
    },
  ];

  const elbowAngles = [];
  const plankAngles = [];
  const sidesUsed = [];

  for (const side of sides) {
    if (allVisible(screenLandmarks, [side.shoulder, side.elbow, side.wrist], minVisibility)) {
      const a = angleDeg(geo[side.shoulder], geo[side.elbow], geo[side.wrist]);
      if (a !== null) {
        elbowAngles.push(a);
        sidesUsed.push(side.name);
      }
    }
    if (allVisible(screenLandmarks, [side.shoulder, side.hip, side.knee], minVisibility)) {
      const a = angleDeg(geo[side.shoulder], geo[side.hip], geo[side.knee]);
      if (a !== null) plankAngles.push(a);
    }
  }

  return {
    elbowAngle: mean(elbowAngles),
    plankAngle: mean(plankAngles),
    sidesUsed,
  };
}
