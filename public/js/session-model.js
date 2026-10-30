/**
 * Sets, streaks, goals, milestones and the boss: everything about a push-up
 * session that is not the subscriber arithmetic in `server.js`.
 *
 * Pure: every function takes the session and a clock reading and returns what
 * changed. The server owns `done`, so anything that moves the count comes back
 * as a `delta` for it to apply. Persisted inside `state.json` as `session`.
 *
 * A set is something Nic starts on purpose. Cutting to the push-up scene, or
 * the camera seeing movement, never starts one: with `requireArm` on, a camera
 * rep outside an active set is refused.
 *
 * A streak is reps in a row inside one set, each within `streakGapMs` of the
 * last. Time spent resting does not count toward that gap, and the camera
 * losing sight of him cannot end it on its own: only a rep that arrives too
 * late, finishing the set, or an undo can.
 */

export const PHASES = ["ready", "active", "rest"];

export const DEFAULT_MILESTONES = [
  { at: 10, label: "Warm-up done" },
  { at: 25, label: "Chat picks the next game" },
  { at: 50, label: "Victory lap" },
  { at: 100, label: "Century" },
];

const EVENT_CAP = 300;
const SEEN_CAP = 2000;
const CELEBRATION_CAP = 20;
const MAX_MILESTONES = 12;
const MAX_LABEL = 60;
const MAX_GOAL = 10_000;
/** A rep already on its way when the set paused still lands. */
export const LATE_REP_GRACE_MS = 1500;
/** A stream reset can be taken back for this long, if nothing was counted since. */
export const UNDO_RESET_MS = 15 * 60_000;

export function createSession() {
  return {
    phase: "ready",
    pausedBy: null,
    phaseChangedAt: null,
    setNumber: 0,
    setStartedAt: null,
    setReps: 0,
    restStartedAt: null,
    streak: 0,
    setBest: 0,
    sessionBest: 0,
    lastStreakRepAt: null,
    restMsSinceRep: 0,
    goal: null,
    milestones: DEFAULT_MILESTONES.map((m) => ({ ...m })),
    celebrated: [],
    celebrations: [],
    boss: { enabled: true, name: "Gravity Golem" },
    display: "boss",
    requireArm: true,
    streakGapMs: 15_000,
    events: [],
    seenIds: [],
    lastReset: null,
    detection: {},
  };
}

export function normalizeSession(raw) {
  const base = createSession();
  if (!raw || typeof raw !== "object") return base;
  const s = { ...base, ...raw };
  if (!PHASES.includes(s.phase)) s.phase = "ready";
  s.boss = { ...base.boss, ...(raw.boss ?? {}) };
  for (const key of [
    "milestones",
    "celebrated",
    "celebrations",
    "events",
    "seenIds",
  ])
    if (!Array.isArray(s[key])) s[key] = base[key];
  if (!s.detection || typeof s.detection !== "object") s.detection = {};
  return s;
}

const iso = (ms) => new Date(ms).toISOString();
const id = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function log(session, now, kind, delta, note = "") {
  const event = {
    id: id(),
    at: iso(now),
    kind,
    delta,
    set: session.setNumber,
    note,
  };
  session.events.push(event);
  if (session.events.length > EVENT_CAP)
    session.events.splice(0, session.events.length - EVENT_CAP);
  return event;
}

function remember(session, repIds) {
  session.seenIds.push(...repIds);
  if (session.seenIds.length > SEEN_CAP)
    session.seenIds.splice(0, session.seenIds.length - SEEN_CAP);
}

function bumpStreak(session, now) {
  const last = session.lastStreakRepAt;
  const gap =
    last === null ? Infinity : now - last - (session.restMsSinceRep ?? 0);
  session.streak = gap <= session.streakGapMs ? session.streak + 1 : 1;
  session.lastStreakRepAt = now;
  session.restMsSinceRep = 0;
  session.setBest = Math.max(session.setBest, session.streak);
  session.sessionBest = Math.max(session.sessionBest, session.streak);
}

/** Whether a camera rep reported now should be banked. */
export function acceptsCameraReps(
  session,
  now,
  requireArm = session.requireArm,
) {
  if (!requireArm || session.phase === "active") return true;
  const changed = session.phaseChangedAt
    ? Date.parse(session.phaseChangedAt)
    : -Infinity;
  return session.wasActive === true && now - changed <= LATE_REP_GRACE_MS;
}

/**
 * Camera reps, by id. An id already seen is a retry of a report the server
 * already banked (the answer was lost, or the page reloaded with it queued),
 * so it is acknowledged and not counted again.
 *
 * @returns {{delta: number, duplicates: number, refused: boolean}}
 */
export function recordCameraReps(
  session,
  { ids, now, bridged = 0, requireArm = session.requireArm },
) {
  const seen = new Set(session.seenIds);
  const fresh = [...new Set(ids)].filter((repId) => !seen.has(repId));
  const duplicates = ids.length - fresh.length;
  if (fresh.length === 0) return { delta: 0, duplicates, refused: false };
  if (!acceptsCameraReps(session, now, requireArm)) {
    return { delta: 0, duplicates, refused: true };
  }
  remember(session, fresh);
  for (let i = 0; i < fresh.length; i += 1) {
    session.setReps += 1;
    if (session.phase === "active") bumpStreak(session, now);
  }
  log(
    session,
    now,
    "camera",
    fresh.length,
    bridged > 0 ? "seen through a brief tracking gap" : "",
  );
  return { delta: fresh.length, duplicates, refused: false };
}

const clampGoal = (value) => {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL)
    throw new Error(
      `goal must be a whole number between 1 and ${MAX_GOAL}, or empty`,
    );
  return n;
};

function cleanMilestones(list) {
  if (!Array.isArray(list)) throw new Error("milestones must be a list");
  const out = [];
  for (const m of list.slice(0, MAX_MILESTONES)) {
    const at = Number(m?.at);
    if (!Number.isInteger(at) || at < 1 || at > MAX_GOAL)
      throw new Error("each milestone needs a whole number of reps");
    const label = String(m?.label ?? "")
      .trim()
      .slice(0, MAX_LABEL);
    out.push({ at, label });
  }
  out.sort((a, b) => a.at - b.at);
  return out.filter((m, i) => i === 0 || m.at !== out[i - 1].at);
}

/**
 * One control-panel action. Throws a plain Error with a sentence for anything
 * that should come back as a 400.
 *
 * @param {object} session
 * @param {{action: string}} body
 * @param {{now: number, done: number, resetStream: () => object,
 *          restoreStream: (snapshot: object) => void}} ctx
 * @returns {{delta: number, reason: string|null}}
 */
export function applyControl(session, body, ctx) {
  const { now } = ctx;
  const phaseTo = (phase, pausedBy = null) => {
    session.wasActive = session.phase === "active";
    session.phase = phase;
    session.pausedBy = pausedBy;
    session.phaseChangedAt = iso(now);
  };

  switch (body.action) {
    case "start": {
      session.setNumber += 1;
      session.setReps = 0;
      session.setStartedAt = iso(now);
      session.restStartedAt = null;
      session.streak = 0;
      session.setBest = 0;
      session.lastStreakRepAt = null;
      session.restMsSinceRep = 0;
      phaseTo("active");
      log(session, now, "set-start", 0);
      return { delta: 0, reason: `set ${session.setNumber} started` };
    }
    case "rest":
    case "scene-away": {
      if (session.phase !== "active") return { delta: 0, reason: null };
      session.restStartedAt = iso(now);
      const by = body.action === "rest" ? "rest" : "scene";
      phaseTo("rest", by);
      log(session, now, by === "rest" ? "rest" : "scene-away", 0);
      return {
        delta: 0,
        reason: by === "rest" ? "resting" : "paused: scene off",
      };
    }
    case "resume": {
      if (session.phase !== "rest") return { delta: 0, reason: null };
      const restedFor = session.restStartedAt
        ? now - Date.parse(session.restStartedAt)
        : 0;
      session.restMsSinceRep += Math.max(0, restedFor);
      session.restStartedAt = null;
      phaseTo("active");
      log(session, now, "resume", 0);
      return { delta: 0, reason: "set resumed" };
    }
    case "finish": {
      if (session.phase === "ready") return { delta: 0, reason: null };
      session.restStartedAt = null;
      session.streak = 0;
      session.lastStreakRepAt = null;
      phaseTo("ready");
      log(session, now, "set-finish", 0, `${session.setReps} reps`);
      return {
        delta: 0,
        reason: `set ${session.setNumber} finished at ${session.setReps}`,
      };
    }
    case "plus":
    case "chat": {
      session.setReps += 1;
      if (session.phase === "active") bumpStreak(session, now);
      const kind = body.action === "chat" ? "chat-correction" : "manual-plus";
      const note =
        body.action === "chat"
          ? "chat says it counted"
          : String(body.note ?? "").slice(0, MAX_LABEL);
      log(session, now, kind, 1, note);
      return {
        delta: 1,
        reason:
          body.action === "chat" ? "+1 (chat says it counted)" : "+1 by hand",
      };
    }
    case "minus": {
      if (ctx.done <= 0) throw new Error("nothing to take away");
      session.setReps = Math.max(0, session.setReps - 1);
      log(
        session,
        now,
        "manual-minus",
        -1,
        String(body.note ?? "").slice(0, MAX_LABEL),
      );
      return { delta: -1, reason: "-1 by hand" };
    }
    case "undo": {
      const last = [...session.events]
        .reverse()
        .find((e) => e.delta > 0 && !e.undone && e.kind !== "undo-reset");
      if (!last || ctx.done <= 0) throw new Error("no rep to undo");
      if (last.delta > 1) {
        last.delta -= 1;
        last.note = `${last.note ? `${last.note}; ` : ""}one undone`;
      } else {
        last.undone = true;
      }
      if (last.set === session.setNumber) {
        session.setReps = Math.max(0, session.setReps - 1);
        if (session.streak > 0) session.streak -= 1;
      }
      log(session, now, "undo", -1, `undid a ${last.kind} rep`);
      return { delta: -1, reason: `undid the last rep (${last.kind})` };
    }
    case "goal": {
      session.goal = clampGoal(body.goal);
      log(
        session,
        now,
        "goal",
        0,
        session.goal === null ? "goal cleared" : `goal ${session.goal}`,
      );
      return {
        delta: 0,
        reason: `goal set to ${session.goal ?? "subscribers"}`,
      };
    }
    case "milestones": {
      session.milestones = cleanMilestones(body.milestones);
      return { delta: 0, reason: "milestones edited" };
    }
    case "boss": {
      if ("enabled" in body) session.boss.enabled = Boolean(body.enabled);
      if (typeof body.name === "string" && body.name.trim())
        session.boss.name = body.name.trim().slice(0, 40);
      return { delta: 0, reason: null };
    }
    case "display": {
      if (!["boss", "counter"].includes(body.display))
        throw new Error("display is boss or counter");
      session.display = body.display;
      session.boss.enabled = body.display === "boss";
      return { delta: 0, reason: null };
    }
    case "settings": {
      if ("requireArm" in body) session.requireArm = Boolean(body.requireArm);
      if ("streakGapMs" in body) {
        const ms = Number(body.streakGapMs);
        if (!Number.isFinite(ms) || ms < 2000 || ms > 120_000)
          throw new Error("streak gap must be 2 to 120 seconds");
        session.streakGapMs = Math.round(ms);
      }
      if ("detection" in body)
        session.detection = cleanDetection(body.detection);
      return { delta: 0, reason: null };
    }
    case "reset-set": {
      if (body.confirm !== "RESET SET")
        throw new Error('type "RESET SET" to confirm');
      const removed = Math.min(session.setReps, ctx.done);
      session.lastReset = {
        kind: "set",
        at: iso(now),
        set: session.setNumber,
        removed,
        streak: session.streak,
        setBest: session.setBest,
      };
      session.setReps = 0;
      session.streak = 0;
      session.setBest = 0;
      session.lastStreakRepAt = null;
      log(session, now, "reset-set", -removed);
      return {
        delta: -removed,
        reason: `set ${session.setNumber} reset (${removed} reps set aside)`,
      };
    }
    case "reset-stream": {
      if (body.confirm !== "RESET STREAM")
        throw new Error('type "RESET STREAM" to confirm');
      const snapshot = ctx.resetStream();
      session.lastReset = {
        kind: "stream",
        at: iso(now),
        snapshot,
        session: {
          setNumber: session.setNumber,
          setReps: session.setReps,
          sessionBest: session.sessionBest,
          celebrated: [...session.celebrated],
        },
      };
      Object.assign(session, {
        phase: "ready",
        pausedBy: null,
        phaseChangedAt: iso(now),
        setNumber: 0,
        setReps: 0,
        streak: 0,
        setBest: 0,
        sessionBest: 0,
        lastStreakRepAt: null,
        restStartedAt: null,
        celebrated: [],
      });
      log(session, now, "reset-stream", 0);
      return { delta: 0, reason: "stream reset by hand" };
    }
    case "undo-reset": {
      const r = session.lastReset;
      if (!r) throw new Error("there is no reset to undo");
      if (now - Date.parse(r.at) > UNDO_RESET_MS)
        throw new Error("that reset is too old to undo");
      session.lastReset = null;
      if (r.kind === "set") {
        if (r.set === session.setNumber) {
          session.setReps += r.removed;
          session.streak = r.streak;
          session.setBest = r.setBest;
        }
        log(session, now, "undo-reset", r.removed, "set reset taken back");
        return { delta: r.removed, reason: `set reset undone (+${r.removed})` };
      }
      const countedSince = session.events.some(
        (e) => Date.parse(e.at) > Date.parse(r.at) && e.delta > 0,
      );
      if (countedSince)
        throw new Error(
          "reps were counted after the reset, so it cannot be undone safely",
        );
      ctx.restoreStream(r.snapshot);
      Object.assign(session, r.session, {
        phase: "ready",
        phaseChangedAt: iso(now),
      });
      log(session, now, "undo-reset", 0, "stream reset taken back");
      return { delta: 0, reason: "stream reset undone" };
    }
    default:
      throw new Error("unknown action");
  }
}

export const DETECTION_KEYS = {
  downAngle: [40, 150],
  upAngle: [110, 180],
  upTolerance: [0, 60],
  minPlankAngle: [90, 180],
  maxGapMs: [0, 5000],
  maxTorsoTiltDeg: [20, 90],
  requirePlank: "boolean",
};

function cleanDetection(input) {
  if (!input || typeof input !== "object")
    throw new Error("detection must be an object");
  const out = {};
  for (const [key, range] of Object.entries(DETECTION_KEYS)) {
    if (!(key in input) || input[key] === null || input[key] === "") continue;
    if (range === "boolean") {
      out[key] = Boolean(input[key]);
      continue;
    }
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < range[0] || n > range[1])
      throw new Error(`${key} must be between ${range[0]} and ${range[1]}`);
    out[key] = n;
  }
  if (
    out.downAngle !== undefined &&
    out.upAngle !== undefined &&
    out.downAngle + 20 > out.upAngle
  )
    throw new Error(
      "the down angle must sit at least 20 degrees below the up angle",
    );
  return out;
}

/**
 * The number the session is aiming at: a goal Nic set, or else what the
 * subscribers say he owes. Null when there is neither.
 */
export function effectiveTarget(session, { owed, subsEnabled }) {
  if (session.goal !== null) return session.goal;
  if (subsEnabled || owed > 0) return owed > 0 ? owed : null;
  return null;
}

/**
 * Record celebrations newly earned. Each milestone and each goal value is
 * celebrated once per stream: an undo that dips below and a rep that crosses
 * back do not replay it, and neither does a reload.
 */
export function celebrate(session, { done, target, now }) {
  const fresh = [];
  const once = (key, kind, label) => {
    if (session.celebrated.includes(key)) return;
    session.celebrated.push(key);
    const c = { id: id(), kind, label, at: iso(now) };
    session.celebrations.push(c);
    fresh.push(c);
  };
  for (const m of session.milestones)
    if (done >= m.at)
      once(`m:${m.at}`, "milestone", m.label || `${m.at} push-ups`);
  if (target !== null && target > 0 && done >= target) {
    once(
      `goal:${target}`,
      session.boss.enabled ? "boss" : "goal",
      session.boss.enabled ? `${session.boss.name} defeated` : "Goal complete",
    );
  }
  if (session.celebrations.length > CELEBRATION_CAP)
    session.celebrations.splice(
      0,
      session.celebrations.length - CELEBRATION_CAP,
    );
  return fresh;
}

const BOSS_STAGES = [
  [0.66, "Full strength"],
  [0.33, "Cracking"],
  [0, "Crumbling"],
];

export function bossView(session, { done, target }) {
  if (!session.boss.enabled || target === null) return null;
  const hp = Math.max(0, target - done);
  const frac = target > 0 ? hp / target : 0;
  const stage =
    hp === 0
      ? "Defeated"
      : (BOSS_STAGES.find(([floor]) => frac > floor) ?? BOSS_STAGES.at(-1))[1];
  return {
    name: session.boss.name,
    hp,
    maxHp: target,
    stage,
    stageIndex:
      hp === 0 ? 3 : BOSS_STAGES.findIndex(([, name]) => name === stage),
  };
}

/** What every page receives. Seen ids and reset snapshots stay on the server. */
export function sessionView(session, { done, owed, subsEnabled, now }) {
  const target = effectiveTarget(session, { owed, subsEnabled });
  return {
    phase: session.phase,
    pausedBy: session.pausedBy,
    phaseChangedAt: session.phaseChangedAt,
    setNumber: session.setNumber,
    setReps: session.setReps,
    setStartedAt: session.setStartedAt,
    restStartedAt: session.restStartedAt,
    streak: session.streak,
    setBest: session.setBest,
    sessionBest: session.sessionBest,
    streakGapMs: session.streakGapMs,
    goal: session.goal,
    target,
    targetSource:
      session.goal !== null ? "goal" : target !== null ? "subs" : null,
    complete: target !== null && done >= target,
    milestones: session.milestones.map((m) => ({
      ...m,
      reached: done >= m.at,
    })),
    celebrations: session.celebrations.slice(-5),
    boss: bossView(session, { done, target }),
    bossEnabled: session.boss.enabled,
    bossName: session.boss.name,
    display: session.display,
    requireArm: session.requireArm,
    detection: session.detection,
    events: session.events.slice(-25),
    canUndoReset:
      session.lastReset !== null &&
      now - Date.parse(session.lastReset.at) <= UNDO_RESET_MS,
    lastResetKind: session.lastReset?.kind ?? null,
    serverNow: iso(now),
  };
}
