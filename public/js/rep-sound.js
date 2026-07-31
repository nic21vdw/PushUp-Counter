/**
 * The noise a counted rep makes.
 *
 * Mid-set your head is down and the number is off to the side, so the only
 * honest confirmation the tracker can give you is one you can hear.
 *
 * Two kinds of sound live here. A **sample** is an audio file trimmed to the
 * part worth hearing — the default `fahh` is a 4.5 second recording that is
 * silent for its first second and reverb for its last one and a half, so it is
 * cut to the second in the middle. A **preset** is synthesised from oscillators,
 * needs no file, and is what plays if a sample cannot be loaded.
 *
 * Everything is prepared once, up front: the file is fetched, decoded and
 * trimmed at start-up, and a rep only ever triggers an already-decoded buffer.
 * Nothing is fetched, decoded or allocated on the rep itself, because that is
 * the moment the sound has to be instant.
 *
 * Kept free of the DOM and of a real AudioContext at construction time so the
 * rules below can be tested, and so a browser with audio blocked degrades to
 * silence instead of throwing inside the detection loop.
 */

/** Volume 0 is silence, 1 is as loud as the tab goes. */
export const DEFAULT_VOLUME = 0.45;

/**
 * Sounds that come from a file, and the window of each one worth playing.
 *
 * `startMs` and `durationMs` were measured off the decoded waveform, not
 * guessed. `fahh.mp3` is silent until 960ms, creeps up to a tenth of its volume
 * over the next 90ms, and only actually lands at 1050ms — so the window opens
 * at 1045, five milliseconds ahead of the attack. Starting any earlier buys
 * nothing but the lag it was cut to remove. `fadeMs` closes the window rather
 * than cutting it, which is also what takes the reverb tail off the end.
 */
export const SAMPLES = {
  fahh: { src: '/sounds/fahh.mp3', startMs: 1045, durationMs: 1000, fadeMs: 180, gain: 1 },
};

/**
 * Sounds synthesised on the spot. Every note: `at` and `dur` in seconds from
 * the start, `hz` its pitch, `to` an optional pitch to glide to, `gain` its
 * share of the volume.
 */
export const PRESETS = {
  /** Two-note arcade pickup. */
  coin: [
    { at: 0, dur: 0.05, hz: 1046, type: 'square', gain: 0.7 },
    { at: 0.045, dur: 0.13, hz: 1568, type: 'square', gain: 0.7 },
  ],
  /** Four-note run up. */
  powerup: [
    { at: 0, dur: 0.05, hz: 523, type: 'square', gain: 0.55 },
    { at: 0.045, dur: 0.05, hz: 659, type: 'square', gain: 0.55 },
    { at: 0.09, dur: 0.05, hz: 784, type: 'square', gain: 0.55 },
    { at: 0.135, dur: 0.075, hz: 1046, type: 'square', gain: 0.6 },
  ],
  /** Bubble. */
  pop: [{ at: 0, dur: 0.09, hz: 900, to: 260, type: 'sine', gain: 0.9 }],
  /** Cartoon spring. */
  boing: [
    { at: 0, dur: 0.07, hz: 420, to: 780, type: 'triangle', gain: 0.8 },
    { at: 0.065, dur: 0.14, hz: 780, to: 180, type: 'triangle', gain: 0.8 },
  ],
  /** The plain rising beep. */
  chirp: [{ at: 0, dur: 0.11, hz: 880, to: 1320, type: 'triangle', gain: 1 }],
};

/** Played when the sound is on but nothing specific was asked for. */
export const DEFAULT_PRESET = 'fahh';

/** Played while a sample is still loading, and if it never loads at all. */
export const FALLBACK_PRESET = 'coin';

/** Every name `?sound=` accepts. */
export const SOUND_NAMES = [...Object.keys(SAMPLES), ...Object.keys(PRESETS)];

// Short enough that the note starts at full weight rather than fading in. Any
// softer and the sound reads as late even when it is not.
const ATTACK_S = 0.002;
const FLOOR = 0.0001;

/**
 * Cut a decoded file down to the window worth hearing, fading the end so it
 * stops rather than being chopped off.
 *
 * Pure apart from the buffer it is handed to write into, so the arithmetic can
 * be tested without an audio device.
 *
 * @param {AudioBuffer} source decoded file
 * @param {{startMs: number, durationMs: number, fadeMs: number}} window
 * @param {(channels: number, frames: number, rate: number) => AudioBuffer} makeBuffer
 * @returns {AudioBuffer}
 */
export function trimBuffer(source, { startMs, durationMs, fadeMs }, makeBuffer) {
  const rate = source.sampleRate;
  const start = Math.max(0, Math.floor((startMs / 1000) * rate));
  const wanted = Math.floor((durationMs / 1000) * rate);
  // A window that runs off the end of the file is shortened, not padded with
  // silence — trailing silence is the thing being removed.
  const frames = Math.max(1, Math.min(wanted, source.length - start));
  const fade = Math.min(frames, Math.floor((fadeMs / 1000) * rate));

  const out = makeBuffer(source.numberOfChannels, frames, rate);

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const from = source.getChannelData(channel);
    const to = out.getChannelData(channel);
    for (let i = 0; i < frames; i++) {
      const remaining = frames - i;
      // `remaining - 1` so the very last sample lands on silence rather than a
      // fraction of the way down: a fade that stops short still clicks.
      const level = fade > 0 && remaining <= fade ? (remaining - 1) / fade : 1;
      to[i] = from[start + i] * level;
    }
  }

  return out;
}

export class RepSound {
  /**
   * @param {{preset?: string|null, volume?: number,
   *          contextFactory?: () => AudioContext|null,
   *          fetchAudio?: (src: string) => Promise<ArrayBuffer>}} [options]
   */
  constructor({
    preset = DEFAULT_PRESET,
    volume = DEFAULT_VOLUME,
    contextFactory = defaultContext,
    fetchAudio = defaultFetch,
  } = {}) {
    this.preset = resolve(preset);
    this.volume = clamp(volume);
    this.contextFactory = contextFactory;
    this.fetchAudio = fetchAudio;
    this.ctx = null;
    this.failed = false;
    this.keepAlive = null;
    this.buffer = null;
    this.loading = null;
    this.playing = null;
  }

  /** Whether this page should be making any noise at all. */
  get enabled() {
    return this.preset !== null;
  }

  /** Whether the chosen sound comes from a file. */
  get isSample() {
    return this.preset !== null && this.preset in SAMPLES;
  }

  /**
   * Open the audio device, and start loading the sound if it comes from a file.
   * Safe to call more than once, and safe to call from a click handler — which
   * is where it wants to be called from, because a page that has never been
   * touched is not allowed to make noise.
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
    this.#keepAwake();
    this.#load();
    return true;
  }

  /**
   * Hold the output device open with a silent source.
   *
   * Reps are seconds apart, and Windows powers an idle audio stream down in
   * less than that. Waking it costs 50-200ms, which lands on the front of the
   * sound and reads as lag between the rep and the noise. A node that outputs
   * nothing, forever, keeps the stream running between reps — one oscillator
   * for the life of the page.
   */
  #keepAwake() {
    if (this.keepAlive || !this.ctx.createGain || !this.ctx.createOscillator) return;
    try {
      const silence = this.ctx.createGain();
      silence.gain.setValueAtTime(0, this.ctx.currentTime ?? 0);
      silence.connect(this.ctx.destination);

      const osc = this.ctx.createOscillator();
      osc.frequency.setValueAtTime(20, this.ctx.currentTime ?? 0);
      osc.connect(silence);
      osc.start();
      this.keepAlive = osc;
    } catch {
      // A context that will not hold a silent source will still play sounds; it
      // just wakes up slower. Not worth failing over.
    }
  }

  /**
   * Fetch, decode and trim the sample, once. Reps that land before it is ready
   * fall back to a synthesised sound rather than going unacknowledged — a
   * missing noise reads as a missed rep, which is the one thing this must not
   * do.
   */
  #load() {
    if (!this.isSample || this.buffer || this.loading) return;
    const spec = SAMPLES[this.preset];
    const ctx = this.ctx;
    if (!ctx.decodeAudioData || !ctx.createBuffer) return;

    this.loading = (async () => {
      try {
        const bytes = await this.fetchAudio(spec.src);
        const decoded = await ctx.decodeAudioData(bytes);
        this.buffer = trimBuffer(decoded, spec, (channels, frames, rate) =>
          ctx.createBuffer(channels, frames, rate),
        );
      } catch {
        // Left null on purpose: `play` already knows what to do without it.
        this.buffer = null;
      }
    })();
  }

  /**
   * Play the sound once. Called from the rep detector, so it never throws and
   * never blocks: a broken speaker must not be able to stop a push-up being
   * counted.
   */
  play() {
    if (!this.arm()) return;
    if (this.buffer) this.#playSample();
    else this.#playNotes(PRESETS[this.isSample ? FALLBACK_PRESET : this.preset]);
  }

  #playSample() {
    const ctx = this.ctx;
    const at = ctx.currentTime;
    const spec = SAMPLES[this.preset];

    // A rep every 300ms against a one-second sound would stack four of them on
    // top of each other and turn a set into mush. The last one gets ducked out
    // over a few milliseconds instead — fast enough to read as a retrigger,
    // slow enough not to click.
    this.#duck(at);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(FLOOR, this.volume * spec.gain), at);
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(gain);
    source.start(at);

    this.playing = { source, gain };
  }

  #duck(at) {
    const previous = this.playing;
    if (!previous) return;
    this.playing = null;
    try {
      previous.gain.gain.cancelScheduledValues?.(at);
      previous.gain.gain.setValueAtTime?.(previous.gain.gain.value ?? FLOOR, at);
      previous.gain.gain.exponentialRampToValueAtTime?.(FLOOR, at + 0.012);
      previous.source.stop?.(at + 0.013);
    } catch {
      // A source that has already finished throws on stop. Nothing to do.
    }
  }

  #playNotes(notes) {
    const ctx = this.ctx;
    const start = ctx.currentTime;

    for (const note of notes) {
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
   * How far behind the rep the sound lands, in ms — the audio stack's own delay
   * between a scheduled sample and the speaker. Under about 30 reads as
   * instant; a figure in the hundreds is the device, not this code.
   *
   * @returns {number|null} null when nothing has opened the device yet
   */
  get latencyMs() {
    if (!this.ctx) return null;
    const base = this.ctx.baseLatency ?? 0;
    const out = this.ctx.outputLatency ?? 0;
    return Math.round((base + out) * 1000);
  }

  /**
   * One word for the setup readout. "suspended" is the answer to "why is it
   * silent" almost every time: the page has not been clicked yet.
   *
   * @returns {'off'|'blocked'|'idle'|'loading'|string}
   */
  get status() {
    if (!this.enabled) return 'off';
    if (this.failed) return 'blocked';
    if (!this.ctx) return 'idle';
    if (this.isSample && !this.buffer) return 'loading';
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
    this.keepAlive = null;
    this.buffer = null;
    this.loading = null;
    this.playing = null;
  }
}

/** A name that exists wins; anything else falls back rather than to silence. */
function resolve(preset) {
  if (preset === null || preset === undefined) return null;
  if (preset in SAMPLES || preset in PRESETS) return preset;
  return DEFAULT_PRESET;
}

function clamp(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function defaultContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  // `interactive` asks the browser for the shortest output buffer it will give,
  // which is the difference between a sound that answers the rep and one that
  // trails it.
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

function defaultFetch(src) {
  return fetch(src).then((res) => {
    if (!res.ok) throw new Error(`${src} came back ${res.status}`);
    return res.arrayBuffer();
  });
}
