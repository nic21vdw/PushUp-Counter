/**
 * Why the tracker can see you but will not count you.
 *
 * The detector finding a body is not the same as the body being countable. Too
 * far away and the joints are noise; too close and your arms leave the frame;
 * face-on and the elbow angle is a guess; standing up and there is no push-up
 * to find. In every one of those cases the skeleton draws happily and the
 * number never moves, which from the floor is indistinguishable from the thing
 * being broken.
 *
 * So this looks at the same landmarks the counter does and answers a different
 * question: not "was that a rep" but "could this ever be a rep, and if not,
 * what should you change". One instruction at a time, most blocking first —
 * a list of five things wrong is not something you can act on mid-set.
 *
 * Pure and DOM-free: every judgement below is decided by numbers that can be
 * written down in a test, which is the only way to be sure the advice is not
 * itself wrong.
 */

import { LM } from './pose-math.js';

export const FRAMING = {
  OK: 'ok',
  NO_POSE: 'no-pose',
  CROPPED: 'cropped',
  TOO_CLOSE: 'too-close',
  TOO_FAR: 'too-far',
  ARMS_HIDDEN: 'arms-hidden',
  STANDING: 'standing',
  FACE_ON: 'face-on',
  UNSURE: 'unsure',
};

export const DEFAULT_FRAMING_OPTIONS = {
  /** Landmark visibility below this is treated as not seen. */
  minVisibility: 0.5,
  /**
   * How much of the frame your body should cover, measured on its longest
   * side. Below `minSpan` the joints are only a few pixels apart and the angles
   * turn to noise; above `maxSpan` you are one movement from leaving the frame.
   *
   * Judged on shoulders to hips only — legs are not in the list below, so a
   * well-framed push-up measures a good deal smaller here than it looks.
   */
  minSpan: 0.3,
  maxSpan: 0.97,
  /** Anything this close to an edge is treated as touching it. */
  edge: 0.02,
  /**
   * Shoulder separation as a fraction of torso length. A body side-on to the
   * camera has one shoulder nearly behind the other; face-on has them a torso
   * apart. Above this, the elbow you are measuring is partly guesswork.
   */
  maxShoulderSpread: 0.62,
  /**
   * Taller than this many times its width means you are upright. A push-up is a
   * horizontal shape, whichever way the camera is turned.
   */
  standingRatio: 1.35,
};

/** The core joints. Framing is judged on these and nothing else. */
const CORE = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW,
  LM.RIGHT_ELBOW,
  LM.LEFT_WRIST,
  LM.RIGHT_WRIST,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
];

const ARMS = [LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST];

/**
 * @param {Array|null} landmarks normalized image-space landmarks, with visibility
 * @param {Partial<typeof DEFAULT_FRAMING_OPTIONS>} [overrides]
 * @returns {{code: string, ok: boolean, message: string, span: number|null}}
 */
export function checkFraming(landmarks, overrides = {}) {
  const o = { ...DEFAULT_FRAMING_OPTIONS, ...overrides };

  const seen = (index) => {
    const lm = landmarks?.[index];
    if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return null;
    const visibility = typeof lm.visibility === 'number' ? lm.visibility : 1;
    return visibility >= o.minVisibility ? lm : null;
  };

  const core = CORE.map(seen).filter(Boolean);

  // Two joints is not a body. Anything less than a torso's worth of points and
  // there is nothing to give advice about.
  if (core.length < 4) {
    return result(FRAMING.NO_POSE, 'Step into frame — nothing to track yet.', null);
  }

  const xs = core.map((p) => p.x);
  const ys = core.map((p) => p.y);
  const box = {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const span = Math.max(width, height);

  // Touching an edge is reported before anything else: every measurement below
  // is taken on a body that may continue past the frame, so it cannot be
  // trusted, and "you are cut off" is the more useful sentence anyway.
  const offLeft = box.left <= o.edge;
  const offRight = box.right >= 1 - o.edge;
  const offTop = box.top <= o.edge;
  const offBottom = box.bottom >= 1 - o.edge;

  if (offLeft && offRight) {
    return result(FRAMING.TOO_CLOSE, 'Move further back — you fill the whole frame.', span);
  }
  if (offLeft) return result(FRAMING.CROPPED, 'You are cut off on the left — shift right.', span);
  if (offRight) return result(FRAMING.CROPPED, 'You are cut off on the right — shift left.', span);
  if (offTop && offBottom) {
    return result(FRAMING.TOO_CLOSE, 'Move further back — you fill the whole frame.', span);
  }
  if (offTop) return result(FRAMING.CROPPED, 'Your head is out of frame — tilt the camera up.', span);
  if (offBottom) {
    return result(FRAMING.CROPPED, 'You are cut off at the bottom — tilt the camera down.', span);
  }

  if (span > o.maxSpan) {
    return result(FRAMING.TOO_CLOSE, 'Move further back — you fill the whole frame.', span);
  }
  if (span < o.minSpan) {
    return result(FRAMING.TOO_FAR, 'Move closer — you are too small to measure.', span);
  }

  // The elbow angle is the entire measurement, so an arm that is not visible is
  // not a detail — it is the thing.
  if (ARMS.map(seen).filter(Boolean).length < 2) {
    return result(FRAMING.ARMS_HIDDEN, 'Your arms are hidden — turn so the camera sees them.', span);
  }

  if (height > width * o.standingRatio) {
    return result(FRAMING.STANDING, 'Get down into a plank — nothing counts standing up.', span);
  }

  const left = seen(LM.LEFT_SHOULDER);
  const right = seen(LM.RIGHT_SHOULDER);
  const hip = seen(LM.LEFT_HIP) ?? seen(LM.RIGHT_HIP);
  if (left && right && hip) {
    const shoulder = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const torso = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
    const spread = Math.hypot(left.x - right.x, left.y - right.y);
    if (torso > 0 && spread / torso > o.maxShoulderSpread) {
      return result(FRAMING.FACE_ON, 'Turn side-on — the camera should see you from the side.', span);
    }
  }

  // Everything is in shot and the right size, but the detector is only half
  // sure of what it is looking at. More light usually fixes it; a plainer wall
  // fixes the rest.
  const confidence = core.reduce(
    (sum, p) => sum + (typeof p.visibility === 'number' ? p.visibility : 1),
    0,
  ) / core.length;
  if (confidence < 0.65) {
    return result(FRAMING.UNSURE, 'Hard to see you — try more light or a plainer background.', span);
  }

  return result(FRAMING.OK, '', span);
}

function result(code, message, span) {
  return { code, ok: code === FRAMING.OK, message, span };
}
