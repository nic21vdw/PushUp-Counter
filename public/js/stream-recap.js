/**
 * The per-stream log and the end-of-stream recap built from it.
 *
 * The server appends one JSON line per thing that happened to
 * `stream-log.jsonl`, keyed by the stream it belongs to (`streamStartedAt`).
 * Nothing here reads or writes `state.json`: the log is a record of what
 * happened, never a source for the count.
 *
 * Line shapes (`v: 1`):
 *   start    a stream began: carriedOver, baselineSubs, subs, subsEnabled
 *   event    a session event (camera rep, correction, set start/finish...):
 *            kind, delta, set, note, done, setReps, best
 *   subs     the sub count moved: subs, delta, gained, exact, switched,
 *            names (empty until a feed that names subscribers exists)
 *   discard  a stream reset that was taken back; that stream never happened
 *
 * Pure, shared by the server and the recap page.
 */

export const LOG_VERSION = 1;
const HOUR_MS = 3_600_000;
const MAX_HOURS = 48;

export const SOURCE_LABELS = {
  camera: "Camera",
  "chat-correction": "Chat fixes",
  "manual-plus": "By hand",
};

export const CORRECTION_KINDS = [
  "chat-correction",
  "manual-plus",
  "manual-minus",
  "undo",
  "reset-set",
  "undo-reset",
];

/** Lines that do not parse (a torn last write) are skipped, never fatal. */
export function parseStreamLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && record.stream)
        out.push(record);
    } catch {
      /* torn line */
    }
  }
  return out;
}

function groupByStream(records) {
  const streams = new Map();
  for (const r of records) {
    if (!streams.has(r.stream)) streams.set(r.stream, []);
    streams.get(r.stream).push(r);
  }
  return streams;
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * Everything the recap card shows, for one stream.
 *
 * @param {object[]} records every parsed line of the log
 * @param {string} id the stream (its `streamStartedAt`)
 * @param {{now?: number, live?: boolean}} [opts] a live stream's chart runs
 *   up to now rather than to its last event
 */
export function buildRecap(
  records,
  id,
  { now = Date.now(), live = false } = {},
) {
  const lines = records.filter((r) => r.stream === id);
  const startedAtMs = ms(id) ?? ms(lines[0]?.at);
  if (startedAtMs === null) return null;

  const start = lines.find((r) => r.type === "start") ?? null;
  const events = lines.filter((r) => r.type === "event");
  const subs = lines.filter((r) => r.type === "subs");

  let lastAt = startedAtMs;
  for (const r of lines) lastAt = Math.max(lastAt, ms(r.at) ?? lastAt);
  const endedAtMs = live ? Math.max(lastAt, now) : lastAt;

  let total = 0;
  let netDelta = 0;
  let bestStreak = 0;
  const sets = new Map();
  const sources = new Map();
  const corrections = Object.fromEntries(CORRECTION_KINDS.map((k) => [k, 0]));
  const hours = Math.min(
    MAX_HOURS,
    Math.max(1, Math.ceil((endedAtMs - startedAtMs) / HOUR_MS)),
  );
  const perHour = Array.from({ length: hours }, (_, hour) => ({
    hour,
    reps: 0,
  }));

  for (const e of events) {
    const delta = Number(e.delta) || 0;
    netDelta += delta;
    if (Number.isFinite(e.done)) total = e.done;
    if (Number.isFinite(e.best)) bestStreak = Math.max(bestStreak, e.best);
    if (e.kind in corrections) corrections[e.kind] += 1;
    if (delta > 0 && e.kind in SOURCE_LABELS)
      sources.set(e.kind, (sources.get(e.kind) ?? 0) + delta);

    const at = ms(e.at);
    if (at !== null && delta !== 0) {
      const bucket = Math.min(
        hours - 1,
        Math.max(0, Math.floor((at - startedAtMs) / HOUR_MS)),
      );
      perHour[bucket].reps += delta;
    }

    const set = Number(e.set) || 0;
    if (set > 0) {
      const entry = sets.get(set) ?? {
        set,
        reps: 0,
        startedAt: e.at,
        endedAt: e.at,
        best: 0,
      };
      entry.reps += delta;
      entry.endedAt = e.at;
      if (Number.isFinite(e.setReps) && e.kind === "set-finish")
        entry.reps = e.setReps;
      sets.set(set, entry);
    }
  }
  if (!events.some((e) => Number.isFinite(e.done)))
    total = Math.max(0, netDelta);

  const setList = [...sets.values()]
    .map((s) => ({ ...s, reps: Math.max(0, s.reps) }))
    .filter((s) => s.reps > 0)
    .sort((a, b) => a.set - b.set);
  const bestSet = setList.reduce(
    (best, s) => (best === null || s.reps > best.reps ? s : best),
    null,
  );

  const realSubs = subs.filter((s) => !s.switched);
  const lastSubs = subs.at(-1);
  const subsGained = Number.isFinite(lastSubs?.gained)
    ? Math.max(0, lastSubs.gained)
    : realSubs.reduce((n, s) => n + Math.max(0, Number(s.delta) || 0), 0);
  const subBursts = realSubs
    .filter((s) => Number(s.delta) > 0)
    .map((s) => ({ at: s.at, delta: s.delta, exact: Boolean(s.exact) }))
    .sort((a, b) => b.delta - a.delta || Date.parse(a.at) - Date.parse(b.at))
    .slice(0, 5);

  const names = new Map();
  for (const s of subs)
    for (const name of Array.isArray(s.names) ? s.names : [])
      if (typeof name === "string" && name.trim())
        names.set(name.trim(), (names.get(name.trim()) ?? 0) + 1);

  return {
    id,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    live,
    total,
    carriedOver: start?.carriedOver ?? null,
    subsEnabled: start?.subsEnabled ?? subs.length > 0,
    sets: setList,
    setCount: setList.length,
    bestSet,
    bestStreak,
    perHour: perHour.map((h) => ({ ...h, reps: Math.max(0, h.reps) })),
    corrections,
    sources: [...sources.entries()]
      .map(([kind, reps]) => ({
        kind,
        label: SOURCE_LABELS[kind] ?? kind,
        reps,
      }))
      .filter((s) => s.reps > 0)
      .sort((a, b) => b.reps - a.reps),
    subsGained,
    subBursts,
    contributors: {
      available: names.size > 0,
      names: [...names.entries()]
        .map(([name, subs]) => ({ name, subs }))
        .sort((a, b) => b.subs - a.subs)
        .slice(0, 5),
    },
    discarded: lines.some((r) => r.type === "discard"),
  };
}

/** One line per stream, newest first. Discarded streams are left out. */
export function listStreams(
  records,
  { now = Date.now(), current = null } = {},
) {
  const out = [];
  for (const id of groupByStream(records).keys()) {
    const recap = buildRecap(records, id, { now, live: id === current });
    if (!recap || recap.discarded) continue;
    out.push({
      id,
      startedAt: recap.startedAt,
      endedAt: recap.endedAt,
      durationMs: recap.durationMs,
      total: recap.total,
      setCount: recap.setCount,
      bestSet: recap.bestSet?.reps ?? 0,
      subsGained: recap.subsGained,
      current: id === current,
    });
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
