/**
 * What the push-up scene shows, worked out from the server's state.
 *
 * Pure and DOM-free so the words and numbers chat sees can be tested. The page
 * only copies these fields into elements.
 */

const format = (n) => Number(n).toLocaleString("en-US");

/** Rest timer as m:ss. */
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const TRACK_TEXT = {
  holding: "TRACKING…",
  locking: "TRACKING…",
  searching: "NO BODY IN FRAME",
};

/**
 * @param {object} state Server state (`/api/state`).
 * @param {{pendingReps?: number, display?: "goal"|"left", now?: number,
 *          tracking?: string|null, cameraDown?: boolean}} [context]
 */
export function hudModel(state, context = {}) {
  const {
    pendingReps = 0,
    display = "goal",
    now = Date.now(),
    tracking = null,
    cameraDown = false,
  } = context;
  const session = state.session ?? null;
  const done = (state.done ?? 0) + pendingReps;
  const target = session?.target ?? (state.owed > 0 ? state.owed : null);
  const complete = target !== null && done >= target;

  let phase = session?.phase ?? "ready";
  let phaseText = "READY";
  if (phase === "active") phaseText = `SET ${session.setNumber} LIVE`;
  if (phase === "rest") {
    const since = session.restStartedAt
      ? Date.parse(session.restStartedAt)
      : now;
    phaseText =
      session.pausedBy === "scene" ? "PAUSED" : `RESTING ${clock(now - since)}`;
  }
  if (phase === "ready" && complete) {
    phase = "done";
    phaseText = "GOAL COMPLETE";
  }
  if (session && session.requireArm === false && phase === "ready")
    phaseText = "COUNTING";

  // Uncertainty is said in words while a set is running, and never changes the
  // number: confirmed reps stay confirmed.
  let trackText = null;
  if (cameraDown) trackText = "CAMERA OFF · COUNT SAVED";
  else if (phase === "active" && tracking && TRACK_TEXT[tracking])
    trackText = TRACK_TEXT[tracking];

  const rawLeft = (state.rawLeft ?? state.left ?? 0) - pendingReps;
  const big = display === "left" ? format(Math.max(0, rawLeft)) : format(done);
  const targetText =
    display === "goal" && target !== null ? `/ ${format(target)}` : null;

  const fraction =
    target !== null && target > 0 ? Math.min(1, Math.max(0, done / target)) : 0;
  const ticks =
    target !== null && target > 0
      ? (session?.milestones ?? [])
          .filter((m) => m.at > 0 && m.at < target)
          .map((m) => ({
            pct: (m.at / target) * 100,
            reached: done >= m.at,
            label: m.label,
          }))
      : [];

  const next = (session?.milestones ?? []).find((m) => m.at > done);
  let progressText;
  if (target === null) progressText = `${format(done)} this stream`;
  else if (complete)
    progressText =
      done > target
        ? `Goal done · ${format(done - target)} extra`
        : "Goal done";
  else progressText = `${format(target - done)} to go`;
  if (next && (target === null || next.at <= target))
    progressText += ` · next: ${next.label || next.at} at ${format(next.at)}`;

  // The big number is the stream total and the combo pill is the live streak,
  // so this line carries only what neither of those says.
  const setline = session
    ? [
        session.setNumber > 0
          ? `SET ${session.setNumber}: <b>${format(session.setReps)}</b>`
          : null,
        session.sessionBest > 1
          ? `BEST STREAK <b>${format(session.sessionBest)}</b>`
          : null,
      ].filter(Boolean)
    : [];

  const boss = session?.boss ?? null;

  return {
    phase,
    phaseText,
    trackText,
    big,
    targetText,
    fraction,
    ticks,
    progressText,
    setline,
    boss: boss
      ? {
          name: boss.name,
          stage: boss.stage,
          stageIndex: boss.stageIndex,
          hpFraction: boss.maxHp > 0 ? boss.hp / boss.maxHp : 0,
          hpText: `${format(boss.hp)} / ${format(boss.maxHp)} HP`,
        }
      : null,
    done,
    target,
    complete,
  };
}

/**
 * Celebrations to play: only ones that arrived after the page loaded. The ids
 * present in the first state are marked seen, so a reload never replays a goal.
 */
export class CelebrationGate {
  #seen = new Set();
  #primed = false;

  /** @returns {Array<{id: string, kind: string, label: string}>} */
  take(state) {
    const list = state?.session?.celebrations ?? [];
    if (!this.#primed) {
      for (const c of list) this.#seen.add(c.id);
      this.#primed = true;
      return [];
    }
    const fresh = list.filter((c) => !this.#seen.has(c.id));
    for (const c of fresh) this.#seen.add(c.id);
    return fresh;
  }
}

/**
 * Quality of what the camera gives the counter, in plain words. Built only
 * from what was measured: framing advice comes from the landmarks, the rate
 * from the frames actually processed.
 *
 * @param {{framing: {ok: boolean, code: string, message: string}|null,
 *          tracking: string|null, sampleRate: number}} input
 */
export function trackingQuality({ framing, tracking, sampleRate }) {
  if (!framing || framing.code === "no-pose" || tracking === "searching")
    return { level: "none", text: "No one in frame" };
  if (sampleRate > 0 && sampleRate < 10)
    return {
      level: "poor",
      text: `Only ${Math.round(sampleRate)} frames a second. Bring the tracker window forward.`,
    };
  if (!framing.ok) return { level: "poor", text: framing.message };
  if (tracking === "holding" || tracking === "locking")
    return { level: "fair", text: "Arm briefly hidden; keeping the rep." };
  if (sampleRate > 0 && sampleRate < 20)
    return {
      level: "fair",
      text: `${Math.round(sampleRate)} frames a second; fast reps may be missed.`,
    };
  return { level: "good", text: "Good: whole body in view, arm tracked." };
}
