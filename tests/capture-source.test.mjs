import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPTURE, PoseTracker } from '../public/js/pose-tracker.js';

/**
 * A tracker built on stubs. Enough to reach the argument checks in start()
 * without a DOM, a GPU, or the 24 MiB pose model — those checks run before
 * anything is loaded or any permission is asked for, which is the point.
 */
const stubTracker = () =>
  new PoseTracker({
    video: {},
    canvas: { getContext: () => ({}) },
    onPose: () => {},
  });

test('both capture sources are offered', () => {
  assert.deepEqual(Object.keys(CAPTURE).sort(), ['camera', 'screen']);
  for (const [name, source] of Object.entries(CAPTURE)) {
    assert.equal(typeof source.getStream, 'function', `${name}.getStream`);
    assert.equal(typeof source.label, 'string', `${name}.label`);
    assert.ok(source.label.length > 0, `${name}.label is not empty`);
  }
});

// Flipping a shared screen reverses every caption in it; not flipping a webcam
// makes the preview useless to move against.
test('only the webcam is mirrored', () => {
  assert.equal(CAPTURE.camera.mirror, true);
  assert.equal(CAPTURE.screen.mirror, false);
});

test('an unknown source is refused before anything is loaded', async () => {
  const tracker = stubTracker();
  await assert.rejects(() => tracker.start({ source: 'telepathy' }), /unknown capture source/);
  // Rejecting must not leave the tracker looking live, or the page's stop button
  // becomes the only way out of a state it never entered.
  assert.equal(tracker.running, false);
  assert.equal(tracker.stream, null);
});

test('the webcam stays the default source', async () => {
  const tracker = stubTracker();
  assert.equal(tracker.source, 'camera');

  // Stubbed so the test never reaches the network for the pose model, and never
  // reaches a permission prompt. Getting this far already proves the source was
  // accepted and recorded.
  tracker.load = () => {
    throw new Error('stopped at load');
  };

  // No argument at all must resolve to the webcam, not fall through to a picker.
  await assert.rejects(() => tracker.start(), /stopped at load/);
  assert.equal(tracker.source, 'camera');

  await assert.rejects(() => tracker.start({ source: 'screen' }), /stopped at load/);
  assert.equal(tracker.source, 'screen');
});

test('a stopped tracker reports which source it was', () => {
  const tracker = stubTracker();
  const said = [];
  tracker.onStatus = (message) => said.push(message);
  tracker.ctx = { clearRect: () => {} };

  tracker.source = 'screen';
  tracker.stop();
  assert.match(said.at(-1), /[Ss]haring/);

  tracker.source = 'camera';
  tracker.stop();
  assert.match(said.at(-1), /[Cc]amera/);
});
