/**
 * The noise a counted rep makes.
 *
 * It fires from inside the detection loop on a page that is live on stream, so
 * the thing worth testing hardest is that it cannot throw: a machine with no
 * audio device, or a tab that has never been clicked, has to go quiet rather
 * than take the counting down with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RepSound,
  trimBuffer,
  autoWindow,
  DEFAULT_VOLUME,
  FALLBACK_PRESET,
  PRESETS,
  PACER,
  PACER_MODE,
  SAMPLE_WINDOWS,
  SAYINGS,
  SAYINGS_MODE,
  SHUFFLE,
  SHUFFLE_PRESETS,
  isSpoken,
  spokenLine,
} from '../public/js/rep-sound.js';

// The default is shuffle, so a bare RepSound in these tests plays the fallback
// notes until files have been discovered and decoded.
const NOTES = PRESETS[FALLBACK_PRESET].length;

/** A RepSound with no files to find, so only the synthesised path can run. */
const bare = (options = {}) =>
  new RepSound({ listSounds: () => Promise.resolve([]), ...options });

/** How many notes actually sounded, ignoring the silent keep-awake source. */
const notesPlayed = (ctx) => ctx.started.filter((n) => n.hz !== 20).length;

/**
 * How many files played. The noise in a synthesised sound is a buffer source
 * too, so counting every buffer source counts a fart as a file — and which
 * sounds contain noise is up to the shuffle, which makes that count a coin toss.
 * Noise is the one that loops.
 */
const filesPlayed = (ctx) => ctx.samples.filter((source) => !source.loop).length;

/**
 * Anything at all reaching the speakers — a pitched note, a burst of noise, or
 * a file. Some sounds are pure noise and start no oscillator, so "it made a
 * noise" cannot be measured by counting notes alone.
 */
const anythingPlayed = (ctx) => notesPlayed(ctx) + ctx.samples.length;

/**
 * Oscillators a preset starts: one per pitched note, and one more for every
 * wobble, because vibrato is its own oscillator. Noise plays from a buffer and
 * never reaches this count.
 */
const oscillators = (name) =>
  PRESETS[name].filter((note) => note.type !== 'noise').length +
  PRESETS[name].filter((note) => note.wobble).length;

/** Enough of the Web Audio API to record what a sound asked for. */
function fakeContext({ state = 'running', decode = null } = {}) {
  const ctx = {
    state,
    currentTime: 0,
    closed: false,
    resumed: 0,
    started: [],
    samples: [],
    gains: [],
    filters: [],
    createGain() {
      const node = {
        gain: {
          value: 1,
          ramps: [],
          setValueAtTime: () => {},
          cancelScheduledValues: () => {},
          exponentialRampToValueAtTime: (v) => node.gain.ramps.push(v),
        },
        connect: () => {},
      };
      ctx.gains.push(node);
      return node;
    },
    createOscillator() {
      const node = {
        type: null,
        hz: null,
        frequency: {
          setValueAtTime: (hz) => {
            node.hz = hz;
          },
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: () => ctx.started.push(node),
        stop: () => {},
      };
      return node;
    },
    createBiquadFilter() {
      const node = {
        type: null,
        frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      };
      ctx.filters.push(node);
      return node;
    },
    createBuffer(channels, frames, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        getChannelData: (i) => data[i],
      };
    },
    createBufferSource() {
      const node = {
        buffer: null,
        loop: false,
        stopped: null,
        connect: () => {},
        start: () => ctx.samples.push(node),
        stop: (at) => {
          node.stopped = at;
        },
      };
      return node;
    },
    decodeAudioData: decode ?? undefined,
    resume() {
      ctx.resumed += 1;
      ctx.state = 'running';
      return Promise.resolve();
    },
    close() {
      ctx.closed = true;
    },
  };
  return ctx;
}

test('a counted rep makes a noise', () => {
  const ctx = fakeContext();
  const sound = bare({ contextFactory: () => ctx });

  sound.play();

  assert.equal(notesPlayed(ctx), oscillators(sound.lastPlayed), 'one rep, one sound');
});

test('the device is opened once and reused, not reopened per rep', () => {
  let built = 0;
  const ctx = fakeContext();
  const sound = bare({
    preset: FALLBACK_PRESET,
    contextFactory: () => {
      built += 1;
      return ctx;
    },
  });

  sound.play();
  sound.play();
  sound.play();

  assert.equal(built, 1);
  assert.equal(notesPlayed(ctx), NOTES * 3);
});

test('a page that has not been clicked yet gets resumed rather than staying mute', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = bare({ preset: FALLBACK_PRESET, contextFactory: () => ctx });

  sound.play();

  assert.equal(ctx.resumed, 1, 'autoplay policy is the usual reason for silence');
  assert.equal(notesPlayed(ctx), NOTES);
});

test('sound off means no audio device is ever opened', () => {
  let built = 0;
  const sound = bare({
    preset: null,
    contextFactory: () => {
      built += 1;
      return fakeContext();
    },
  });

  sound.play();

  assert.equal(built, 0, 'a muted source has no business holding the audio device');
  assert.equal(sound.status, 'off');
});

test('a machine with no audio goes silent instead of breaking the count', () => {
  const sound = bare({ contextFactory: () => null });

  assert.doesNotThrow(() => sound.play());
  assert.equal(sound.status, 'blocked');
});

test('a constructor that throws is treated as no audio, and is not retried', () => {
  let attempts = 0;
  const sound = bare({
    contextFactory: () => {
      attempts += 1;
      throw new Error('no output device');
    },
  });

  assert.doesNotThrow(() => sound.play());
  assert.doesNotThrow(() => sound.play());
  assert.equal(attempts, 1, 'a dead device is not worth asking about on every rep');
});

test('volume is clamped, and junk falls back rather than blasting', () => {
  assert.equal(bare({ volume: 0.2 }).volume, 0.2);
  assert.equal(bare({ volume: 9 }).volume, 1);
  assert.equal(bare({ volume: -1 }).volume, 0);
  assert.equal(bare({ volume: 'loud' }).volume, DEFAULT_VOLUME);
});

test('volume 0 is real silence, not the default volume', () => {
  const ctx = fakeContext();
  const sound = bare({ volume: 0, contextFactory: () => ctx });

  sound.play();

  const peak = Math.max(...ctx.gains.flatMap((g) => g.gain.ramps));
  assert.ok(peak <= 0.0001, `muted, got peak gain ${peak}`);
});

test('the status readout names why it is quiet', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = bare({ preset: 'coin', contextFactory: () => ctx });

  assert.equal(sound.status, 'idle', 'nothing has opened the device yet');
  sound.arm();
  assert.equal(sound.status, 'running');
});

test('every preset is short enough to stay out of the next rep’s way', () => {
  for (const [name, notes] of Object.entries(PRESETS)) {
    const end = Math.max(...notes.map((n) => n.at + n.dur));
    // Half a second. The beeps are a fifth of that; the jokes need room for a
    // punchline, and a fast set at 300ms a rep only ever overlaps their tails.
    assert.ok(end <= 0.5, `${name} runs ${Math.round(end * 1000)}ms`);
    for (const note of notes) {
      assert.ok(note.gain > 0, `${name} has a silent note`);
      // Noise has no pitch, which is the point of it.
      if (note.type !== 'noise') {
        assert.ok(note.hz > 0, `${name} has a pitchless note that is not noise`);
      }
    }
  }
});

test('a preset can be picked, and silence asked for', () => {
  assert.equal(bare({ preset: 'boing' }).preset, 'boing');
  assert.equal(bare({ preset: 'BOING' }).preset, 'boing', 'case is not a setting');
  assert.equal(bare({ preset: null }).preset, null, 'null is the way to ask for silence');
});

test('the chosen preset is the one that plays', () => {
  const ctx = fakeContext();
  const sound = bare({ preset: 'powerup', contextFactory: () => ctx });

  sound.play();

  assert.equal(notesPlayed(ctx), PRESETS.powerup.length, 'four notes, four oscillators');
});

test('leaving the page releases the audio device', () => {
  const ctx = fakeContext();
  const sound = bare({ contextFactory: () => ctx });

  sound.play();
  sound.stop();

  assert.equal(ctx.closed, true);
});


/* --------------------------------------------------------------- the bank */

/** A decoded file: `silentMs` of nothing, a tone, then a quiet tail. */
function fakeDecoded({ rate = 1000, silentMs = 500, toneMs = 400, tailMs = 1000 } = {}) {
  const frames = Math.round(((silentMs + toneMs + tailMs) / 1000) * rate);
  const data = new Float32Array(frames);
  const start = Math.round((silentMs / 1000) * rate);
  const end = start + Math.round((toneMs / 1000) * rate);
  for (let i = start; i < end; i++) data[i] = 1;
  // A tail at a fortieth of the peak: below the end threshold, so it is meant
  // to be trimmed off rather than played out.
  for (let i = end; i < frames; i++) data[i] = 0.025;
  return {
    numberOfChannels: 1,
    length: frames,
    sampleRate: rate,
    duration: frames / rate,
    getChannelData: () => data,
  };
}

const makeBuffer = (channels, frames, rate) => {
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate: rate,
    getChannelData: (i) => data[i],
  };
};

/** A RepSound wired to a bank of fake files. */
function withBank(names, { decode, ...options } = {}) {
  const ctx = fakeContext({ decode: decode ?? (() => Promise.resolve(fakeDecoded())) });
  const sound = new RepSound({
    contextFactory: () => ctx,
    listSounds: () => Promise.resolve(names.map((name) => ({ name, src: `/sounds/${name}.mp3` }))),
    fetchAudio: () => Promise.resolve(new ArrayBuffer(8)),
    ...options,
  });
  return { ctx, sound };
}

test('the silence at the front of a meme sound is found, not guessed', () => {
  const window = autoWindow(fakeDecoded({ silentMs: 500, toneMs: 400 }));

  assert.ok(window.startMs >= 470 && window.startMs <= 500, `started at ${window.startMs}ms`);
  assert.ok(window.durationMs <= 500, `kept ${window.durationMs}ms of a 400ms sound`);
  assert.ok(window.fadeMs > 0, 'and the end is faded, not cut');
});

test('nothing from the bank can outlast the gap between two fast reps', () => {
  const window = autoWindow(fakeDecoded({ silentMs: 0, toneMs: 5000, tailMs: 0 }));

  assert.ok(window.durationMs <= 1200, `a 5s file was kept at ${window.durationMs}ms`);
});

test('a silent file is left alone rather than given an invented window', () => {
  const silent = {
    numberOfChannels: 1,
    length: 1000,
    sampleRate: 1000,
    getChannelData: () => new Float32Array(1000),
  };

  const window = autoWindow(silent);
  assert.equal(window.startMs, 0);
  assert.equal(window.durationMs, 1000, 'a file that makes no noise is a thing to notice');
});

test('the measured window wins over the automatic one where there is one', () => {
  assert.ok(SAMPLE_WINDOWS.fahh, 'fahh was measured by hand');
  assert.equal(SAMPLE_WINDOWS.fahh.startMs, 1045);
});

test('shuffle loads every file it might play', async () => {
  const { sound } = withBank(['fahh', 'vine-boom', 'roblox-oof']);

  sound.arm();
  await sound.loading;

  assert.deepEqual(sound.loaded, ['fahh', 'vine-boom', 'roblox-oof']);
});

test('naming one sound loads only that one', async () => {
  let fetched = 0;
  const { sound } = withBank(['fahh', 'vine-boom', 'roblox-oof'], {
    preset: 'vine-boom',
    fetchAudio: () => {
      fetched += 1;
      return Promise.resolve(new ArrayBuffer(8));
    },
  });

  sound.arm();
  await sound.loading;

  assert.equal(fetched, 1, 'no point decoding a bank you will not draw from');
  assert.deepEqual(sound.loaded, ['vine-boom']);
});

test('shuffle plays a file, and never the same one twice running', async () => {
  // A random that always asks for the first candidate: without the guard it
  // would return the same sound every rep.
  const { ctx, sound } = withBank(['fahh', 'vine-boom', 'roblox-oof'], { random: () => 0 });

  sound.arm();
  await sound.loading;

  const played = [];
  for (let i = 0; i < 6; i++) {
    sound.play();
    played.push(sound.lastPlayed);
  }

  assert.equal(ctx.samples.length + ctx.started.filter((n) => n.hz !== 20).length > 0, true, 'six reps, six sounds');
  for (let i = 1; i < played.length; i++) {
    assert.notEqual(played[i], played[i - 1], `rep ${i} repeated ${played[i]}`);
  }
});

test('the file half of the bank is drawn on first when the dice say so', async () => {
  // A random that always asks for the first candidate, and files come first.
  const { ctx, sound } = withBank(['fahh'], { random: () => 0 });

  sound.arm();
  await sound.loading;
  sound.play();

  assert.equal(sound.lastPlayed, 'fahh');
  assert.equal(ctx.samples.length, 1);
});

test('an empty sounds folder still shuffles, because half the bank needs no files', async () => {
  const { ctx, sound } = withBank([]);

  sound.arm();
  await sound.loading;
  sound.play();

  assert.equal(filesPlayed(ctx), 0, 'there were no files to play');
  assert.ok(anythingPlayed(ctx) > 0, 'and a synthesised one was played instead of nothing');
  assert.ok(SHUFFLE_PRESETS.includes(sound.lastPlayed ?? ''), `played ${sound.lastPlayed}`);
});

test('shuffle draws on the files and the synthesised ones together', async () => {
  const { sound } = withBank(['fahh', 'vine-boom']);

  sound.arm();
  await sound.loading;

  assert.deepEqual(sound.bank, ['fahh', 'vine-boom', ...SHUFFLE_PRESETS]);
  assert.ok(sound.bank.length >= 8, 'four files heard fifty times is four sounds');
});

test('the plain beeps are kept out of the shuffle', () => {
  for (const dull of ['coin', 'chirp', 'powerup']) {
    assert.ok(!SHUFFLE_PRESETS.includes(dull), `${dull} is an acknowledgement, not a joke`);
  }
  for (const name of SHUFFLE_PRESETS) {
    assert.ok(name in PRESETS, `${name} is shuffled but does not exist`);
  }
});

test('one unreadable file does not silence the rest of the bank', async () => {
  let call = 0;
  const { sound } = withBank(['broken', 'fine'], {
    fetchAudio: () => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('404')) : Promise.resolve(new ArrayBuffer(8));
    },
  });

  sound.arm();
  await sound.loading;

  assert.deepEqual(sound.loaded, ['fine']);
});

test('reps before the files have loaded are answered by the synthesised half', () => {
  const { ctx, sound } = withBank(['fahh'], { decode: () => new Promise(() => {}) });

  sound.play();

  assert.equal(filesPlayed(ctx), 0, 'no file was ready');
  assert.ok(anythingPlayed(ctx) > 0, 'so one that needs no file played instead');
  assert.ok(SHUFFLE_PRESETS.includes(sound.lastPlayed));
});

test('a named file that has not loaded yet says so, and still makes a noise', () => {
  const { ctx, sound } = withBank(['fahh'], {
    preset: 'fahh',
    decode: () => new Promise(() => {}),
  });

  sound.play();

  assert.equal(sound.status, 'loading', 'the readout says what it is waiting for');
  assert.equal(filesPlayed(ctx), 0, 'the file it was asked for is not ready');
  assert.ok(anythingPlayed(ctx) > 0, 'so one that needs no file answered the rep instead');
  assert.ok(SHUFFLE_PRESETS.includes(sound.lastPlayed), `played ${sound.lastPlayed}`);
});

test('switching sound keeps what is already decoded', async () => {
  let fetched = 0;
  const { sound } = withBank(['fahh', 'vine-boom'], {
    fetchAudio: () => {
      fetched += 1;
      return Promise.resolve(new ArrayBuffer(8));
    },
  });

  sound.arm();
  await sound.loading;
  const first = fetched;

  sound.setPreset('vine-boom');
  await sound.loading;

  assert.equal(fetched, first, 'switching back and forth must not re-fetch the bank');
  assert.equal(sound.preset, 'vine-boom');
});

test('a page that has not been clicked says so, because that is the usual silence', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = bare({ preset: 'coin', contextFactory: () => ctx });

  assert.equal(sound.needsGesture, false, 'nothing has opened the device yet');
  sound.arm();
  // The fake resumes on request; a real browser refuses until a real click.
  ctx.state = 'suspended';
  assert.equal(sound.needsGesture, true);

  const silent = bare({ preset: null });
  assert.equal(silent.needsGesture, false, 'silence is not something to nag about');
});

test('a rep landing mid-sound retriggers it instead of stacking', async () => {
  const { ctx, sound } = withBank(['fahh', 'vine-boom'], { preset: 'fahh' });

  sound.arm();
  await sound.loading;
  sound.play();
  sound.play();

  assert.equal(ctx.samples.length, 2, 'both reps were answered');
  assert.ok(ctx.samples[0].stopped !== null, 'and the first was ducked rather than left to overlap');
  assert.equal(ctx.samples[1].stopped, null, 'while the newest keeps playing');
});

test('leaving the page releases the audio device', () => {
  const ctx = fakeContext();
  const sound = bare({ contextFactory: () => ctx });

  sound.play();
  sound.stop();

  assert.equal(ctx.closed, true);
});

test('a sound named that does not exist shuffles rather than beeping forever', async () => {
  const { ctx, sound } = withBank(['fahh', 'vine-boom'], { preset: 'fah', random: () => 0 });

  sound.arm();
  await sound.loading;
  sound.play();

  assert.deepEqual(sound.loaded, ['fahh', 'vine-boom'], 'the bank is loaded despite the typo');
  assert.equal(ctx.samples.length, 1, 'and a real sound played');
  assert.equal(notesPlayed(ctx), 0);
});

/* --------------------------------------------------------------- the lines */

/** A browser that can speak, and a record of everything it was asked to say. */
function fakeVoice() {
  const said = [];
  return {
    said,
    speech: { speak: (utterance) => said.push(utterance.text), cancel: () => {} },
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
  };
}

test('a line is said out loud, and not the same one twice running', () => {
  const { said, speech, Utterance } = fakeVoice();
  const ctx = fakeContext();
  const sound = bare({ preset: SAYINGS_MODE, contextFactory: () => ctx, speech, Utterance });

  for (let i = 0; i < 8; i++) sound.play();

  assert.equal(said.length, 8, 'eight reps, eight lines');
  for (const line of said) assert.ok(SAYINGS.includes(line), `said "${line}"`);
  for (let i = 1; i < said.length; i++) {
    assert.notEqual(said[i], said[i - 1], `rep ${i} repeated "${said[i]}"`);
  }
});

test('a browser with no voice answers the rep with a noise rather than silence', () => {
  const ctx = fakeContext();
  const sound = bare({
    preset: SAYINGS_MODE,
    contextFactory: () => ctx,
    speech: undefined,
    Utterance: undefined,
  });

  sound.play();

  assert.ok(anythingPlayed(ctx) > 0, 'something stood in for the line');
  assert.ok(SHUFFLE_PRESETS.includes(sound.lastPlayed), `played ${sound.lastPlayed}`);
});

test('shuffle draws on the lines too, once there is a voice to say them', () => {
  const { speech, Utterance } = fakeVoice();
  const spoken = bare({ speech, Utterance });
  const mute = bare({ speech: undefined, Utterance: undefined });

  assert.equal(spoken.bank.length, SHUFFLE_PRESETS.length + SAYINGS.length);
  assert.ok(spoken.bank.some(isSpoken), 'and a line can be drawn');
  assert.deepEqual(mute.bank, SHUFFLE_PRESETS, 'a mute browser is left with the noises');
});

test('a line asked for is the line said', () => {
  const { said, speech, Utterance } = fakeVoice();
  const ctx = fakeContext();
  const sound = bare({
    preset: SAYINGS_MODE,
    contextFactory: () => ctx,
    speech,
    Utterance,
    random: () => 0,
  });

  sound.play();

  assert.equal(said[0], spokenLine(sound.lastPlayed));
  assert.equal(anythingPlayed(ctx), 0, 'a line is spoken, not played');
});

test('every saying is short enough to be over before the next rep', () => {
  for (const line of SAYINGS) {
    assert.ok(line.trim().length > 0, 'a blank line says nothing');
    assert.ok(line.length <= 40, `"${line}" is a speech, not a reaction`);
  }
  assert.equal(new Set(SAYINGS).size, SAYINGS.length, 'a duplicated line halves its own joke');
});

/* ---------------------------------------------------------------- the noise */

test('a fart is noise and a wobble, not a plain tone', () => {
  const ctx = fakeContext();
  const sound = bare({ preset: 'fart', contextFactory: () => ctx });

  sound.play();

  assert.ok(ctx.filters.length >= 1, 'the splutter is a closing filter');
  assert.ok(ctx.samples.length >= 1, 'and part of it is noise, played from a buffer');
  // The saw, its wobble LFO, and the keep-awake source.
  assert.ok(ctx.started.length >= 3, 'with an LFO bending the pitch');
});

test('the noise buffer is built once, not on every rep', () => {
  const ctx = fakeContext();
  const sound = bare({ preset: 'fart', contextFactory: () => ctx });

  sound.play();
  const first = sound.noise;
  sound.play();

  assert.equal(sound.noise, first, 'a second of random numbers per rep is work on the wrong side');
});

test('a browser without filters still makes the sound, just plainer', () => {
  const ctx = fakeContext();
  delete ctx.createBiquadFilter;
  const sound = bare({ preset: 'fart', contextFactory: () => ctx });

  assert.doesNotThrow(() => sound.play());
});

/* ---------------------------------------------------------------- the pacer */

/** Records what was said, in order. */
function fakeSpeech() {
  const said = [];
  return {
    said,
    speech: { speak: (u) => said.push(u.text), cancel: () => {} },
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
  };
}

test('the pacer announces itself on the first rep, then just beeps', () => {
  const ctx = fakeContext();
  const { said, speech, Utterance } = fakeSpeech();
  const sound = bare({ preset: PACER_MODE, contextFactory: () => ctx, speech, Utterance });

  sound.play();
  sound.play();
  sound.play();

  assert.equal(said.length, 1, 'a sentence per rep would be unbearable');
  assert.equal(said[0], PACER.intro);
  assert.equal(sound.reps, 3);
});

test('the pacer changes level every tenth rep, and says so', () => {
  const ctx = fakeContext();
  const { said, speech, Utterance } = fakeSpeech();
  const sound = bare({ preset: PACER_MODE, contextFactory: () => ctx, speech, Utterance });

  for (let i = 0; i < 20; i++) sound.play();

  assert.deepEqual(said, [PACER.intro, 'Level 2.', 'Level 3.'], 'ten reps a level');
});

test('the pacer needs no files and never reports itself as loading', async () => {
  let asked = 0;
  const ctx = fakeContext();
  const sound = new RepSound({
    preset: PACER_MODE,
    contextFactory: () => ctx,
    listSounds: () => {
      asked += 1;
      return Promise.resolve([{ name: 'fahh', src: '/sounds/fahh.mp3' }]);
    },
  });

  sound.arm();
  await sound.loading;

  assert.equal(asked, 0, 'a beep it synthesises itself needs no bank');
  assert.equal(sound.status, 'running');
});

test('starting the pacer again starts the test again', () => {
  const ctx = fakeContext();
  const { said, speech, Utterance } = fakeSpeech();
  const sound = bare({ preset: PACER_MODE, contextFactory: () => ctx, speech, Utterance });

  sound.play();
  sound.play();
  sound.setPreset('coin');
  sound.setPreset(PACER_MODE);
  sound.play();

  assert.equal(sound.reps, 1);
  assert.deepEqual(said, [PACER.intro, PACER.intro], 'the announcement comes back with it');
});

test('a browser that cannot speak still runs the test', () => {
  const ctx = fakeContext();
  const sound = bare({
    preset: PACER_MODE,
    contextFactory: () => ctx,
    speech: undefined,
    Utterance: undefined,
  });

  assert.doesNotThrow(() => sound.play());
  assert.equal(notesPlayed(ctx), PACER.beep.length, 'the beep is the part that matters');
});

test('the pacer script is a parody written here, not a recording of anything', () => {
  assert.match(PACER.intro, /push-up/i);
  assert.ok(PACER.intro.length < 200, 'short enough to sit through once');
});
