/**
 * The overlay has one status line and two independent writers: the camera
 * lifecycle and the server connection. These cover the precedence between them,
 * and the case that caused the original bug — a message has to be able to take
 * itself back without wiping one another writer still cares about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { StatusSlots } from '../public/js/status-slots.js';

// The order the overlay uses: a dead camera is more urgent than a dropped
// connection, because a dead camera means nothing is being counted at all.
const SLOTS = ['camera', 'server'];

test('nothing set shows nothing', () => {
  const slots = new StatusSlots(SLOTS);
  assert.equal(slots.current(), null);
});

test('the most urgent occupied slot wins regardless of who spoke last', () => {
  const slots = new StatusSlots(SLOTS);

  slots.set('server', 'Lost the server — reps are being held');
  assert.equal(slots.current().message, 'Lost the server — reps are being held');

  // The camera outranks it even though it arrived afterwards.
  slots.set('camera', 'Webcam is held by another app');
  assert.equal(slots.current().message, 'Webcam is held by another app');

  // ...and still outranks it when the lower slot speaks again.
  slots.set('server', 'Server error (500) — retrying');
  assert.equal(slots.current().message, 'Webcam is held by another app');
});

test('a slot clears itself without wiping the other', () => {
  const slots = new StatusSlots(SLOTS);
  slots.set('camera', 'Requesting camera…', 'info');
  slots.set('server', 'Lost the server');

  // The camera comes up; the server problem is still real and must survive.
  slots.set('camera', '');
  assert.equal(slots.current().message, 'Lost the server');
});

test('a cleared top slot uncovers a real error underneath', () => {
  const slots = new StatusSlots(SLOTS);
  slots.set('server', 'Lost the server — reps are being held');
  slots.set('camera', 'Loading pose model…', 'info');
  assert.equal(slots.current().message, 'Loading pose model…');

  slots.set('camera', '');
  assert.equal(
    slots.current().message,
    'Lost the server — reps are being held',
    'the server problem was never fixed, so it has to come back into view',
  );
});

test('everything clear leaves the line empty rather than stuck on the last message', () => {
  const slots = new StatusSlots(SLOTS);
  slots.set('camera', 'Requesting camera…', 'info');
  slots.set('server', 'Lost the server');

  slots.set('server', '');
  slots.set('camera', '');
  assert.equal(slots.current(), null, 'a stale status box on stream is worse than none');
});

test('tone rides along so start-up progress is not painted as failure', () => {
  const slots = new StatusSlots(SLOTS);
  // The overlay only draws `info` while you are setting the source up; on
  // stream a visible box always means something is genuinely wrong.
  assert.equal(slots.set('camera', 'Loading pose model…', 'info').tone, 'info');
  assert.equal(slots.set('camera', 'Camera could not start').tone, 'error');
});

test('an unknown slot is a programming mistake, not a silent no-op', () => {
  const slots = new StatusSlots(SLOTS);
  assert.throws(() => slots.set('typo', 'hello'), /unknown status slot/);
});
