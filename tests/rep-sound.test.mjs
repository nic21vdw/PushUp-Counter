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
  DEFAULT_VOLUME,
  DEFAULT_PRESET,
  FALLBACK_PRESET,
  PRESETS,
  SAMPLES,
} from '../public/js/rep-sound.js';

// The default is a file, so a bare RepSound in these tests plays the fallback
// notes until something hands it a decoded buffer.
const NOTES = PRESETS[FALLBACK_PRESET].length;

/** How many notes actually sounded, ignoring the silent keep-awake source. */
const notesPlayed = (ctx) => ctx.started.filter((n) => n.hz !== 20).length;

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
  const sound = new RepSound({ contextFactory: () => ctx });

  sound.play();

  assert.equal(notesPlayed(ctx), NOTES, 'one rep, one sound');
});

test('the device is opened once and reused, not reopened per rep', () => {
  let built = 0;
  const ctx = fakeContext();
  const sound = new RepSound({
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
  const sound = new RepSound({ contextFactory: () => ctx });

  sound.play();

  assert.equal(ctx.resumed, 1, 'autoplay policy is the usual reason for silence');
  assert.equal(notesPlayed(ctx), NOTES);
});

test('sound off means no audio device is ever opened', () => {
  let built = 0;
  const sound = new RepSound({
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
  const sound = new RepSound({ contextFactory: () => null });

  assert.doesNotThrow(() => sound.play());
  assert.equal(sound.status, 'blocked');
});

test('a constructor that throws is treated as no audio, and is not retried', () => {
  let attempts = 0;
  const sound = new RepSound({
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
  assert.equal(new RepSound({ volume: 0.2 }).volume, 0.2);
  assert.equal(new RepSound({ volume: 9 }).volume, 1);
  assert.equal(new RepSound({ volume: -1 }).volume, 0);
  assert.equal(new RepSound({ volume: 'loud' }).volume, DEFAULT_VOLUME);
});

test('volume 0 is real silence, not the default volume', () => {
  const ctx = fakeContext();
  const sound = new RepSound({ volume: 0, contextFactory: () => ctx });

  sound.play();

  const peak = Math.max(...ctx.gains.flatMap((g) => g.gain.ramps));
  assert.ok(peak <= 0.0001, `muted, got peak gain ${peak}`);
});

test('the status readout names why it is quiet', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = new RepSound({ preset: 'coin', contextFactory: () => ctx });

  assert.equal(sound.status, 'idle', 'nothing has opened the device yet');
  sound.arm();
  assert.equal(sound.status, 'running');
});

test('every preset is short enough to be over before the next rep', () => {
  for (const [name, notes] of Object.entries(PRESETS)) {
    const end = Math.max(...notes.map((n) => n.at + n.dur));
    assert.ok(end <= 0.22, `${name} runs ${Math.round(end * 1000)}ms — a fast set is 300ms a rep`);
    for (const note of notes) {
      assert.ok(note.hz > 0 && note.gain > 0, `${name} has a silent or pitchless note`);
    }
  }
});

test('a preset can be picked, and a made-up one still makes a noise', () => {
  assert.equal(new RepSound({ preset: 'boing' }).preset, 'boing');
  assert.equal(
    new RepSound({ preset: 'airhorn' }).preset,
    DEFAULT_PRESET,
    'an unknown name is a typo, and a typo should not cost you the feedback',
  );
  assert.equal(new RepSound({ preset: null }).preset, null, 'null is the way to ask for silence');
});

test('the chosen preset is the one that plays', () => {
  const ctx = fakeContext();
  const sound = new RepSound({ preset: 'powerup', contextFactory: () => ctx });

  sound.play();

  assert.equal(notesPlayed(ctx), PRESETS.powerup.length, 'four notes, four oscillators');
});

test('leaving the page releases the audio device', () => {
  const ctx = fakeContext();
  const sound = new RepSound({ contextFactory: () => ctx });

  sound.play();
  sound.stop();

  assert.equal(ctx.closed, true);
});

/* ------------------------------------------------------------- the sample */

/** A decoded file: `silentMs` of nothing, then a steady tone. */
function fakeDecoded({ rate = 1000, silentMs = 945, toneMs = 2000 } = {}) {
  const frames = Math.round(((silentMs + toneMs) / 1000) * rate);
  const data = new Float32Array(frames);
  for (let i = Math.round((silentMs / 1000) * rate); i < frames; i++) data[i] = 1;
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

test('the trim drops the silence at the front and keeps the window asked for', () => {
  const out = trimBuffer(fakeDecoded(), { startMs: 945, durationMs: 1000, fadeMs: 180 }, makeBuffer);

  assert.equal(out.length, 1000, 'one second at 1000 samples a second');
  assert.equal(out.getChannelData(0)[0], 1, 'it starts on the sound, not the silence before it');
});

test('the trim fades the end rather than chopping it', () => {
  const out = trimBuffer(fakeDecoded(), { startMs: 945, durationMs: 1000, fadeMs: 180 }, makeBuffer);
  const d = out.getChannelData(0);

  assert.equal(d[d.length - 1], 0, 'it ends at silence');
  assert.ok(d[d.length - 90] < 0.6 && d[d.length - 90] > 0.4, 'halfway through the fade, halfway down');
  assert.equal(d[d.length - 200], 1, 'and full weight before the fade begins');
});

test('a window running past the end of the file is shortened, not padded', () => {
  const out = trimBuffer(
    fakeDecoded({ toneMs: 200 }),
    { startMs: 945, durationMs: 1000, fadeMs: 50 },
    makeBuffer,
  );

  assert.equal(out.length, 200, 'trailing silence is the thing being removed');
});

test('reps before the file has loaded still make a noise', () => {
  const ctx = fakeContext({ decode: () => new Promise(() => {}) });
  const sound = new RepSound({
    preset: 'fahh',
    contextFactory: () => ctx,
    fetchAudio: () => Promise.resolve(new ArrayBuffer(8)),
  });

  sound.play();

  assert.equal(sound.status, 'loading', 'and the readout says why');
  assert.equal(notesPlayed(ctx), PRESETS[FALLBACK_PRESET].length, 'a silent rep reads as a missed rep');
  assert.equal(ctx.samples.length, 0);
});

test('once loaded, the file is what plays - and it is only decoded once', async () => {
  let decodes = 0;
  let fetches = 0;
  const ctx = fakeContext({
    decode: () => {
      decodes += 1;
      return Promise.resolve(fakeDecoded());
    },
  });
  const sound = new RepSound({
    preset: 'fahh',
    contextFactory: () => ctx,
    fetchAudio: () => {
      fetches += 1;
      return Promise.resolve(new ArrayBuffer(8));
    },
  });

  sound.arm();
  await sound.loading;
  sound.play();
  sound.play();

  assert.equal(fetches, 1, 'fetched once for the life of the page');
  assert.equal(decodes, 1, 'and decoded once - never on the rep');
  assert.equal(ctx.samples.length, 2, 'both reps played the file');
  assert.equal(notesPlayed(ctx), 0, 'and neither fell back to the beeps');
});

test('a file that will not load falls back for good rather than going silent', async () => {
  const ctx = fakeContext({ decode: () => Promise.reject(new Error('bad data')) });
  const sound = new RepSound({
    preset: 'fahh',
    contextFactory: () => ctx,
    fetchAudio: () => Promise.reject(new Error('404')),
  });

  sound.arm();
  await sound.loading;

  assert.doesNotThrow(() => sound.play());
  assert.equal(notesPlayed(ctx), PRESETS[FALLBACK_PRESET].length);
});

test('the audio device is held open so it cannot doze off between reps', () => {
  const ctx = fakeContext();
  const sound = new RepSound({ preset: 'coin', contextFactory: () => ctx });

  sound.arm();
  sound.arm();
  sound.play();

  const keepAlive = ctx.started.filter((n) => n.hz === 20);
  assert.equal(keepAlive.length, 1, 'one silent source, held for the life of the page');
});

test('the sample window is the one measured off the real file', () => {
  const spec = SAMPLES.fahh;
  assert.ok(spec.startMs >= 900, 'the recording is silent for its first second');
  assert.ok(spec.durationMs <= 1000, 'a quick one, as asked');
  assert.ok(spec.fadeMs > 0, 'the tail is faded, not cut');
});

test('a rep landing mid-sound retriggers it instead of stacking', async () => {
  const ctx = fakeContext({ decode: () => Promise.resolve(fakeDecoded()) });
  const sound = new RepSound({
    preset: 'fahh',
    contextFactory: () => ctx,
    fetchAudio: () => Promise.resolve(new ArrayBuffer(8)),
  });

  sound.arm();
  await sound.loading;
  sound.play();
  sound.play();

  assert.equal(ctx.samples.length, 2, 'both reps were answered');
  assert.ok(ctx.samples[0].stopped !== null, 'and the first was ducked out rather than left to overlap');
  assert.equal(ctx.samples[1].stopped, null, 'while the newest keeps playing');
});
