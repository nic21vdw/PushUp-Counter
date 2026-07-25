import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTrackerOptions,
  needsSegmentation,
  normalizeColor,
  DEFAULT_TRACKER_OPTIONS,
} from '../public/js/tracker-options.js';

const parse = (query) => parseTrackerOptions(new URLSearchParams(query));

test('an empty URL gives the defaults', () => {
  assert.deepEqual(parse(''), DEFAULT_TRACKER_OPTIONS);
});

test('the OBS source does not count reps unless asked', () => {
  assert.equal(parse('').count, false);
  assert.equal(parse('count=1').count, true);
});

test('booleans accept the spellings people actually type', () => {
  for (const on of ['1', 'true', 'yes', 'on', 'TRUE', '']) {
    assert.equal(parse(`cutout=${on}`).cutout, true, `cutout=${on}`);
  }
  for (const off of ['0', 'false', 'no', 'off']) {
    assert.equal(parse(`skeleton=${off}`).skeleton, false, `skeleton=${off}`);
  }
});

test('a nonsense value falls back rather than silently turning a feature off', () => {
  assert.equal(parse('skeleton=maybe').skeleton, DEFAULT_TRACKER_OPTIONS.skeleton);
  assert.equal(parse('count=please').count, DEFAULT_TRACKER_OPTIONS.count);
});

test('colours are accepted bare, hashed, or named', () => {
  assert.equal(normalizeColor('00ff00'), '#00ff00');
  assert.equal(normalizeColor('#00ff00'), '#00ff00');
  assert.equal(normalizeColor('0f0'), '#0f0');
  assert.equal(normalizeColor('lime'), 'lime');
  assert.equal(normalizeColor('rgba(0,0,0,0)'), 'rgba(0,0,0,0)');
  assert.equal(normalizeColor(null, '#fff'), '#fff');
  assert.equal(normalizeColor('  ', '#fff'), '#fff');
});

test('asking for a chroma background implies the cutout that makes it visible', () => {
  // Without this, `?bg=00ff00` would draw green and immediately cover it with
  // the camera frame, which reads as "the setting did nothing".
  const options = parse('bg=00ff00');
  assert.equal(options.background, '#00ff00');
  assert.equal(options.cutout, true);
});

test('a background with the video off does not force the cutout on', () => {
  const options = parse('bg=00ff00&video=0');
  assert.equal(options.cutout, false);
  assert.equal(options.background, '#00ff00');
});

test('size falls back for junk and zero', () => {
  assert.equal(parse('size=120').size, 120);
  assert.equal(parse('size=0').size, DEFAULT_TRACKER_OPTIONS.size);
  assert.equal(parse('size=-40').size, DEFAULT_TRACKER_OPTIONS.size);
  assert.equal(parse('size=huge').size, DEFAULT_TRACKER_OPTIONS.size);
});

test('segmentation is only computed when a cutout will actually be drawn', () => {
  assert.equal(needsSegmentation(parse('')), false);
  assert.equal(needsSegmentation(parse('cutout=1')), true);
  assert.equal(needsSegmentation(parse('bg=00ff00')), true);
  // Skeleton-only over your own scene: no mask needed, so don't pay for one.
  assert.equal(needsSegmentation(parse('cutout=1&video=0')), false);
});
