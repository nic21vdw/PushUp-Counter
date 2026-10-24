/**
 * Push-up rep counting state machine.
 *
 * Pure logic: feed it an elbow angle (and optionally a plank angle) per frame and
 * it tells you when a rep completed. No DOM, no camera, no MediaPipe.
 *
 * A rep is counted on the way *up*: the arms must bend past `downAngle`, then
 * extend past `upAngle`. Hysteresis between those two thresholds is what keeps
 * jitter around a single value from spraying out phantom reps.
 *
 * Fast reps are the hard case, and three things here exist for them:
 *
 *   - Impulse noise is removed with a median of the last three samples rather
 *     than by averaging. An average heavy enough to swallow a bad frame also
 *     flattens the peaks of a quick rep until they stop reaching the thresholds,
 *     which reads as "it stopped counting when I sped up".
 *   - A rep that stops short of lockout still counts once you turn around into
 *     the next one — see `upTolerance`. Nobody locks out at speed.
 *   - A pose lost for a frame or two, or a moment of ragged form, holds the rep
 *     in progress rather than throwing it away. At speed those are blur, not you
 *     stopping.
 *
 * The first two frames after the pose is (re)acquired only fill the median
 * window. They are the noisiest frames there are, and a single bad one among
 * them used to start a rep from nothing.
 *
 * Each counted rep also comes back as `rep`: depth, top, duration and a 0..100
 * score, so the page can say how good it was and not only that it happened.
 */

export const DEFAULT_OPTIONS = {
  /** Elbow angle (deg) you must get below to register the bottom of a rep. */
  downAngle: 100,
  /** Elbow angle (deg) you must get back above to complete the rep. */
  upAngle: 155,
  /**
   * How far short of `upAngle` a rep may stop and still count, provided you
   * clearly turn around and head back down. Zero demands a full lockout.
   */
  upTolerance: 25,
  /** Downward turn (deg) away from the top of a rep that marks it as finished. */
  reversalDeg: 10,
  /**
   * How long (ms) a rep may sit within `upTolerance` of `upAngle` without
   * climbing before it counts. Arms that read a few degrees short of lockout
   * otherwise bank the rep only when the next one starts, and the last rep of a
   * set never.
   */
  topHoldMs: 150,
  /** Minimum shoulder-hip-knee angle (deg) to be considered "in a plank". */
  minPlankAngle: 140,
  /** Landmark visibility below this is treated as unusable. */
  minVisibility: 0.5,
  /** Weight of each new sample in the exponential moving average (0..1). */
  smoothing: 0.85,
  /** Reps closer together than this (ms) are treated as noise. */
  minRepMs: 220,
  /** The bottom phase must last at least this long (ms) to count. */
  minPhaseMs: 60,
  /** A pose lost for less than this (ms) holds the rep rather than dropping it. */
  maxGapMs: 250,
  /** Form has to be off for this long (ms) before the rep in progress is dropped. */
  plankGraceMs: 300,
  /** Enforce the plank check when knees/hips are visible. */
  requirePlank: true,
};

export const STATE = {
  NO_POSE: "no-pose",
  UNKNOWN: "unknown",
  UP: "up",
  DOWN: "down",
};

const TOP_BAND_DEG = 8;
const CLIMB_DEG = 3;
const FULL_DEPTH_DEG = 70;
const FULL_LOCKOUT_DEG = 165;
const FULL_PLANK_DEG = 165;
const FULL_TEMPO_MS = 1000;
const FLOOR_TEMPO_MS = 350;
const WEAK = 0.2;
const WEIGHTS = { depth: 0.4, lockout: 0.25, plank: 0.2, tempo: 0.15 };
const GRADES = [
  [90, "perfect"],
  [75, "great"],
  [55, "good"],
];

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const ramp = (value, from, to, low, high) =>
  low + (high - low) * clamp01((value - from) / (to - from));

/** Grade for a 0..100 rep score. */
export function gradeFor(score) {
  for (const [floor, grade] of GRADES) if (score >= floor) return grade;
  return "sloppy";
}

/**
 * Score one finished rep.
 *
 * Depth (40%): 70 degrees or less at the bottom is full marks, `downAngle` is
 * weak. Lockout (25%): 165 degrees or more at the top; a rep that only just
 * made the counting threshold scores low. Plank (20%): mean shoulder-hip-knee
 * angle while down, 165 or more is straight; `null` means it could not be
 * measured and costs nothing. Tempo (15%): under about a third of a second is a
 * bounce, a second or longer is controlled.
 *
 * @param {{depth: number, top: number, durationMs: number, plank?: number|null}} rep
 * @param {typeof DEFAULT_OPTIONS} [options]
 * @returns {{score: number, grade: string,
 *            parts: {depth: number, lockout: number, plank: number, tempo: number}}}
 */
export function scoreRep(
  { depth, top, durationMs, plank = null },
  options = DEFAULT_OPTIONS,
) {
  const fullDepth = Math.min(FULL_DEPTH_DEG, options.downAngle - 10);
  const fullLockout = Math.max(FULL_LOCKOUT_DEG, options.upAngle);
  const lockoutFloor = Math.min(
    options.upAngle - options.upTolerance,
    fullLockout - 10,
  );
  const parts = {
    depth: ramp(depth, fullDepth, options.downAngle, 1, WEAK),
    lockout: ramp(top, fullLockout, lockoutFloor, 1, WEAK),
    plank: Number.isFinite(plank)
      ? ramp(plank, FULL_PLANK_DEG, options.minPlankAngle, 1, WEAK)
      : 1,
    tempo: ramp(durationMs, FLOOR_TEMPO_MS, FULL_TEMPO_MS, 0.15, 1),
  };
  const score = Math.round(
    100 *
      (WEIGHTS.depth * parts.depth +
        WEIGHTS.lockout * parts.lockout +
        WEIGHTS.plank * parts.plank +
        WEIGHTS.tempo * parts.tempo),
  );
  return { score, grade: gradeFor(score), parts };
}

export class RepCounter {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reset();
  }

  /** Change thresholds live without losing the rep count. */
  configure(patch) {
    this.options = { ...this.options, ...patch };
  }

  /** Clear everything, including the rep count. */
  reset() {
    this.reps = 0;
    this.state = STATE.NO_POSE;
    this.smoothedAngle = null;
    this.rawAngle = null;
    this.plankAngle = null;
    this.inPlank = true;
    this.phaseStartedAt = null;
    this.lastRepAt = -Infinity;
    this.lastSampleAt = null;
    this.outOfPlankSince = null;
    this.window = [];
    this.minAngleThisPhase = 180;
    this.peakSinceBottom = null;
    this.#clearRepStats();
    this.lastRepDepth = null;
    this.lastRepTop = null;
    this.lastRep = null;
    this.feedback = "Waiting for a body in frame…";
  }

  /** Forget the current phase but keep the rep count (used after a manual undo). */
  resetPhase() {
    this.state = STATE.UNKNOWN;
    this.smoothedAngle = null;
    this.rawAngle = null;
    this.plankAngle = null;
    this.inPlank = true;
    this.lastSampleAt = null;
    this.outOfPlankSince = null;
    this.window = [];
    this.phaseStartedAt = null;
    this.minAngleThisPhase = 180;
    this.peakSinceBottom = null;
    this.#clearRepStats();
  }

  /**
   * Advance the state machine by one frame.
   *
   * @param {{elbowAngle: number|null, plankAngle?: number|null, timestamp: number}} sample
   * @returns {{reps: number, repCompleted: boolean, state: string, angle: number|null,
   *            rawAngle: number|null, plankAngle: number|null, inPlank: boolean,
   *            depth: number|null, lastRepDepth: number|null, lastRepTop: number|null,
   *            rep: {depth: number, top: number, durationMs: number, score: number,
   *                  grade: string}|null,
   *            feedback: string}}
   */
  update({ elbowAngle, plankAngle = null, timestamp }) {
    const o = this.options;
    if (
      this.lastSampleAt !== null &&
      timestamp - this.lastSampleAt > o.maxGapMs
    ) {
      this.resetPhase();
    }
    this.plankAngle = plankAngle;
    this.rawAngle = Number.isFinite(elbowAngle) ? elbowAngle : null;

    if (this.rawAngle === null) {
      // Motion blur costs you the odd frame, and it costs you most of them
      // exactly when you are moving fastest. Hold the rep across a short gap;
      // only a real absence ends it.
      const gap =
        this.lastSampleAt === null ? Infinity : timestamp - this.lastSampleAt;
      if (this.state !== STATE.NO_POSE && gap <= o.maxGapMs) {
        this.feedback = "Lost you for a frame — keep going.";
        return this.#snapshot(false, this.smoothedAngle);
      }

      this.state = STATE.NO_POSE;
      this.smoothedAngle = null;
      this.phaseStartedAt = null;
      this.lastSampleAt = null;
      this.outOfPlankSince = null;
      this.window = [];
      this.minAngleThisPhase = 180;
      this.peakSinceBottom = null;
      this.#clearRepStats();
      this.inPlank = true;
      this.feedback = "No body detected — step into frame.";
      return this.#snapshot(false, null);
    }

    this.lastSampleAt = timestamp;

    const settled = this.window.length >= 2;
    const despiked = this.#median3(this.rawAngle);
    if (!settled) {
      this.feedback = "Locking on…";
      return this.#snapshot(false, null);
    }
    this.smoothedAngle =
      this.smoothedAngle === null
        ? despiked
        : this.smoothedAngle + o.smoothing * (despiked - this.smoothedAngle);
    const angle = this.smoothedAngle;

    // Plank gate: only enforced when we could actually measure the torso.
    const plankKnown = Number.isFinite(plankAngle);
    const inPlank =
      !o.requirePlank || !plankKnown || plankAngle >= o.minPlankAngle;
    this.inPlank = inPlank;

    if (inPlank) {
      this.outOfPlankSince = null;
    } else {
      if (this.outOfPlankSince === null) this.outOfPlankSince = timestamp;
      if (timestamp - this.outOfPlankSince >= o.plankGraceMs) {
        // Genuinely out of position — drop the in-flight rep and make them
        // re-establish the top. A briefer wobble only withholds the count.
        this.state = STATE.UNKNOWN;
        this.phaseStartedAt = null;
        this.minAngleThisPhase = 180;
        this.peakSinceBottom = null;
        this.#clearRepStats();
        this.feedback = "Straighten up — hips are sagging or piked.";
        return this.#snapshot(false, angle);
      }
    }

    let repCompleted = false;
    let rep = null;

    if (this.state !== STATE.DOWN) this.#trackTop(angle, timestamp);

    if (this.state !== STATE.DOWN && angle <= o.downAngle) {
      this.state = STATE.DOWN;
      this.phaseStartedAt = timestamp;
      this.minAngleThisPhase = angle;
      this.peakSinceBottom = angle;
      this.#markClimb(angle, timestamp);
      this.repStartTop = this.topAngle;
      this.repStartedAt = this.topAt;
      this.topAngle = null;
      this.topAt = null;
      this.plankSum = 0;
      this.plankCount = 0;
      this.feedback = "Down — now push.";
    } else if (this.state === STATE.DOWN) {
      if (plankKnown) {
        this.plankSum += plankAngle;
        this.plankCount += 1;
      }

      if (angle < this.minAngleThisPhase) {
        // Still sinking, so whatever we had climbed to was part of the descent.
        this.minAngleThisPhase = angle;
        this.peakSinceBottom = angle;
        this.#markClimb(angle, timestamp);
      } else if (angle > this.peakSinceBottom) {
        this.peakSinceBottom = angle;
      }
      if (angle >= this.climbFrom + CLIMB_DEG)
        this.#markClimb(angle, timestamp);

      const nearTop = this.peakSinceBottom >= o.upAngle - o.upTolerance;
      const lockedOut = angle >= o.upAngle;
      const turnedAround =
        nearTop && this.peakSinceBottom - angle >= o.reversalDeg;
      const heldAtTop = nearTop && timestamp - this.climbAt >= o.topHoldMs;

      if (!inPlank) {
        this.feedback = "Straighten up — hips are sagging or piked.";
      } else if (lockedOut || turnedAround || heldAtTop) {
        const heldLongEnough =
          timestamp - (this.phaseStartedAt ?? timestamp) >= o.minPhaseMs;
        const notTooSoon = timestamp - this.lastRepAt >= o.minRepMs;
        if (heldLongEnough && notTooSoon) {
          this.reps += 1;
          this.lastRepAt = timestamp;
          rep = this.#finishedRep(timestamp);
          this.lastRep = rep;
          this.lastRepDepth = rep.depth;
          this.lastRepTop = rep.top;
          repCompleted = true;
          this.feedback = this.#depthFeedback(this.minAngleThisPhase);
        } else {
          this.feedback = "Too fast to count — control the rep.";
        }
        this.state = STATE.UP;
        this.phaseStartedAt = timestamp;
        this.minAngleThisPhase = 180;
        this.peakSinceBottom = null;
        this.#clearRepStats();
      } else {
        this.feedback = "Pushing up…";
      }
    } else if (angle >= o.upAngle) {
      if (this.state !== STATE.UP) this.phaseStartedAt = timestamp;
      this.state = STATE.UP;
      this.feedback = "Top position — go down.";
    } else if (this.state === STATE.UNKNOWN) {
      this.feedback = "Extend your arms to set the top position.";
    } else {
      this.feedback = "Lower your chest.";
    }

    return this.#snapshot(repCompleted, angle, rep);
  }

  #markClimb(angle, timestamp) {
    this.climbFrom = angle;
    this.climbAt = timestamp;
  }

  #trackTop(angle, timestamp) {
    if (this.topAngle === null || angle >= this.topAngle) this.topAngle = angle;
    if (angle >= this.topAngle - TOP_BAND_DEG) this.topAt = timestamp;
  }

  #clearRepStats() {
    this.topAngle = null;
    this.topAt = null;
    this.repStartTop = null;
    this.repStartedAt = null;
    this.plankSum = 0;
    this.plankCount = 0;
  }

  #finishedRep(timestamp) {
    const depth = this.minAngleThisPhase;
    const top = Math.max(this.peakSinceBottom, this.repStartTop ?? -Infinity);
    const startedAt = this.repStartedAt ?? this.phaseStartedAt ?? timestamp;
    const durationMs = Math.max(0, timestamp - startedAt);
    const plank = this.plankCount > 0 ? this.plankSum / this.plankCount : null;
    const { score, grade } = scoreRep(
      { depth, top, durationMs, plank },
      this.options,
    );
    return {
      depth: Math.round(depth * 10) / 10,
      top: Math.round(top * 10) / 10,
      durationMs: Math.round(durationMs),
      score,
      grade,
    };
  }

  /**
   * Median of the last three samples. A mis-detected limb lasts one frame and is
   * discarded outright, while a real movement passes through with its amplitude
   * intact and one frame of delay — which is what an average cannot do.
   */
  #median3(value) {
    this.window.push(value);
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return value;
    const [a, b, c] = this.window;
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }

  #depthFeedback(depth) {
    if (depth <= 80) return "Rep counted — great depth.";
    if (depth <= 95) return "Rep counted.";
    return "Rep counted — try going a little lower.";
  }

  #snapshot(repCompleted, angle, rep = null) {
    return {
      reps: this.reps,
      repCompleted,
      rep,
      state: this.state,
      angle,
      rawAngle: this.rawAngle,
      plankAngle: this.plankAngle,
      inPlank: this.inPlank,
      depth: this.state === STATE.DOWN ? this.minAngleThisPhase : null,
      lastRepDepth: this.lastRepDepth,
      lastRepTop: this.lastRepTop,
      feedback: this.feedback,
    };
  }
}
