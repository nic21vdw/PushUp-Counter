/**
 * The noise a counted rep makes.
 *
 * Mid-set your head is down and the number is off to the side, so the only
 * honest confirmation the tracker can give you is one you can hear.
 *
 * Three kinds of sound live here. A **sample** is an audio file from
 * `public/sounds/`, trimmed to the part worth hearing. A **preset** is
 * synthesised from oscillators, needs no file, and is what plays if a sample
 * cannot be loaded. A **line** is spoken aloud by the browser, and is the one
 * still worth hearing on the fortieth rep — a chime can only ever tell you the
 * rep counted. `shuffle` draws a different one each rep, because the same noise
 * a hundred times in a set stops being funny somewhere around six.
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

  /** A scouter sweeping for a power level. */
  scouter: [
    { at: 0, dur: 0.035, hz: 1760, type: 'square', gain: 0.45 },
    { at: 0.055, dur: 0.035, hz: 2093, type: 'square', gain: 0.45 },
    { at: 0.11, dur: 0.035, hz: 2489, type: 'square', gain: 0.45 },
    { at: 0.165, dur: 0.035, hz: 2794, type: 'square', gain: 0.45 },
    { at: 0.22, dur: 0.1, hz: 3322, type: 'square', gain: 0.5 },
  ],
  /** The same scouter reading one number too many. Three beeps, then the crunch. */
  scouterbreak: [
    { at: 0, dur: 0.04, hz: 2349, type: 'square', gain: 0.4 },
    { at: 0.055, dur: 0.04, hz: 2794, type: 'square', gain: 0.4 },
    { at: 0.11, dur: 0.05, hz: 3520, type: 'square', gain: 0.45 },
    {
      at: 0.18,
      dur: 0.3,
      type: 'noise',
      gain: 0.5,
      filter: { type: 'lowpass', hz: 3200, to: 260 },
    },
    { at: 0.18, dur: 0.24, hz: 170, to: 48, type: 'sawtooth', gain: 0.4 },
  ],
  /** A ki blast leaving the hand. */
  kiblast: [
    {
      at: 0,
      dur: 0.2,
      hz: 1700,
      to: 210,
      type: 'sawtooth',
      gain: 0.5,
      filter: { type: 'lowpass', hz: 4200, to: 640 },
    },
    {
      at: 0,
      dur: 0.13,
      type: 'noise',
      gain: 0.22,
      filter: { type: 'bandpass', hz: 2400, to: 560 },
    },
  ],
  /**
   * Wind-up and release. The charge climbs for a quarter of a second, and the
   * beam that answers it falls — the drop is the half people actually hum.
   */
  kamehameha: [
    {
      at: 0,
      dur: 0.26,
      hz: 190,
      to: 940,
      type: 'sawtooth',
      gain: 0.28,
      wobble: { hz: 9, depth: 26 },
      filter: { type: 'lowpass', hz: 600, to: 3200 },
    },
    {
      at: 0.24,
      dur: 0.26,
      type: 'noise',
      gain: 0.45,
      filter: { type: 'bandpass', hz: 1100, to: 220 },
    },
    {
      at: 0.24,
      dur: 0.26,
      hz: 340,
      to: 80,
      type: 'sawtooth',
      gain: 0.38,
      filter: { type: 'lowpass', hz: 2600, to: 380 },
    },
  ],
  /**
   * Going Super Saiyan. Every note here decays from the moment it starts, so
   * the build is faked by stacking layers that begin late rather than by
   * swelling any one of them.
   */
  supersaiyan: [
    { at: 0, dur: 0.5, hz: 68, to: 172, type: 'sawtooth', gain: 0.38, wobble: { hz: 13, depth: 15 } },
    {
      at: 0,
      dur: 0.34,
      type: 'noise',
      gain: 0.16,
      filter: { type: 'bandpass', hz: 420, to: 1500 },
    },
    {
      at: 0.16,
      dur: 0.34,
      type: 'noise',
      gain: 0.3,
      filter: { type: 'bandpass', hz: 950, to: 2800 },
    },
    { at: 0.28, dur: 0.22, hz: 740, to: 1660, type: 'square', gain: 0.16 },
  ],
  /** Instant Transmission: gone before the noise has finished. */
  instanttransmission: [
    {
      at: 0,
      dur: 0.14,
      hz: 2700,
      to: 320,
      type: 'sine',
      gain: 0.5,
      wobble: { hz: 32, depth: 260 },
    },
    {
      at: 0,
      dur: 0.1,
      type: 'noise',
      gain: 0.18,
      filter: { type: 'highpass', hz: 2200, to: 7000 },
    },
  ],

  /**
   * The pipe hitting the floor. The partials are deliberately out of tune with
   * each other — evenly spaced ones ring like a bell, and a bell is not what
   * falls down the stairs.
   */
  metalpipe: [
    {
      at: 0,
      dur: 0.06,
      type: 'noise',
      gain: 0.3,
      filter: { type: 'highpass', hz: 3000, to: 6500 },
    },
    { at: 0, dur: 0.5, hz: 622, type: 'triangle', gain: 0.26 },
    { at: 0, dur: 0.44, hz: 1043, type: 'square', gain: 0.2 },
    { at: 0, dur: 0.36, hz: 1657, type: 'square', gain: 0.15 },
    { at: 0, dur: 0.3, hz: 2310, type: 'square', gain: 0.1 },
    { at: 0.21, dur: 0.29, hz: 1043, type: 'square', gain: 0.12 },
  ],
  /** The record coming off mid-song. Up, then down, then the room is quiet. */
  recordscratch: [
    {
      at: 0,
      dur: 0.15,
      type: 'noise',
      gain: 0.9,
      filter: { type: 'bandpass', hz: 1100, to: 3400 },
    },
    {
      at: 0.14,
      dur: 0.16,
      type: 'noise',
      gain: 0.9,
      filter: { type: 'bandpass', hz: 3400, to: 850 },
    },
    { at: 0, dur: 0.3, hz: 320, to: 110, type: 'sawtooth', gain: 0.3, wobble: { hz: 17, depth: 55 } },
  ],
  /** One falling syllable of disappointment. */
  bruh: [
    {
      at: 0,
      dur: 0.3,
      hz: 300,
      to: 118,
      type: 'sawtooth',
      gain: 0.5,
      filter: { type: 'lowpass', hz: 1500, to: 360 },
    },
    { at: 0, dur: 0.3, hz: 150, to: 59, type: 'triangle', gain: 0.3 },
  ],
  /** Blunt object, meet head. */
  bonk: [
    { at: 0, dur: 0.18, hz: 330, to: 66, type: 'sine', gain: 0.9 },
    {
      at: 0,
      dur: 0.05,
      type: 'noise',
      gain: 0.28,
      filter: { type: 'lowpass', hz: 2400, to: 520 },
    },
  ],
  /** Wrong answer. */
  buzzer: [
    { at: 0, dur: 0.42, hz: 147, type: 'sawtooth', gain: 0.38, filter: { type: 'lowpass', hz: 1300 } },
    { at: 0, dur: 0.42, hz: 98, type: 'square', gain: 0.32 },
  ],
  /** Money. */
  kaching: [
    {
      at: 0,
      dur: 0.04,
      type: 'noise',
      gain: 0.3,
      filter: { type: 'highpass', hz: 3200, to: 6000 },
    },
    { at: 0.03, dur: 0.3, hz: 1568, type: 'sine', gain: 0.45 },
    { at: 0.03, dur: 0.3, hz: 2093, type: 'sine', gain: 0.3 },
    { at: 0.1, dur: 0.3, hz: 2637, type: 'sine', gain: 0.24 },
  ],
  /** A duck. No further justification is available. */
  quack: [
    {
      at: 0,
      dur: 0.19,
      hz: 500,
      to: 250,
      type: 'sawtooth',
      gain: 0.55,
      wobble: { hz: 44, depth: 85 },
      filter: { type: 'bandpass', hz: 1200, to: 680 },
    },
  ],
  /** Two rising woops. */
  siren: [
    { at: 0, dur: 0.22, hz: 720, to: 1500, type: 'sine', gain: 0.42 },
    { at: 0.24, dur: 0.24, hz: 720, to: 1500, type: 'sine', gain: 0.42 },
  ],
  /** Four notes down. You are out of lives. */
  gameover: [
    { at: 0, dur: 0.1, hz: 784, type: 'square', gain: 0.45 },
    { at: 0.1, dur: 0.1, hz: 622, type: 'square', gain: 0.45 },
    { at: 0.2, dur: 0.1, hz: 523, type: 'square', gain: 0.45 },
    { at: 0.3, dur: 0.2, hz: 392, type: 'square', gain: 0.5 },
  ],
  /** The orchestral stab, still going strong since 1987. */
  orchhit: [
    {
      at: 0,
      dur: 0.06,
      type: 'noise',
      gain: 0.22,
      filter: { type: 'highpass', hz: 2000, to: 5000 },
    },
    { at: 0, dur: 0.3, hz: 131, type: 'sawtooth', gain: 0.3 },
    { at: 0, dur: 0.3, hz: 196, type: 'sawtooth', gain: 0.24 },
    { at: 0, dur: 0.28, hz: 262, type: 'sawtooth', gain: 0.2 },
    { at: 0, dur: 0.26, hz: 311, type: 'sawtooth', gain: 0.18 },
  ],
  /**
   * Something going past your ear.
   *
   * The filter closes rather than opens. Every note here is loudest at its
   * first millisecond and decays from there, so a filter sweeping the other way
   * is shut during the only part anyone hears — banded or rising, this lands at
   * a fifth the volume of the rest of the shuffle and reads as a missed rep.
   */
  whoosh: [
    {
      at: 0,
      dur: 0.3,
      type: 'noise',
      gain: 0.5,
      filter: { type: 'lowpass', hz: 7000, to: 500 },
    },
  ],
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

/**
 * Things said out loud instead of played.
 *
 * A chime tells you the rep counted and nothing else. A voice is the half of a
 * meme that survives being heard forty times in one set, because the joke is
 * the line rather than the waveform.
 *
 * Written here and spoken by the browser, exactly as the pacer's announcement
 * is: there is no recording to fetch, nothing sitting in the repository, and
 * nothing here that belongs to anyone else. Keep them short. A line still being
 * said when the next rep lands is cut off by that rep, which is funny twice and
 * then just sounds broken.
 */
export const SAYINGS = [
  'Sheesh!',
  'Bruh.',
  'No way.',
  'Absolute cinema.',
  'Skill issue.',
  'Emotional damage.',
  'He needs some milk.',
  'Somebody get this man a towel.',
  'Certified.',
  'Nice.',
  'Too easy.',
  'Is that it?',
  'Weak!',
  'Get up.',
  'One more.',
  "That's one.",
  'Again.',
  'Push!',
  "Let's go!",
  'Your arms are shaking.',
  'The subscribers are watching.',
  'Down. Up. Repeat.',
  "It's over nine thousand!",
  'Kamehameha!',
  'Power level rising.',
  'Not even my final form.',
];

/** Speak a different line each rep, and never play a noise. */
export const SAYINGS_MODE = 'sayings';

// Lines live in the bank under a name, so one can be drawn exactly like a file
// or a preset and the no-repeats rule covers all three kinds at once.
const SPOKEN_PREFIX = 'say:';

/** The bank name for the line at `index`. */
export const spokenName = (index) => `${SPOKEN_PREFIX}${index}`;

/** Whether a bank name is a line rather than a file or a preset. */
export const isSpoken = (name) => typeof name === 'string' && name.startsWith(SPOKEN_PREFIX);

/** The line behind a bank name, or null when that name is not a line. */
export const spokenLine = (name) =>
  isSpoken(name) ? (SAYINGS[Number(name.slice(SPOKEN_PREFIX.length))] ?? null) : null;

/** Draw a different sound each rep. */
export const SHUFFLE = 'shuffle';

/**
 * The synthesised sounds shuffle draws on, alongside whatever files exist.
 *
 * Not all of them: `coin`, `chirp` and `powerup` are acknowledgements, and the
 * point of shuffling is that a rep might be answered by something ridiculous.
 * Leaving the plain beeps out is what keeps the odds of that high. `siren` and
 * `whoosh` are out for the same reason — a noise with no joke in it is a chime
 * wearing a costume. Both are still there to be asked for by name.
 *
 * The lines are added to this on the fly rather than listed here, because
 * whether the browser can speak at all is only known at run time.
 */
export const SHUFFLE_PRESETS = [
  'fart',
  'airhorn',
  'slidewhistle',
  'rimshot',
  'boing',
  'sadtrombone',
  'scouter',
  'scouterbreak',
  'kiblast',
  'kamehameha',
  'supersaiyan',
  'instanttransmission',
  'metalpipe',
  'recordscratch',
  'bruh',
  'bonk',
  'buzzer',
  'kaching',
  'quack',
  'gameover',
  'orchhit',
];

/** Beep per rep, level up every tenth, with an announcement to start. */
export const PACER_MODE = 'pacer';

/** Played when the sound is on but nothing specific was asked for. */
export const DEFAULT_PRESET = SHUFFLE;

/** Played while a sample is still loading, and if it never loads at all. */
export const FALLBACK_PRESET = 'coin';

/** Names `?sound=` accepts without knowing which files exist. */
export const SOUND_NAMES = [SHUFFLE, SAYINGS_MODE, PACER_MODE, ...Object.keys(PRESETS)];

// Short enough that the note starts at full weight rather than fading in. Any
// softer and the sound reads as late even when it is not.
const ATTACK_S = 0.002;
const FLOOR = 0.0001;

/** The pacer reads out a whole sentence, so it is spoken at about talking speed. */
const PACER_RATE = 1.05;

/** A reaction is not a sentence. Said faster, or it is still going at the next rep. */
const SAYING_RATE = 1.15;

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
   * Everything shuffle can land on: the files, plus the funnier synthesised
   * ones. A bank of four files heard fifty times in a session is four sounds;
   * this makes it ten, and the ones that need no file are always available even
   * before the mp3s have finished loading.
   */
  get bank() {
    return [...this.loaded, ...SHUFFLE_PRESETS, ...this.spokenNames];
  }

  /**
   * The lines this browser can actually say, as bank names.
   *
   * Empty where there is no speech to be had — an OBS source with no voices
   * must never draw a line and answer the rep with silence, and whether speech
   * exists is not knowable until there is a browser to ask.
   */
  get spokenNames() {
    return this.#canSpeak() ? SAYINGS.map((_, index) => spokenName(index)) : [];
  }

  #canSpeak() {
    return Boolean(this.speech?.speak && this.Utterance);
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
    // A synth preset, the pacer, or a spoken line needs no files at all.
    if (this.preset === PACER_MODE || this.preset === SAYINGS_MODE) return;
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
    // Recorded for all three kinds, or shuffle would happily repeat the same
    // synthesised sound or line while carefully not repeating a file.
    this.lastPlayed = name;

    if (isSpoken(name)) {
      // A line that will not come out must still leave a noise behind, or the
      // rep goes unacknowledged and reads as one the camera missed.
      this.#say(spokenLine(name), SAYING_RATE, () => this.#playNotes(PRESETS[FALLBACK_PRESET]));
      return;
    }

    if (name && this.buffers.has(name)) {
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
    const drawing = this.preset === SHUFFLE || this.preset === SAYINGS_MODE;
    if (!drawing && this.buffers.has(this.preset)) return this.preset;
    // A synthesised preset was asked for by name and needs no bank.
    if (!drawing && this.preset in PRESETS) return this.preset;

    const pool = this.preset === SAYINGS_MODE ? this.#lines() : this.bank;
    if (pool.length === 0) return FALLBACK_PRESET;
    if (pool.length === 1) return pool[0];

    const others = pool.filter((name) => name !== this.lastPlayed);
    return others[Math.floor(this.random() * others.length) % others.length];
  }

  /**
   * What lines-only mode draws from, falling back to the synthesised jokes on a
   * browser with no voice: asking for sayings where none can be said should
   * cost you the words, not the acknowledgement that the rep counted.
   */
  #lines() {
    const names = this.spokenNames;
    return names.length > 0 ? names : SHUFFLE_PRESETS;
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

  /**
   * Speak, if this browser can, and never mind if it cannot.
   *
   * Cancelling first is what keeps a set from turning into a queue: a line
   * still going when the next rep lands is dropped for the new one, the same
   * way a sample is ducked rather than left to stack.
   *
   * Speech is gated behind a click exactly as the audio device is, and refuses
   * with `not-allowed` on a page nobody has touched. `onBlocked` is how the
   * caller puts a noise there instead, because a rep answered by nothing at all
   * is the one failure this file exists to prevent. Being cut off by the next
   * rep is not a failure, so an interruption does not trigger it.
   */
  #say(text, rate = PACER_RATE, onBlocked = null) {
    try {
      const speech = this.speech;
      if (!speech?.speak) {
        onBlocked?.();
        return;
      }
      speech.cancel?.();
      const utterance = new this.Utterance(text);
      utterance.rate = rate;
      if (onBlocked) {
        utterance.onerror = (event) => {
          const why = event?.error;
          if (why !== 'interrupted' && why !== 'canceled') onBlocked();
        };
      }
      speech.speak(utterance);
    } catch {
      // A browser without speech still beeps, which is the part that matters.
      onBlocked?.();
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
    // Shuffle can play the moment the device is open — the synthesised half of
    // the bank needs nothing fetched — so only a named file counts as loading.
    const waitingOnAFile =
      this.preset !== PACER_MODE &&
      this.preset !== SAYINGS_MODE &&
      this.preset !== SHUFFLE &&
      !(this.preset in PRESETS);
    if (waitingOnAFile && !this.buffers.has(this.preset)) return 'loading';
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
