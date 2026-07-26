/**
 * The tracker source and the camera page each have one status line and several
 * independent writers. These cover the precedence between them, and the case
 * that caused the bug: a warning that fires once has to be able to take itself
 * back, without wiping a message another writer still cares about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { StatusSlots } from '../public/js/status-slots.js';

const TRACKER_SLOTS = ['camera', 'server', 'double'];

test('nothing set shows nothing', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);
  assert.equal(slots.current(), null);
});

test('the most urgent occupied slot wins regardless of who spoke last', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);

  slots.set('double', 'two pages are counting');
  assert.equal(slots.current().message, 'two pages are counting');

  // Camera outranks it even though it arrived afterwards.
  slots.set('camera', 'Webcam is held by another app');
  assert.equal(slots.current().message, 'Webcam is held by another app');

  // ...and still outranks it when a lower slot speaks again.
  slots.set('server', 'Lost the server');
  assert.equal(slots.current().message, 'Webcam is held by another app');
});

test('a slot clears itself without wiping the others', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);
  slots.set('camera', 'Requesting camera…', 'info');
  slots.set('double', 'two pages are counting');

  // The camera comes up; the double-count warning must survive.
  slots.set('camera', '');
  assert.equal(slots.current().message, 'two pages are counting');
});

test('the double-count warning goes away when the other page stops', () => {
  // The regression. The server expires its "who is counting" claim after 30s,
  // but the old code had no branch for the claim going away, so the red box
  // stayed on the OBS source for the rest of the stream.
  const slots = new StatusSlots(TRACKER_SLOTS);

  const otherIsCounting = (counting) =>
    slots.set('double', counting ? 'Another page is also counting reps' : '');

  otherIsCounting(true);
  assert.equal(slots.current().message, 'Another page is also counting reps');

  otherIsCounting(false);
  assert.equal(slots.current(), null, 'the warning must clear itself');
});

test('a cleared top slot uncovers a real error underneath', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);
  slots.set('server', 'Lost the server — reps are being held');
  slots.set('camera', 'Requesting camera…', 'info');
  assert.equal(slots.current().message, 'Requesting camera…');

  slots.set('camera', '');
  assert.equal(
    slots.current().message,
    'Lost the server — reps are being held',
    'the server problem was never fixed, so it has to come back into view',
  );
});

test('tone rides along so progress is not painted as failure', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);
  assert.equal(slots.set('camera', 'Loading pose model…', 'info').tone, 'info');
  assert.equal(slots.set('camera', 'Tracker could not start').tone, 'error');
});

test('an unknown slot is a programming mistake, not a silent no-op', () => {
  const slots = new StatusSlots(TRACKER_SLOTS);
  assert.throws(() => slots.set('typo', 'hello'), /unknown status slot/);
});

test('the camera page ranks its four writers the same way', () => {
  const slots = new StatusSlots(['camera', 'server', 'report', 'double']);
  slots.set('report', 'Undo failed (400)');
  slots.set('double', 'the tracker source is also counting');
  assert.equal(slots.current().message, 'Undo failed (400)');

  slots.set('report', '');
  assert.equal(slots.current().message, 'the tracker source is also counting');
});
