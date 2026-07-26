import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPTURE, PoseTracker, CDN_FALLBACK_NOTICE } from '../public/js/pose-tracker.js';
import { StatusSlots } from '../public/js/status-slots.js';

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

test('nothing claims an asset source before the model has loaded', () => {
  // A page that trusted a stale/absent value here would either warn about a CDN
  // it never used, or stay quiet about one it did.
  assert.equal(stubTracker().assetSource, null);
});

test('the CDN notice names the command that fixes it', () => {
  assert.match(CDN_FALLBACK_NOTICE, /fetch-assets/);
  assert.match(CDN_FALLBACK_NOTICE, /MediaPipe/);
});

// The pages put 'assets' last on purpose: loading from a CDN is advice, and a
// real failure must not be hidden behind it.
test('a real fault outranks the asset advice', () => {
  const cameraPage = new StatusSlots(['camera', 'server', 'report', 'double', 'assets']);
  cameraPage.set('assets', CDN_FALLBACK_NOTICE, 'info');
  assert.equal(cameraPage.current().message, CDN_FALLBACK_NOTICE, 'shows when alone');

  cameraPage.set('camera', 'Camera permission was denied.');
  assert.equal(cameraPage.current().message, 'Camera permission was denied.');

  // ...and comes back once the fault clears, rather than being lost.
  cameraPage.set('camera', '');
  assert.equal(cameraPage.current().message, CDN_FALLBACK_NOTICE);

  const obsSource = new StatusSlots(['camera', 'server', 'double', 'assets']);
  obsSource.set('assets', CDN_FALLBACK_NOTICE, 'info');
  obsSource.set('double', 'Another page is also counting reps');
  assert.equal(obsSource.current().message, 'Another page is also counting reps');
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
