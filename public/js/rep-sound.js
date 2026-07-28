/**
 * The noise a counted rep makes.
 *
 * Mid-set your head is down and the number is off to the side, so the only
 * honest confirmation the tracker can give you is one you can hear. This is
 * that: a short two-tone chirp on every rep the detector banks.
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
export const DEFAULT_VOLUME = 0.5;

const ATTACK_S = 0.006;
const DECAY_S = 0.11;
const LOW_HZ = 880;
const HIGH_HZ = 1320;

export class RepSound {
  /**
   * @param {{enabled?: boolean, volume?: number,
   *          contextFactory?: () => AudioContext|null}} [options]
   */
  constructor({ enabled = true, volume = DEFAULT_VOLUME, contextFactory = defaultContext } = {}) {
    this.enabled = enabled;
    this.volume = clamp(volume);
    this.contextFactory = contextFactory;
    this.ctx = null;
    this.failed = false;
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
   * Chirp once. Called from the rep detector, so it never throws and never
   * blocks: a broken speaker must not be able to stop a push-up being counted.
   */
  play() {
    if (!this.arm()) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    // Exponential ramps cannot reach zero, so the floor is a hair above it and
    // the node is stopped rather than faded to nothing.
    const peak = Math.max(0.0001, this.volume);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + DECAY_S);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    // A rising interval reads as "done" where a flat tone reads as an alarm.
    osc.frequency.setValueAtTime(LOW_HZ, now);
    osc.frequency.exponentialRampToValueAtTime(HIGH_HZ, now + ATTACK_S * 4);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + DECAY_S);
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
