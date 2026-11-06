/**
 * Push-up sources beyond YouTube: Twitch subs, Kick follows and Kick subs.
 *
 * Each source keeps its own count and adds its own gain into the same owed
 * total as YouTube. A gain only counts while the source is switched on, is
 * configured, and its platform says the channel is live. Pure functions only,
 * shared by the server and the tests; nothing here touches the network.
 *
 * Per source:
 *   count     last good reading from the platform
 *   baseline  the count the current live stretch is measured from, or null
 *   banked    gains from earlier live stretches of this stream
 *   live      what the platform last said
 *
 * gained = banked + max(0, count - baseline). The baseline follows the count
 * down, like YouTube's, so the next follower is always worth one push-up.
 */

export const SOURCES = [
  {
    id: "twitch-subs",
    platform: "twitch",
    label: "Twitch subs",
    unit: "sub",
  },
  {
    id: "kick-follows",
    platform: "kick",
    label: "Kick follows",
    unit: "follow",
  },
  {
    id: "kick-subs",
    platform: "kick",
    label: "Kick subs",
    unit: "sub",
  },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);

const whole = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

function blank() {
  return {
    enabled: false,
    count: null,
    baseline: null,
    banked: 0,
    live: false,
    updatedAt: null,
  };
}

export function normalizeSources(raw) {
  const out = {};
  for (const id of SOURCE_IDS) {
    const s = raw && typeof raw === "object" ? raw[id] : null;
    const base = blank();
    if (s && typeof s === "object") {
      base.enabled = s.enabled === true;
      base.count = whole(s.count);
      base.baseline = whole(s.baseline);
      base.banked = whole(s.banked) ?? 0;
      base.live = s.live === true;
      base.updatedAt = typeof s.updatedAt === "string" ? s.updatedAt : null;
    }
    out[id] = base;
  }
  return out;
}

function segment(s) {
  if (s.baseline === null || s.count === null) return 0;
  return Math.max(0, s.count - s.baseline);
}

export function sourceGained(s) {
  return s.banked + segment(s);
}

function fold(s) {
  s.banked += segment(s);
  s.baseline = null;
}

/**
 * A good reading arrived. `active` is switched on and configured. Going
 * offline banks the stretch at the previous count, so a follow that lands
 * after the stream ended adds nothing.
 */
export function applyReading(s, { count, live }, { active, now }) {
  const next = whole(count);
  if (next === null) throw new Error("count must be a whole number");
  const before = sourceGained(s);
  if (!active || (s.live && !live)) fold(s);
  s.count = next;
  s.live = Boolean(live);
  s.updatedAt = new Date(now).toISOString();
  if (active && s.live) {
    if (s.baseline === null || next < s.baseline) s.baseline = next;
  }
  return sourceGained(s) - before;
}

/**
 * The panel's switch. Off keeps what was gained while on. On starts a fresh
 * baseline at the next reading, so turning a source on mid-stream adds nothing
 * by itself.
 */
export function setSourceEnabled(s, enabled) {
  fold(s);
  s.enabled = Boolean(enabled);
}

/** A new stream: what each source gained is already in `carriedOver`. */
export function resetSourceForNewStream(s) {
  s.banked = 0;
  s.baseline = null;
}
