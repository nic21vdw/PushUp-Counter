/**
 * The noise a counted rep makes.
 *
 * Mid-set your head is down and the number is off to the side, so the only
 * honest confirmation the tracker can give you is one you can hear.
 *
 * Two kinds of sound live here. A **sample** is an audio file from
 * `public/sounds/`, trimmed to the part worth hearing. A **preset** is
 * synthesised from oscillators, needs no file, and is what plays if a sample
 * cannot be loaded. `shuffle` draws a different sample each rep, because the
 * same noise a hundred times in a set stops being funny somewhere around six.
 *
 * Files are discovered at run time rather than listed here, so dropping an mp3
 * into `public/sounds/` is all it takes to add one. Anything without a measured
 * window is trimmed by ear, in code: leading silence cut, tail faded, capped so
 * it cannot still be playing when the next rep lands.
 *
 * Everything is prepared once, up front: fetched, decoded and trimmed at
 * start-up, and a rep only ever triggers a buffer already in memory. Nothing is
 * fetched, decoded or allocated on the rep itself, because that is the moment
 * the sound has to be instant.
 *
 * Kept free of the DOM and of a real AudioContext at construction time so the
 * rules below can be tested, and so a browser with audio blocked degrades to
 * silence instead of throwing inside the detection loop.
 */

/** Volume 0 is silence, 1 is as loud as the tab goes. */
export const DEFAULT_VOLUME = 0.45;

/**
 * Windows measured off a decoded waveform, for files worth being exact about.
 * Anything not named here is trimmed automatically when it loads.
 *
 * `fahh.mp3` is silent until 960ms, creeps up to a tenth of its volume over the
 * next 90ms and only lands at 1050ms, so its window opens at 1045 — five
 * milliseconds ahead of the attack. Starting earlier buys nothing but the lag
 * the trim exists to remove.
 */
export const SAMPLE_WINDOWS = {
  fahh: { startMs: 1045, durationMs: 1000, fadeMs: 180 },
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
  /** The two-note fall of a joke landing badly. */
  sadtrombone: [
    { at: 0, dur: 0.16, hz: 233, to: 208, type: 'sawtooth', gain: 0.5 },
    { at: 0.15, dur: 0.06, hz: 196, type: 'sawtooth', gain: 0.5 },
  ],
  /**
   * Exactly what it sounds like. Noise pushed through a closing lowpass for the
   * splutter, a wobbling saw underneath it for the pitch — the wobble is what
   * stops it reading as a broken speaker.
   */
  fart: [
    {
      at: 0,
      dur: 0.32,
      hz: 95,
      to: 62,
      type: 'sawtooth',
      gain: 0.55,
      wobble: { hz: 22, depth: 26 },
      filter: { type: 'lowpass', hz: 900, to: 260 },
    },
    {
      at: 0.02,
      dur: 0.3,
      type: 'noise',
      gain: 0.3,
      filter: { type: 'lowpass', hz: 700, to: 180 },
    },
  ],
  /** Three detuned stabs. Loud on purpose; it is an air horn. */
  airhorn: [
    { at: 0, dur: 0.26, hz: 415, type: 'sawtooth', gain: 0.28 },
    { at: 0, dur: 0.26, hz: 622, type: 'sawtooth', gain: 0.24 },
    { at: 0, dur: 0.26, hz: 311, type: 'sawtooth', gain: 0.26 },
  ],
  /** Up and away. Vibrato is what makes it a whistle instead of a beep. */
  slidewhistle: [
    { at: 0, dur: 0.28, hz: 700, to: 2200, type: 'sine', gain: 0.75, wobble: { hz: 7, depth: 40 } },
  ],
  /** Ba-dum-tss. The joke has been made; move on. */
  rimshot: [
    { at: 0, dur: 0.07, hz: 220, to: 120, type: 'sine', gain: 0.8 },
    { at: 0.1, dur: 0.07, hz: 180, to: 100, type: 'sine', gain: 0.8 },
    {
      at: 0.2,
      dur: 0.22,
      type: 'noise',
      gain: 0.35,
      filter: { type: 'highpass', hz: 4000, to: 7000 },
    },
  ],
  /** The plain rising beep. */
  chirp: [{ at: 0, dur: 0.11, hz: 880, to: 1320, type: 'triangle', gain: 1 }],
};

/**
 * The shuttle-run beep, and the announcement that goes with it.
 *
 * A push-up every time the beep sounds, and the beep gets a friend every tenth
 * rep the way the real thing changes level. The announcement is spoken by the
 * browser rather than played from a file: it is a parody written here, so there
 * is nothing to fetch and nothing that belongs to anyone else.
 */
export const PACER = {
  beep: [{ at: 0, dur: 0.19, hz: 1000, type: 'square', gain: 0.55 }],
  levelUp: [
    { at: 0, dur: 0.12, hz: 1000, type: 'square', gain: 0.55 },
    { at: 0.16, dur: 0.12, hz: 1000, type: 'square', gain: 0.55 },
    { at: 0.32, dur: 0.2, hz: 1333, type: 'square', gain: 0.6 },
  ],
  /** Reps between level-ups. */
  levelEvery: 10,
  intro:
    'The push-up test is a multi-stage exercise that gets more difficult as it continues. ' +
    'A push-up on every beep. Ready? Begin.',
  levelLine: (level) => `Level ${level}.`,
};

/** Draw a different sound each rep. */
export const SHUFFLE = 'shuffle';

/** Beep per rep, level up every tenth, with an announcement to start. */
export const PACER_MODE = 'pacer';

/** Played when the sound is on but nothing specific was asked for. */
export const DEFAULT_PRESET = SHUFFLE;

/** Played while a sample is still loading, and if it never loads at all. */
export const FALLBACK_PRESET = 'coin';

/** Names `?sound=` accepts without knowing which files exist. */
export const SOUND_NAMES = [SHUFFLE, PACER_MODE, ...Object.keys(PRESETS)];

// Short enough that the note starts at full weight rather than fading in. Any
// softer and the sound reads as late even when it is not.
const ATTACK_S = 0.002;
const FLOOR = 0.0001;

/** Nothing may run longer than this: a rep can land 300ms after the last one. */
const MAX_SAMPLE_MS = 1000;

export const DEFAULT_AUTO_TRIM = {
  /** Window size the loudness is measured over. */
  frameMs: 10,
  /**
   * Fraction of the peak that counts as the sound having started. Set high on
   * purpose: several of these recordings open with a soft build, and a rep
   * answered by a swell reads as late even when the file began on time. The
   * sound wanted here is the hit, not the run-up to it.
   */
  onsetLevel: 0.3,
  /** And as it having finished. Lower, so a decay is not cut mid-fall. */
  endLevel: 0.05,
  /** Kept ahead of the attack so the very front of it is not clipped. */
  preRollMs: 15,
  maxMs: MAX_SAMPLE_MS,
  fadeMs: 120,
};

/**
 * Find the part of a decoded file worth playing: where it starts, where it
 * stops, and how long a fade takes the tail off.
 *
 * Meme sound effects are recorded with a second of silence at the front and a
 * reverb tail hanging off the back, and neither is something you want between
 * push-ups. This is the measurement done by hand for `fahh`, done in code.
 *
 * @param {AudioBuffer} buffer
 * @param {Partial<typeof DEFAULT_AUTO_TRIM>} [overrides]
 * @returns {{startMs: number, durationMs: number, fadeMs: number}}
 */
export function autoWindow(buffer, overrides = {}) {
  const o = { ...DEFAULT_AUTO_TRIM, ...overrides };
  const rate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const frame = Math.max(1, Math.floor((o.frameMs / 1000) * rate));

  const levels = [];
  for (let i = 0; i < data.length; i += frame) {
    let sum = 0;
    const end = Math.min(i + frame, data.length);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    levels.push(Math.sqrt(sum / (end - i)));
  }

  const peak = Math.max(...levels, 0);
  if (peak <= 0) {
    // Silence all the way through. Play it as-is rather than inventing a window
    // — a file that makes no noise is a problem to notice, not to paper over.
    return { startMs: 0, durationMs: (data.length / rate) * 1000, fadeMs: 0 };
  }

  let first = levels.findIndex((v) => v >= peak * o.onsetLevel);
  if (first < 0) first = 0;
  let last = levels.length - 1;
  while (last > first && levels[last] < peak * o.endLevel) last--;

  const startMs = Math.max(0, first * o.frameMs - o.preRollMs);
  const endMs = (last + 1) * o.frameMs;
  const durationMs = Math.min(o.maxMs, Math.max(o.frameMs, endMs - startMs));

  return { startMs, durationMs, fadeMs: Math.min(o.fadeMs, durationMs / 3) };
}

/**
 * Cut a decoded file down to a window, fading the end so it stops rather than
 * being chopped off.
 *
 * @param {AudioBuffer} source
 * @param {{startMs: number, durationMs: number, fadeMs: number}} window
 * @param {(channels: number, frames: number, rate: number) => AudioBuffer} makeBuffer
 * @returns {AudioBuffer}
 */
export function trimBuffer(source, { startMs, durationMs, fadeMs }, makeBuffer) {
  const rate = source.sampleRate;
  const start = Math.max(0, Math.floor((startMs / 1000) * rate));
  const wanted = Math.floor((durationMs / 1000) * rate);
  // A window running off the end of the file is shortened, not padded with
  // silence — trailing silence is the thing being removed.
  const frames = Math.max(1, Math.min(wanted, source.length - start));
  const fade = Math.min(frames, Math.floor((fadeMs / 1000) * rate));

  const out = makeBuffer(source.numberOfChannels, frames, rate);

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const from = source.getChannelData(channel);
    const to = out.getChannelData(channel);
    for (let i = 0; i < frames; i++) {
      const remaining = frames - i;
      // `remaining - 1` so the last sample lands on silence rather than a
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
   *          fetchAudio?: (src: string) => Promise<ArrayBuffer>,
   *          listSounds?: () => Promise<Array<{name: string, src: string}>>,
   *          random?: () => number,
   *          speech?: SpeechSynthesis, Utterance?: typeof SpeechSynthesisUtterance}} [options]
   */
  constructor({
    preset = DEFAULT_PRESET,
    volume = DEFAULT_VOLUME,
    contextFactory = defaultContext,
    fetchAudio = defaultFetch,
    listSounds = defaultCatalog,
    random = Math.random,
    speech = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
  } = {}) {
    this.preset = preset === null || preset === undefined ? null : String(preset).toLowerCase();
    this.volume = clamp(volume);
    this.contextFactory = contextFactory;
    this.fetchAudio = fetchAudio;
    this.listSounds = listSounds;
    this.random = random;

    this.ctx = null;
    this.failed = false;
    this.keepAlive = null;
    this.playing = null;
    /** name -> decoded, trimmed buffer. */
    this.buffers = new Map();
    /** Files the server says exist, once asked. */
    this.catalog = [];
    this.loading = null;
    this.lastPlayed = null;
    this.noise = null;
    /** Reps this page has sounded. Only the pacer cares. */
    this.reps = 0;
    this.speech = speech;
    this.Utterance = Utterance;
  }

  /** Whether this page should be making any noise at all. */
  get enabled() {
    return this.preset !== null;
  }

  /** Every sample that finished loading, in catalogue order. */
  get loaded() {
    return this.catalog.map((s) => s.name).filter((name) => this.buffers.has(name));
  }

  /**
   * Open the audio device and start loading whatever the choice needs. Safe to
   * call repeatedly, and safe to call from a click handler — which is where it
   * wants to be called from, because a page that has never been touched is not
   * allowed to make noise.
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
   * sound and reads as lag between the rep and the noise.
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
      // A context that will not hold a silent source still plays sounds; it
      // just wakes up slower. Not worth failing over.
    }
  }

  /**
   * Ask what files exist, then fetch and trim the ones this choice can play.
   * Reps landing before it finishes fall back to a synthesised sound rather
   * than going unacknowledged — a missing noise reads as a missed rep, which is
   * the one thing this must not do.
   */
  #load() {
    if (this.loading || !this.enabled) return;
    const ctx = this.ctx;
    if (!ctx.decodeAudioData || !ctx.createBuffer) return;
    // A synth preset, or the pacer, needs no files at all.
    if (this.preset === PACER_MODE) return;
    if (this.preset !== SHUFFLE && this.preset in PRESETS) return;

    this.loading = (async () => {
      try {
        this.catalog = (await this.listSounds()) ?? [];
      } catch {
        this.catalog = [];
      }

      // A name that matches no file is a typo — in a URL, or in the folder
      // since it was typed. The whole bank is loaded in that case, so the
      // mistake costs you the sound you asked for and not the feedback.
      const named = this.catalog.filter((sound) => sound.name === this.preset);
      const wanted = (this.preset === SHUFFLE || named.length === 0 ? this.catalog : named)
        // Already decoded is already done. Switching sounds in the options
        // panel must not send the whole bank over the wire again.
        .filter((sound) => !this.buffers.has(sound.name));

      // In parallel: one slow file must not hold up the rest of the bank.
      await Promise.all(
        wanted.map(async (sound) => {
          try {
            const bytes = await this.fetchAudio(sound.src);
            const decoded = await ctx.decodeAudioData(bytes);
            const window = SAMPLE_WINDOWS[sound.name] ?? autoWindow(decoded);
            this.buffers.set(
              sound.name,
              trimBuffer(decoded, window, (channels, frames, rate) =>
                ctx.createBuffer(channels, frames, rate),
              ),
            );
          } catch {
            // Left out of the bank on purpose: `play` already knows what to do
            // without it, and one bad file must not silence the rest.
          }
        }),
      );
    })();
  }

  /**
   * Play once. Called from the rep detector, so it never throws and never
   * blocks: a broken speaker must not stop a push-up being counted.
   */
  play() {
    if (!this.arm()) return;

    if (this.preset === PACER_MODE) {
      this.#playPacer();
      return;
    }

    const name = this.#choose();
    if (name && this.buffers.has(name)) {
      this.lastPlayed = name;
      this.#playSample(this.buffers.get(name));
      return;
    }
    this.#playNotes(PRESETS[name in PRESETS ? name : FALLBACK_PRESET]);
  }

  /**
   * Which sound this rep gets. Shuffle never repeats itself twice running —
   * randomness that lands on the same noise three times reads as broken rather
   * than random.
   */
  #choose() {
    if (this.preset !== SHUFFLE && this.buffers.has(this.preset)) return this.preset;
    // A synthesised preset was asked for by name and needs no bank.
    if (this.preset !== SHUFFLE && this.preset in PRESETS) return this.preset;

    const bank = this.loaded;
    if (bank.length === 0) return FALLBACK_PRESET;
    if (bank.length === 1) return bank[0];

    const others = bank.filter((name) => name !== this.lastPlayed);
    return others[Math.floor(this.random() * others.length) % others.length];
  }

  #playSample(buffer) {
    const ctx = this.ctx;
    const at = ctx.currentTime;

    // A rep every 300ms against a one-second sound would stack four on top of
    // each other and turn a set into mush. The last one is ducked out over a
    // few milliseconds instead — fast enough to read as a retrigger, slow
    // enough not to click.
    this.#duck(at);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(FLOOR, this.volume), at);
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
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
      // and the source is stopped rather than faded to nothing.
      const peak = Math.max(FLOOR, this.volume * note.gain);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(FLOOR, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(FLOOR, end);

      // A filter is what turns a buzz into a splutter and a hiss into a snare,
      // so it sits between the source and the volume rather than being optional
      // decoration on the end.
      let tail = gain;
      if (note.filter && ctx.createBiquadFilter) {
        const filter = ctx.createBiquadFilter();
        filter.type = note.filter.type;
        filter.frequency.setValueAtTime(note.filter.hz, at);
        if (note.filter.to) filter.frequency.exponentialRampToValueAtTime(note.filter.to, end);
        filter.connect(gain);
        tail = filter;
      }
      gain.connect(ctx.destination);

      const source = note.type === 'noise' ? this.#noiseSource() : ctx.createOscillator();
      if (!source) continue;

      if (note.type !== 'noise') {
        source.type = note.type;
        source.frequency.setValueAtTime(note.hz, at);
        if (note.to) source.frequency.exponentialRampToValueAtTime(note.to, end);

        // Vibrato, and the thing that keeps a fart from sounding like a fault.
        if (note.wobble && ctx.createOscillator) {
          const lfo = ctx.createOscillator();
          const depth = ctx.createGain();
          lfo.frequency.setValueAtTime(note.wobble.hz, at);
          depth.gain.setValueAtTime(note.wobble.depth, at);
          lfo.connect(depth);
          depth.connect(source.frequency);
          lfo.start(at);
          lfo.stop(end);
        }
      }

      source.connect(tail);
      source.start(at);
      source.stop?.(end);
    }
  }

  /**
   * White noise, made once and replayed. Building a second of random numbers on
   * every rep is exactly the kind of work this class exists to keep off the
   * moment the sound has to be instant.
   */
  #noiseSource() {
    const ctx = this.ctx;
    if (!ctx.createBufferSource || !ctx.createBuffer) return null;
    if (!this.noise) {
      const frames = Math.floor((ctx.sampleRate ?? 44100) * 0.5);
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate ?? 44100);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = this.random() * 2 - 1;
      this.noise = buffer;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    return source;
  }

  /**
   * The shuttle run, counted in push-ups. A beep a rep, three beeps and a
   * spoken level every tenth, and the announcement on the first one — which is
   * the only time a sentence is worth waiting through.
   */
  #playPacer() {
    this.reps += 1;

    if (this.reps === 1) {
      this.#say(PACER.intro);
      this.#playNotes(PACER.beep);
      return;
    }

    if (this.reps % PACER.levelEvery === 0) {
      this.#playNotes(PACER.levelUp);
      this.#say(PACER.levelLine(this.reps / PACER.levelEvery + 1));
      return;
    }

    this.#playNotes(PACER.beep);
  }

  /** Speak, if this browser can, and never mind if it cannot. */
  #say(text) {
    try {
      const speech = this.speech;
      if (!speech?.speak) return;
      speech.cancel?.();
      const utterance = new this.Utterance(text);
      utterance.rate = 1.05;
      speech.speak(utterance);
    } catch {
      // A browser without speech still beeps, which is the part that matters.
    }
  }

  /**
   * Change which sound plays, without dropping the audio device — the options
   * panel changes it live, and reopening the device would cost the wake-up this
   * class exists to avoid.
   *
   * @param {string|null} preset a name, `shuffle`, or null for silence
   */
  setPreset(preset) {
    const next = preset === null || preset === undefined ? null : String(preset).toLowerCase();
    if (next === this.preset) return;

    this.preset = next;
    // Choosing the pacer starts the test again, announcement and all.
    this.reps = 0;
    // Buffers already decoded stay decoded: switching back is then instant, and
    // the bank is a few hundred kilobytes at worst.
    this.loading = null;
    if (this.ctx && this.enabled) this.#load();
  }

  /** Live volume change, for the options panel's slider. */
  setVolume(volume) {
    this.volume = clamp(volume);
  }

  /**
   * How far behind the rep the sound lands, in ms — the audio stack's own delay
   * between a scheduled sample and the speaker. Under about 30 reads as
   * instant; a figure in the hundreds is the device, not this code.
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
    const needsFiles =
      this.preset !== PACER_MODE && (this.preset === SHUFFLE || !(this.preset in PRESETS));
    if (needsFiles && this.buffers.size === 0) return 'loading';
    return this.ctx.state ?? 'idle';
  }

  /** True when the browser is holding the sound back until the page is clicked. */
  get needsGesture() {
    return this.enabled && this.ctx?.state === 'suspended';
  }

  /** Release the audio device on the way out of the page. */
  stop() {
    this.ctx?.close?.();
    this.ctx = null;
    this.keepAlive = null;
    this.playing = null;
    this.buffers.clear();
    this.loading = null;
  }
}

function clamp(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function defaultContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  // `interactive` asks for the shortest output buffer the browser will give,
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

function defaultCatalog() {
  return fetch('/api/sounds')
    .then((res) => (res.ok ? res.json() : { sounds: [] }))
    .then((body) => body.sounds ?? []);
}
