/**
 * The chirp on a counted rep.
 *
 * It fires from inside the detection loop on a page that is live on stream, so
 * the thing worth testing hardest is that it cannot throw: a machine with no
 * audio device, or a tab that has never been clicked, has to go quiet rather
 * than take the counting down with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RepSound, DEFAULT_VOLUME } from '../public/js/rep-sound.js';

/** Enough of the Web Audio API to record what a chirp asked for. */
function fakeContext({ state = 'running' } = {}) {
  const ctx = {
    state,
    currentTime: 0,
    closed: false,
    resumed: 0,
    started: [],
    gains: [],
    createGain() {
      const node = {
        gain: { ramps: [], setValueAtTime: () => {}, exponentialRampToValueAtTime: (v) => node.gain.ramps.push(v) },
        connect: () => {},
      };
      ctx.gains.push(node);
      return node;
    },
    createOscillator() {
      const node = {
        type: null,
        frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
        start: () => ctx.started.push(node),
        stop: () => {},
      };
      return node;
    },
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

  assert.equal(ctx.started.length, 1, 'one rep, one chirp');
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
  assert.equal(ctx.started.length, 3);
});

test('a page that has not been clicked yet gets resumed rather than staying mute', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = new RepSound({ contextFactory: () => ctx });

  sound.play();

  assert.equal(ctx.resumed, 1, 'autoplay policy is the usual reason for silence');
  assert.equal(ctx.started.length, 1);
});

test('sound off means no audio device is ever opened', () => {
  let built = 0;
  const sound = new RepSound({
    enabled: false,
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

  const peak = Math.max(...ctx.gains[0].gain.ramps);
  assert.ok(peak <= 0.0001, `muted, got peak gain ${peak}`);
});

test('the status readout names why it is quiet', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const sound = new RepSound({ contextFactory: () => ctx });

  assert.equal(sound.status, 'idle', 'nothing has opened the device yet');
  sound.arm();
  assert.equal(sound.status, 'running');
});

test('leaving the page releases the audio device', () => {
  const ctx = fakeContext();
  const sound = new RepSound({ contextFactory: () => ctx });

  sound.play();
  sound.stop();

  assert.equal(ctx.closed, true);
});
