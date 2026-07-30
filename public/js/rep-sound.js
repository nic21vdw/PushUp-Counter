/**
 * The noise a counted rep makes.
 *
 * Mid-set your head is down and the number is off to the side, so the only
 * honest confirmation the tracker can give you is one you can hear. This is
 * that: a short arcade blip on every rep the detector banks.
 *
 * The presets below are written in the chiptune idiom on purpose — a square
 * wave two-note pickup reads as "got it" to anyone who has held a controller,
 * and reads that way in under a fifth of a second, which is all the room there
 * is between reps. They are original note sequences rather than lifts of any
 * particular game's jingle: the point is the shared vocabulary, not the tune.
 *
 * Synthesised rather than loaded from a file — there is no asset to fetch, miss,
 * or serve stale, and a rep at the moment the page is still fetching a wav is a
 * rep you get no answer to.
 *
 * Kept free of the DOM and of a real AudioContext at construction time so the
 * rules below can be tested, and so a browser with audio blocked degrades to
 * silence instead of throwing inside the detection loop.
 */

/** Volume 0 is silence, 1 is as loud as the tab goes. */
export const DEFAULT_VOLUME = 0.45;

/**
 * Every note: `at` and `dur` in seconds from the start of the sound, `hz` its
 * pitch, `to` an optional pitch to glide to, `gain` its share of the volume.
 *
 * Nothing here runs past 220 ms. A sound still playing when the next rep lands
 * stops being feedback and starts being noise, and a fast set is barely 300 ms
 * a rep.
 */
export const PRESETS = {
  /** Two-note pickup. The default: unmistakably "counted", and over instantly. */
  coin: [
    { at: 0, dur: 0.05, hz: 1046, type: 'square', gain: 0.7 },
    { at: 0.045, dur: 0.13, hz: 1568, type: 'square', gain: 0.7 },
  ],
  /** Four-note run up. Bigger, still short — for milestone-feeling sets. */
  powerup: [
    { at: 0, dur: 0.05, hz: 523, type: 'square', gain: 0.55 },
    { at: 0.045, dur: 0.05, hz: 659, type: 'square', gain: 0.55 },
    { at: 0.09, dur: 0.05, hz: 784, type: 'square', gain: 0.55 },
    { at: 0.135, dur: 0.075, hz: 1046, type: 'square', gain: 0.6 },
  ],
  /** Bubble. The quietest of them, and the one that survives a long set. */
  pop: [{ at: 0, dur: 0.09, hz: 900, to: 260, type: 'sine', gain: 0.9 }],
  /** Cartoon spring. Funny once an hour; you have been warned. */
  boing: [
    { at: 0, dur: 0.07, hz: 420, to: 780, type: 'triangle', gain: 0.8 },
    { at: 0.065, dur: 0.14, hz: 780, to: 180, type: 'triangle', gain: 0.8 },
  ],
  /** The plain rising beep. No character, no jokes, reads at any volume. */
  chirp: [{ at: 0, dur: 0.11, hz: 880, to: 1320, type: 'triangle', gain: 1 }],
};

/** Preset used when the sound is on but nothing specific was asked for. */
export const DEFAULT_PRESET = 'coin';

const ATTACK_S = 0.005;
const FLOOR = 0.0001;

export class RepSound {
  /**
   * @param {{preset?: string|null, volume?: number,
   *          contextFactory?: () => AudioContext|null}} [options]
   */
  constructor({ preset = DEFAULT_PRESET, volume = DEFAULT_VOLUME, contextFactory = defaultContext } = {}) {
    this.preset = preset && preset in PRESETS ? preset : preset ? DEFAULT_PRESET : null;
    this.volume = clamp(volume);
    this.contextFactory = contextFactory;
    this.ctx = null;
    this.failed = false;
  }

  /** Whether this page should be making any noise at all. */
  get enabled() {
    return this.preset !== null;
  }

  /**
   * Open the audio device. Safe to call more than once, and safe to call from a
   * click handler — which is where it wants to be called from, because a page
   * that has never been touched is not allowed to make noise.
   *
   * @returns {boolean} whether audio is usable
   */
  arm() {
    if (this.failed || !this.enabled) return false;
    if (!this.ctx) {
      try {
        this.ctx = this.contextFactory();
      } catch {
        this.ctx = null;
      }
      if (!this.ctx) {
        this.failed = true;
        return false;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume?.().catch?.(() => {});
    return true;
  }

  /**
   * Play the sound once. Called from the rep detector, so it never throws and
   * never blocks: a broken speaker must not be able to stop a push-up being
   * counted.
   */
  play() {
    if (!this.arm()) return;

    const ctx = this.ctx;
    const start = ctx.currentTime;

    for (const note of PRESETS[this.preset]) {
      const at = start + note.at;
      const end = at + note.dur;
      // Exponential ramps cannot reach zero, so the floor is a hair above it
      // and the oscillator is stopped rather than faded to nothing.
      const peak = Math.max(FLOOR, this.volume * note.gain);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(FLOOR, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(FLOOR, end);
      gain.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.hz, at);
      if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, end);
      osc.connect(gain);
      osc.start(at);
      osc.stop(end);
    }
  }

  /**
   * One word for the setup readout. "suspended" is the answer to "why is it
   * silent" almost every time: the page has not been clicked yet.
   *
   * @returns {'off'|'blocked'|'idle'|string}
   */
  get status() {
    if (!this.enabled) return 'off';
    if (this.failed) return 'blocked';
    if (!this.ctx) return 'idle';
    return this.ctx.state ?? 'idle';
  }

  /** Live volume change, for a setup page that wants a slider one day. */
  setVolume(volume) {
    this.volume = clamp(volume);
  }

  /** Release the audio device on the way out of the page. */
  stop() {
    this.ctx?.close?.();
    this.ctx = null;
  }
}

function clamp(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function defaultContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}
