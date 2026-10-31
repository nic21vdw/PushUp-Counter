/**
 * Turns reps and server counts into hype events.
 *
 * Pure logic: no DOM, no timers, no speech. Every clock reading comes in as an
 * argument (or from the injected `now`), so a streak, a countdown or a taunt
 * can be replayed exactly. The announcer speaks these events and the stage
 * draws them; neither one decides anything about the set.
 *
 * `left` is the raw figure and goes negative once the owner is ahead. Pass the
 * same pending-adjusted numbers to `rep` and `count`, or reps still waiting on
 * the server will look like a countdown that went backwards.
 */

/** A rep this long after the last one ends the streak. */
export const COMBO_GAP_MS = 3500;

/** Gap to the previous rep under which a rep is fast. */
export const FAST_GAP_MS = 1100;

/** Gap to the previous rep over which a rep is slow. */
export const SLOW_GAP_MS = 2800;

/** A gap this long is someone coming back, not someone slow. */
export const RESUME_GAP_MS = 8000;

/** Combo counts that earn tiers 1 to 5. */
export const COMBO_TIERS = [5, 10, 20, 35, 50];

/** The smallest streak worth mourning. */
export const MIN_BREAK_COMBO = 5;

/** Values of `left` that are announced on the way down. */
export const COUNTDOWN_MARKS = [10, 5, 3, 2, 1];

/** Seconds without a rep that earn a taunt, while push-ups are left. */
export const IDLE_SECONDS = [20, 45, 90];

/** Reps past zero between `ahead` events. */
export const AHEAD_EVERY = 5;

/** Sloppy reps in a row that earn a `form` event. */
export const SLOPPY_RUN = 3;

const MILESTONES = [10, 25, 50, 75, 100];
const MILESTONE_STEP = 50;
const HEAT_HALF_LIFE_S = 5;
const HEAT_FLOOR = 0.005;
const COMBO_FOR_FULL_BONUS = 40;
const SPEED_HEAT = { fast: 0.08, steady: 0.04, slow: 0 };
const GRADE_HEAT = { perfect: 0.03, great: 0.015 };

/**
 * Whether the nth rep of a session gets a milestone: 10, 25, 50, 75, 100, then
 * every 50.
 *
 * @param {number} n
 */
export const isMilestone = (n) =>
  MILESTONES.includes(n) || (n > 100 && n % MILESTONE_STEP === 0);

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export class HypeDirector {
  #now;
  #started = false;
  #left = null;
  #done = 0;
  #owed = null;
  #reps = 0;
  #combo = 0;
  #lastRepAt = null;
  #heat = 0;
  #heatAt = null;
  #sloppyRun = 0;
  #fired = new Set();
  #aheadHigh = 0;
  #finished = false;
  #idleSince = null;
  #idleFired = 0;
  #comboGapMs = COMBO_GAP_MS;

  /**
   * @param {{now?: () => number, random?: () => number}} [options] `random`
   *   is accepted for symmetry with the announcer; nothing here is random.
   */
  constructor({
    now = () => performance.now(),
    comboGapMs = COMBO_GAP_MS,
  } = {}) {
    this.#now = now;
    this.#comboGapMs = comboGapMs;
  }

  /** Follow the session's streak definition, so the combo and the streak agree. */
  setComboGap(ms) {
    if (Number.isFinite(ms) && ms > 0) this.#comboGapMs = ms;
  }

  /**
   * Time spent resting is not a gap between reps. Moves the last rep forward
   * by the pause so the streak survives it, and restarts the idle clock.
   */
  resume(pausedMs, at = this.#now()) {
    if (this.#lastRepAt !== null && Number.isFinite(pausedMs) && pausedMs > 0)
      this.#lastRepAt += pausedMs;
    this.#idleSince = at;
    this.#idleFired = 0;
  }

  /** Reps in the current streak. Zero once a pause has ended it. */
  get combo() {
    return this.#combo;
  }

  /** Intensity from 0 to 1 for the visuals. Rises with streak and speed. */
  get heat() {
    return this.#heat;
  }

  /**
   * The set begins. Emits `start` once; later calls only refresh the numbers.
   *
   * @param {{left: number, done: number, owed: number}} state
   */
  start(state = {}) {
    const observed = this.#observe(state);
    if (this.#started) return observed;
    this.#started = true;
    this.#idleSince = this.#now();
    this.#idleFired = 0;
    return [this.#event("start")];
  }

  /**
   * A rep landed.
   *
   * @param {{at?: number, left: number, done: number, owed: number,
   *          rep?: {grade: string, score: number}|null}} input `rep` is null
   *   for an ungraded rep, such as one seen only as the server's total rising.
   */
  rep({ at = this.#now(), left, done, owed, rep = null } = {}) {
    const events = [];
    events.push(...this.#breakIfStale(at));
    this.#decay(at);

    const gap =
      this.#lastRepAt === null ? null : Math.max(0, at - this.#lastRepAt);
    const continues = gap !== null && gap < this.#comboGapMs && this.#combo > 0;
    this.#combo = continues ? this.#combo + 1 : 1;
    this.#lastRepAt = at;
    this.#reps += 1;
    this.#idleSince = at;
    this.#idleFired = 0;

    const speed = this.#speedOf(gap);
    const grade = rep?.grade ?? null;
    const score = finite(rep?.score) ? rep.score : null;
    this.#heatUp(speed, grade);

    const observed = this.#observe({ left, done, owed }, at);

    events.push(
      this.#event("rep", {
        combo: this.#combo,
        heat: this.#heat,
        grade,
        score,
        speed,
      }),
    );

    const tier = COMBO_TIERS.indexOf(this.#combo) + 1;
    if (tier > 0) {
      events.push(this.#event("combo", { tier, combo: this.#combo }));
    }
    if (isMilestone(this.#reps)) {
      events.push(this.#event("milestone", { n: this.#reps }));
    }
    events.push(...observed);

    this.#sloppyRun = grade === "sloppy" ? this.#sloppyRun + 1 : 0;
    if (this.#sloppyRun >= SLOPPY_RUN) {
      this.#sloppyRun = 0;
      events.push(this.#event("form", { grade: "sloppy" }));
    }

    return events;
  }

  /**
   * The server's numbers changed. Subscribers are spotted by `owed` rising;
   * `left` alone wobbles while unconfirmed reps settle.
   *
   * @param {{left: number, done: number, owed: number}} state
   */
  count(state = {}) {
    return this.#observe(state);
  }

  /**
   * Call about once a second: cools the heat, ends a stale streak, and taunts
   * a long silence.
   *
   * @param {number} [at]
   */
  tick(at = this.#now()) {
    this.#decay(at);
    const events = [...this.#breakIfStale(at)];

    if (this.#left !== null && this.#left > 0 && this.#idleSince !== null) {
      const seconds = (at - this.#idleSince) / 1000;
      let reached = -1;
      IDLE_SECONDS.forEach((mark, index) => {
        if (seconds >= mark) reached = index;
      });
      if (reached >= this.#idleFired) {
        this.#idleFired = reached + 1;
        events.push(this.#event("idle", { seconds: IDLE_SECONDS[reached] }));
      }
    }

    return events;
  }

  #event(type, fields = {}) {
    return { type, left: this.#left ?? 0, done: this.#done, ...fields };
  }

  #speedOf(gap) {
    if (gap === null || gap >= RESUME_GAP_MS) return "steady";
    if (gap < FAST_GAP_MS) return "fast";
    if (gap > SLOW_GAP_MS) return "slow";
    return "steady";
  }

  #breakIfStale(at) {
    if (this.#lastRepAt === null || this.#combo === 0) return [];
    if (at - this.#lastRepAt < this.#comboGapMs) return [];
    const was = this.#combo;
    this.#combo = 0;
    return was >= MIN_BREAK_COMBO
      ? [this.#event("combo-break", { combo: was })]
      : [];
  }

  #decay(at) {
    if (this.#heatAt !== null && at > this.#heatAt && this.#heat > 0) {
      const seconds = (at - this.#heatAt) / 1000;
      const cooled = this.#heat * 0.5 ** (seconds / HEAT_HALF_LIFE_S);
      this.#heat = cooled < HEAT_FLOOR ? 0 : cooled;
    }
    if (this.#heatAt === null || at > this.#heatAt) this.#heatAt = at;
  }

  #heatUp(speed, grade) {
    const streak = Math.min(1, this.#combo / COMBO_FOR_FULL_BONUS);
    const boost =
      0.06 + 0.1 * streak + SPEED_HEAT[speed] + (GRADE_HEAT[grade] ?? 0);
    this.#heat = Math.min(1, this.#heat + boost);
  }

  #observe(state, at = this.#now()) {
    const previousLeft = this.#left;
    const previousOwed = this.#owed;
    if (finite(state.left)) this.#left = state.left;
    if (finite(state.done)) this.#done = state.done;
    if (finite(state.owed)) this.#owed = state.owed;

    const left = this.#left;
    if (previousLeft === null || left === null) return [];

    const events = [];
    const added =
      previousOwed !== null && this.#owed !== null
        ? this.#owed - previousOwed
        : 0;
    if (added > 0) events.push(this.#event("subs", { added }));
    if (previousLeft <= 0 && left > 0) {
      this.#idleSince = at;
      this.#idleFired = 0;
    }

    const topMark = Math.max(...COUNTDOWN_MARKS);
    const fresh = added > 0 || left > topMark;
    if (left > topMark) this.#fired.clear();
    if (fresh) this.#finished = false;
    if (fresh && left > 0) this.#aheadHigh = 0;
    for (const mark of COUNTDOWN_MARKS) {
      if (previousLeft > mark && left <= mark) {
        if (left === mark && !this.#fired.has(mark)) {
          events.push(this.#event("countdown", { left: mark }));
        }
        this.#fired.add(mark);
      }
    }

    if (previousLeft > 0 && left <= 0 && !this.#finished) {
      this.#finished = true;
      events.push(this.#event("finished", { done: this.#done }));
    }

    const ahead = -left;
    if (ahead > 0) {
      if (ahead % AHEAD_EVERY === 0 && ahead > this.#aheadHigh) {
        events.push(this.#event("ahead", { ahead }));
      }
      this.#aheadHigh = Math.max(
        this.#aheadHigh,
        ahead - (ahead % AHEAD_EVERY),
      );
    }

    return events;
  }
}
