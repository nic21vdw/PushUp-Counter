/**
 * Push-up rep counting state machine.
 *
 * Pure logic: feed it an elbow angle (and optionally a plank angle) per frame and
 * it tells you when a rep completed. No DOM, no camera, no MediaPipe.
 *
 * A rep is counted on the way *up*: the arms must bend past `downAngle`, then
 * extend past `upAngle`. Hysteresis between those two thresholds is what keeps
 * jitter around a single value from spraying out phantom reps.
 */

export const DEFAULT_OPTIONS = {
  /** Elbow angle (deg) you must get below to register the bottom of a rep. */
  downAngle: 100,
  /** Elbow angle (deg) you must get back above to complete the rep. */
  upAngle: 155,
  /** Minimum shoulder-hip-knee angle (deg) to be considered "in a plank". */
  minPlankAngle: 140,
  /** Landmark visibility below this is treated as unusable. */
  minVisibility: 0.5,
  /** Weight of each new sample in the exponential moving average (0..1). */
  smoothing: 0.5,
  /** Reps closer together than this (ms) are treated as noise. */
  minRepMs: 400,
  /** The bottom phase must last at least this long (ms) to count. */
  minPhaseMs: 120,
  /** Enforce the plank check when knees/hips are visible. */
  requirePlank: true,
};

export const STATE = {
  NO_POSE: 'no-pose',
  UNKNOWN: 'unknown',
  UP: 'up',
  DOWN: 'down',
};

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
    this.plankAngle = null;
    this.phaseStartedAt = null;
    this.lastRepAt = -Infinity;
    this.minAngleThisPhase = 180;
    this.lastRepDepth = null;
    this.feedback = 'Waiting for a body in frame…';
  }

  /** Forget the current phase but keep the rep count (used after a manual undo). */
  resetPhase() {
    this.state = STATE.UNKNOWN;
    this.phaseStartedAt = null;
    this.minAngleThisPhase = 180;
  }

  /**
   * Advance the state machine by one frame.
   *
   * @param {{elbowAngle: number|null, plankAngle?: number|null, timestamp: number}} sample
   * @returns {{reps: number, repCompleted: boolean, state: string, angle: number|null,
   *            rawAngle: number|null, plankAngle: number|null, inPlank: boolean,
   *            depth: number|null, lastRepDepth: number|null, feedback: string}}
   */
  update({ elbowAngle, plankAngle = null, timestamp }) {
    const o = this.options;
    this.plankAngle = plankAngle;

    if (elbowAngle === null || elbowAngle === undefined || !Number.isFinite(elbowAngle)) {
      this.state = STATE.NO_POSE;
      this.smoothedAngle = null;
      this.phaseStartedAt = null;
      this.minAngleThisPhase = 180;
      this.feedback = 'No body detected — step into frame.';
      return this.#snapshot(false, null);
    }

    // Exponential moving average. First sample seeds it directly.
    this.smoothedAngle =
      this.smoothedAngle === null
        ? elbowAngle
        : this.smoothedAngle + o.smoothing * (elbowAngle - this.smoothedAngle);
    const angle = this.smoothedAngle;

    // Plank gate: only enforced when we could actually measure the torso.
    const plankKnown = plankAngle !== null && plankAngle !== undefined && Number.isFinite(plankAngle);
    const inPlank = !o.requirePlank || !plankKnown || plankAngle >= o.minPlankAngle;

    if (!inPlank) {
      // Out of position — drop the in-flight rep and make them re-establish the top.
      this.state = STATE.UNKNOWN;
      this.phaseStartedAt = null;
      this.minAngleThisPhase = 180;
      this.feedback = 'Straighten up — hips are sagging or piked.';
      return this.#snapshot(false, angle);
    }

    let repCompleted = false;

    if (this.state !== STATE.DOWN && angle <= o.downAngle) {
      // Entering the bottom of a rep.
      this.state = STATE.DOWN;
      this.phaseStartedAt = timestamp;
      this.minAngleThisPhase = angle;
      this.feedback = 'Down — now push.';
    } else if (this.state === STATE.DOWN) {
      this.minAngleThisPhase = Math.min(this.minAngleThisPhase, angle);
      if (angle >= o.upAngle) {
        const heldLongEnough = timestamp - (this.phaseStartedAt ?? timestamp) >= o.minPhaseMs;
        const notTooSoon = timestamp - this.lastRepAt >= o.minRepMs;
        if (heldLongEnough && notTooSoon) {
          this.reps += 1;
          this.lastRepAt = timestamp;
          this.lastRepDepth = this.minAngleThisPhase;
          repCompleted = true;
          this.feedback = this.#depthFeedback(this.minAngleThisPhase);
        } else {
          this.feedback = 'Too fast to count — control the rep.';
        }
        this.state = STATE.UP;
        this.phaseStartedAt = timestamp;
        this.minAngleThisPhase = 180;
      } else {
        this.feedback = 'Pushing up…';
      }
    } else if (angle >= o.upAngle) {
      if (this.state !== STATE.UP) this.phaseStartedAt = timestamp;
      this.state = STATE.UP;
      this.feedback = 'Top position — go down.';
    } else if (this.state === STATE.UNKNOWN) {
      this.feedback = 'Extend your arms to set the top position.';
    } else {
      this.feedback = 'Lower your chest.';
    }

    return this.#snapshot(repCompleted, angle);
  }

  #depthFeedback(depth) {
    if (depth <= 80) return 'Rep counted — great depth.';
    if (depth <= 95) return 'Rep counted.';
    return 'Rep counted — try going a little lower.';
  }

  #snapshot(repCompleted, angle) {
    return {
      reps: this.reps,
      repCompleted,
      state: this.state,
      angle,
      rawAngle: angle,
      plankAngle: this.plankAngle,
      inPlank: this.state !== STATE.UNKNOWN || this.plankAngle === null,
      depth: this.state === STATE.DOWN ? this.minAngleThisPhase : null,
      lastRepDepth: this.lastRepDepth,
      feedback: this.feedback,
    };
  }
}
