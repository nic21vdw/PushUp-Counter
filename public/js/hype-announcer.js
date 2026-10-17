/**
 * The hype announcer: speaks director events with the best voice the browser
 * has.
 *
 * One line per batch, picked by priority. Nothing is queued: a line that
 * matters more cuts off one that matters less, and a line that matters less
 * waits its turn by simply not being said. Plain rep lines are spoken on about
 * one rep in three, so the set sounds like a commentator and not a metronome.
 *
 * Speech here is a browser feature with sharp edges. Chrome drops an utterance
 * whose object was garbage collected, cuts long ones off after about fifteen
 * seconds, and stalls in a backgrounded tab until `resume()` is called, so the
 * utterance is held on to, `resume()` precedes every line, and a long one is
 * nudged with pause and resume while it plays.
 */

import { LINES } from "./hype-lines.js";

/**
 * How much each event matters. Higher cuts lower; plain rep lines (the lowest)
 * never cut anything.
 */
export const PRIORITY = {
  finished: 100,
  milestone: 90,
  countdown: 80,
  combo: 70,
  start: 65,
  subs: 60,
  ahead: 55,
  "combo-break": 50,
  form: 40,
  idle: 30,
  rep: 10,
};

/** Rate, pitch and loudness multiplier for each kind of line. */
export const PROFILES = {
  start: { rate: 1.1, pitch: 1.1, boost: 1 },
  rep: { rate: 1.1, pitch: 1.05, boost: 0.9 },
  fast: { rate: 1.2, pitch: 1.15, boost: 0.95 },
  slow: { rate: 1.0, pitch: 0.95, boost: 0.9 },
  subs: { rate: 1.12, pitch: 1.15, boost: 1.05 },
  ahead: { rate: 1.1, pitch: 1.1, boost: 1 },
  "combo-break": { rate: 0.95, pitch: 0.85, boost: 0.95 },
  form: { rate: 1.0, pitch: 0.9, boost: 1 },
  idle: { rate: 0.95, pitch: 0.8, boost: 0.9 },
  milestone: { rate: 1.05, pitch: 1.2, boost: 1.15 },
  finished: { rate: 1.05, pitch: 1.35, boost: 1.3 },
  countdown: { rate: 0.95, pitch: 0.8, boost: 1.05 },
  countdownClose: { rate: 0.85, pitch: 0.7, boost: 1.1 },
};

/** Combo tiers get faster and higher as the streak grows. */
export const COMBO_PROFILES = {
  1: { rate: 1.08, pitch: 1.05, boost: 1 },
  2: { rate: 1.1, pitch: 1.1, boost: 1 },
  3: { rate: 1.13, pitch: 1.17, boost: 1.05 },
  4: { rate: 1.17, pitch: 1.25, boost: 1.1 },
  5: { rate: 1.22, pitch: 1.32, boost: 1.15 },
};

/** The same line is not repeated within this many lines of its category. */
export const HISTORY = 12;

/** Chance a plain rep gets a line. */
export const REP_CHANCE = 1 / 3;

/** A perfect rep is always spoken once this many have gone by unspoken. */
export const PERFECT_EVERY = 3;

/** No stretch of plain reps stays silent longer than this. */
export const MAX_QUIET_REPS = 8;

const KEEPALIVE_MS = 8000;
const START_GRACE_MS = 1500;
const JITTER = 0.06;
const LOCAL_FALLBACK_MS = 60000;
const VOICE_FAULTS = new Set([
  "network",
  "synthesis-failed",
  "synthesis-unavailable",
  "voice-unavailable",
  "language-unavailable",
]);

const NATURAL = /natural|neural/;
const MALE_NAMES =
  /\b(guy|davis|christopher|eric|roger|ryan|brian|andrew|steffan|david|mark|daniel|alex|fred|george)\b/;

/**
 * How good a voice is for a hype announcer. Natural and neural voices first,
 * then the Google ones, then the old Microsoft three. Negative means unusable.
 *
 * @param {{name?: string, lang?: string}} voice
 */
export function rankVoice(voice) {
  const lang = voice?.lang ?? "en";
  if (!/^en/i.test(lang)) return -1;
  const name = (voice?.name ?? "").toLowerCase();

  let score = 10;
  if (NATURAL.test(name)) score = 100;
  else if (name.includes("online")) score = 90;
  else if (/premium|enhanced/.test(name)) score = 75;
  else if (name.includes("google uk english male")) score = 60;
  else if (name.includes("google us english")) score = 55;
  else if (name.includes("microsoft david")) score = 40;
  else if (name.includes("microsoft mark")) score = 35;
  else if (name.includes("microsoft zira")) score = 30;

  if (MALE_NAMES.test(name)) score += 6;
  if (/^en[-_]us$/i.test(lang)) score += 2;
  return score;
}

/**
 * The best English voice on offer, or null to leave the browser on its own.
 *
 * @param {Array<{name?: string, lang?: string}>} voices
 */
export function pickVoice(voices) {
  let best = null;
  let bestScore = -1;
  for (const voice of voices ?? []) {
    const score = rankVoice(voice);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template, vars) {
  let complete = true;
  const text = template.replace(PLACEHOLDER, (_, key) => {
    const value = vars[key];
    if (value === undefined || value === null || Number.isNaN(value)) {
      complete = false;
      return "";
    }
    return typeof value === "number" ? String(Math.round(value)) : value;
  });
  return complete && !/[{}]/.test(text) ? text : null;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const HEADLINE = {
  milestone: (e) => e.n,
  combo: (e) => e.combo,
  "combo-break": (e) => e.combo,
  countdown: (e) => e.left,
  finished: (e) => e.done,
  ahead: (e) => e.ahead,
  subs: (e) => e.added,
  idle: (e) => e.seconds,
  rep: (e) => e.combo,
};

export class HypeAnnouncer {
  /**
   * @param {{speech?: SpeechSynthesis, Utterance?: typeof SpeechSynthesisUtterance,
   *          lines?: typeof LINES, random?: () => number, now?: () => number,
   *          volume?: number, setTimer?: typeof setTimeout,
   *          clearTimer?: typeof clearTimeout}} [options]
   */
  constructor({
    speech = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    lines = LINES,
    random = Math.random,
    now = () => performance.now(),
    volume = 0.8,
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
  } = {}) {
    this.speech = speech;
    this.Utterance = Utterance;
    this.lines = lines;
    this.random = random;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.volume = clamp(Number.isFinite(volume) ? volume : 0.8, 0, 1);
    this.enabled = true;
    this.voices = [];
    this.voice = null;
    this.current = null;
    this.timer = null;
    this.tokens = 0;
    this.history = new Map();
    this.quiet = 0;
    this.perfects = 0;
    this.context = { left: null, done: null, combo: null };
    this.spoken = null;
    this.lastError = null;
    this.localUntil = 0;

    this.onVoices = () => this.#refreshVoices();
    this.#refreshVoices();
    try {
      if (speech?.addEventListener) {
        speech.addEventListener("voiceschanged", this.onVoices);
      } else if (speech && "onvoiceschanged" in speech) {
        speech.onvoiceschanged = this.onVoices;
      }
    } catch {
      this.voices = [];
    }
  }

  /** The last line actually spoken, or null. */
  get lastLine() {
    return this.spoken;
  }

  /** Whether a line is being said right now. */
  get speaking() {
    return this.#active() !== null;
  }

  /** Name of the voice in use, or null for the browser's own. */
  get voiceName() {
    return this.voice?.name ?? null;
  }

  /** Live volume change, 0 to 1. */
  setVolume(volume) {
    const value = Number(volume);
    if (Number.isFinite(value)) this.volume = clamp(value, 0, 1);
  }

  /** Off silences the line in progress and stops new ones. */
  setEnabled(enabled) {
    const was = this.enabled;
    this.enabled = Boolean(enabled);
    if (was && !this.enabled) this.cancel();
  }

  /** Cut off whatever is being said. */
  cancel() {
    if (!this.current) return;
    this.#settle(this.current.token);
    try {
      this.speech?.cancel?.();
    } catch {
      this.current = null;
    }
  }

  /** Stop listening for voices. Call when the page goes away. */
  dispose() {
    try {
      this.speech?.removeEventListener?.("voiceschanged", this.onVoices);
    } catch {
      this.voices = [];
    }
    this.cancel();
  }

  /**
   * Speak the most important event in the batch, if it is allowed to be heard.
   *
   * @param {Array<object>} events director events
   * @returns {string|null} the line spoken, or null
   */
  handle(events) {
    if (!this.enabled || !Array.isArray(events) || events.length === 0)
      return null;
    if (!this.speech?.speak || !this.Utterance) return null;

    for (const event of events) this.#remember(event);
    const rep = events.find((event) => event?.type === "rep");
    const repOpen = rep ? this.#repGate(rep) : false;

    const ranked = events
      .filter((event) => event && event.type in PRIORITY)
      .sort((a, b) => PRIORITY[b.type] - PRIORITY[a.type]);

    for (const event of ranked) {
      const priority = PRIORITY[event.type];
      if (event.type === "rep" && (!repOpen || event !== rep)) continue;
      if (!this.#mayInterrupt(priority)) continue;
      const choice = this.#choose(event);
      if (!choice) continue;
      if (this.#speak(choice.text, choice.profile, priority)) {
        this.quiet = 0;
        this.perfects = 0;
        return choice.text;
      }
    }
    return null;
  }

  #refreshVoices() {
    try {
      this.voices = this.speech?.getVoices?.() ?? [];
    } catch {
      this.voices = [];
    }
    this.voice = pickVoice(this.voices);
  }

  #remember(event) {
    if (!event) return;
    for (const key of ["left", "done", "combo"]) {
      if (Number.isFinite(event[key])) this.context[key] = event[key];
    }
  }

  #repGate(event) {
    this.quiet += 1;
    if (event.grade === "perfect") this.perfects += 1;
    return (
      this.quiet >= MAX_QUIET_REPS ||
      this.perfects >= PERFECT_EVERY ||
      this.random() < REP_CHANCE
    );
  }

  #active() {
    const current = this.current;
    return current && this.now() < current.until ? current : null;
  }

  #mayInterrupt(priority) {
    const current = this.#active();
    if (!current) return true;
    if (priority > current.priority) return true;
    return priority === current.priority && priority > PRIORITY.rep;
  }

  #vars(event) {
    const vars = { ...this.context, ...event };
    const headline = HEADLINE[event.type]?.(vars);
    vars.n = event.n ?? headline ?? vars.done;
    if (!(vars.left > 0)) delete vars.left;
    return vars;
  }

  #banks(event) {
    const lines = this.lines ?? {};
    const profile = this.#profile(event);
    switch (event.type) {
      case "rep": {
        const grade = event.grade ?? "good";
        const graded = {
          key: `rep.${grade}`,
          bank: lines.rep?.[grade],
          profile,
        };
        if (event.speed === "fast" && this.random() < 0.5) {
          return [
            { key: "fast", bank: lines.fast, profile: PROFILES.fast },
            graded,
          ];
        }
        if (event.speed === "slow" && this.random() < 0.5) {
          return [
            { key: "slow", bank: lines.slow, profile: PROFILES.slow },
            graded,
          ];
        }
        return [graded];
      }
      case "combo":
        return [
          {
            key: `combo.${event.tier}`,
            bank: lines.combo?.[event.tier],
            profile,
          },
        ];
      case "combo-break":
        return [{ key: "comboBreak", bank: lines.comboBreak, profile }];
      case "countdown":
        return [
          {
            key: `countdown.${event.left}`,
            bank: lines.countdown?.[event.left],
            profile,
          },
        ];
      default:
        return [{ key: event.type, bank: lines[event.type], profile }];
    }
  }

  #profile(event) {
    if (event.type === "combo") {
      return COMBO_PROFILES[event.tier] ?? COMBO_PROFILES[1];
    }
    if (event.type === "countdown") {
      return event.left <= 3 ? PROFILES.countdownClose : PROFILES.countdown;
    }
    return PROFILES[event.type] ?? PROFILES.rep;
  }

  #choose(event) {
    const vars = this.#vars(event);
    for (const { key, bank, profile } of this.#banks(event)) {
      const text = this.#pick(key, bank, vars);
      if (text) return { text, profile };
    }
    return null;
  }

  #pick(key, bank, vars) {
    if (!Array.isArray(bank)) return null;
    const usable = bank
      .filter((line) => typeof line === "string")
      .map((template) => ({ template, text: fill(template, vars) }))
      .filter((entry) => entry.text !== null);
    if (usable.length === 0) return null;

    const history = this.history.get(key) ?? [];
    const keep = Math.min(HISTORY, usable.length - 1);
    const recent = keep > 0 ? history.slice(-keep) : [];
    const fresh = usable.filter((entry) => !recent.includes(entry.template));
    const pool = fresh.length > 0 ? fresh : usable;
    const chosen = pool[Math.floor(this.random() * pool.length) % pool.length];

    history.push(chosen.template);
    this.history.set(key, history.slice(-HISTORY));
    return chosen.text;
  }

  #speak(text, profile, priority) {
    const speech = this.speech;
    try {
      if (this.voices.length === 0) this.#refreshVoices();
      if (this.current || speech.speaking || speech.pending) speech.cancel?.();
      speech.resume?.();

      const utterance = new this.Utterance(text);
      const voice = this.#voiceNow();
      if (voice) {
        utterance.voice = voice;
        if (voice.lang) utterance.lang = voice.lang;
      }
      const wobble = () => (this.random() - 0.5) * JITTER;
      utterance.rate = clamp(profile.rate + wobble(), 0.5, 2);
      utterance.pitch = clamp(profile.pitch + wobble(), 0, 2);
      utterance.volume = clamp(this.volume * profile.boost, 0, 1);

      const token = ++this.tokens;
      const estimate = this.#estimate(text, utterance.rate);
      this.current = {
        token,
        priority,
        utterance,
        until: this.now() + estimate + START_GRACE_MS,
        estimate,
      };
      utterance.onstart = () => {
        if (this.current?.token === token) {
          this.current.until = this.now() + estimate;
        }
      };
      utterance.onend = () => this.#settle(token);
      utterance.onerror = (event) => {
        const why = event?.error;
        if (why && why !== "interrupted" && why !== "canceled") {
          this.lastError = why;
          if (VOICE_FAULTS.has(why)) {
            this.localUntil = this.now() + LOCAL_FALLBACK_MS;
          }
        }
        this.#settle(token);
      };

      speech.speak(utterance);
      this.spoken = text;
      if (estimate >= KEEPALIVE_MS) this.#watch(token);
      return true;
    } catch {
      this.current = null;
      return false;
    }
  }

  #voiceNow() {
    if (this.now() >= this.localUntil) return this.voice;
    const local = this.voices.filter((voice) => voice.localService !== false);
    return pickVoice(local) ?? this.voice;
  }

  #estimate(text, rate) {
    return clamp(Math.round(600 + (text.length * 75) / rate), 900, 20000);
  }

  #settle(token) {
    if (token === undefined || this.current?.token !== token) return;
    this.current = null;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  #watch(token) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      const current = this.current;
      if (current?.token !== token) return;
      if (this.now() >= current.until) {
        this.current = null;
        return;
      }
      try {
        this.speech.pause?.();
        this.speech.resume?.();
      } catch {
        this.current = null;
        return;
      }
      this.#watch(token);
    }, KEEPALIVE_MS);
    this.timer?.unref?.();
  }
}
