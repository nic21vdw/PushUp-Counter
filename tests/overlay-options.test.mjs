/**
 * Query-string parsing for the OBS overlay.
 *
 * A browser source URL is typed once and then forgotten about for months, so a
 * typo has to fail predictably. Silently turning the counting off mid-stream is
 * the failure mode worth guarding hardest against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OVERLAY_OPTIONS,
  parseOverlayOptions,
  parseDetectionOptions,
  normalizeColor,
} from '../public/js/overlay-options.js';

const parse = (query) => parseOverlayOptions(new URLSearchParams(query));
const detection = (query) => parseDetectionOptions(new URLSearchParams(query));

test('a bare URL gives a counting tracker with the camera tile showing', () => {
  const options = parse('');
  assert.deepEqual(options, DEFAULT_OVERLAY_OPTIONS);
  assert.equal(options.count, true, 'it counts by default — that is the whole point');
  assert.equal(options.video, true, 'and shows the camera, because that is what OBS displays');
  assert.equal(options.mirror, true, 'a selfie view reads as a mirror, not a photograph');
  assert.equal(options.setup, false, 'the tuning readout stays off stream');
  assert.equal(options.color, '#ffffff');
});

test('booleans accept the spellings people actually type', () => {
  for (const on of ['1', 'true', 'yes', 'on', '']) {
    assert.equal(parse(`setup=${on}`).setup, true, `setup=${on}`);
  }
  for (const off of ['0', 'false', 'no', 'off']) {
    assert.equal(parse(`count=${off}`).count, false, `count=${off}`);
  }
});

test('a nonsense value falls back rather than silently turning counting off', () => {
  assert.equal(parse('count=maybe').count, true);
  assert.equal(parse('bar=perhaps').bar, DEFAULT_OVERLAY_OPTIONS.bar);
});

test('colours are accepted bare, hashed, or named', () => {
  assert.equal(parse('color=00ff00').color, '#00ff00');
  assert.equal(parse('color=%23112233').color, '#112233');
  assert.equal(parse('color=lime').color, 'lime');
  assert.equal(parse('color=').color, '#ffffff', 'empty falls back to white');
});

test('normalizeColor leaves anything CSS understands alone', () => {
  assert.equal(normalizeColor('fff'), '#fff');
  assert.equal(normalizeColor('rgba(0,0,0,.5)'), 'rgba(0,0,0,.5)');
  assert.equal(normalizeColor(null, '#ffffff'), '#ffffff');
});

test('an empty label is kept — it is how you show only the digits', () => {
  assert.equal(parse('label=').label, '');
  assert.equal(parse('label=TO%20GO').label, 'TO GO');
  assert.equal(parse('').label, DEFAULT_OVERLAY_OPTIONS.label, 'absent is not the same as empty');
});

test('size and weight fall back for junk and zero', () => {
  assert.equal(parse('size=140').size, 140);
  assert.equal(parse('size=0').size, DEFAULT_OVERLAY_OPTIONS.size);
  assert.equal(parse('size=huge').size, DEFAULT_OVERLAY_OPTIONS.size);
  assert.equal(parse('weight=900').weight, 900);
});

test('the tile can be squared off, and zero radius is a real choice', () => {
  assert.equal(parse('radius=0').radius, 0, 'square corners are not "no value given"');
  assert.equal(parse('radius=40').radius, 40);
  assert.equal(parse('radius=round').radius, DEFAULT_OVERLAY_OPTIONS.radius);
});

test('the picture can be turned off without turning the counting off', () => {
  const options = parse('video=0');
  assert.equal(options.video, false, 'just the number, no tile');
  assert.equal(options.count, true, 'still watching you and still counting');
});

test('shadow=none is still the documented spelling', () => {
  assert.equal(parse('shadow=none').shadow, false);
  assert.equal(parse('shadow=0').shadow, false);
  assert.equal(parse('').shadow, true);
});

test('a camera can be named, because the default is often the one OBS has', () => {
  assert.equal(parse('').camera, null, 'unnamed means whatever the browser calls default');
  assert.equal(parse('camera=Brio').camera, 'Brio');
  assert.equal(parse('camera=Brio%20100').camera, 'Brio 100');
  assert.equal(parse('camera=%20%20').camera, null, 'whitespace is not a camera name');
});

test('detection thresholds are only returned when actually asked for', () => {
  assert.deepEqual(detection(''), {}, 'the RepCounter keeps its own defaults');
  assert.deepEqual(detection('down=110'), { downAngle: 110 });
  assert.deepEqual(detection('down=110&up=150&plank=130'), {
    downAngle: 110,
    upAngle: 150,
    minPlankAngle: 130,
  });
});

test('a junk threshold is ignored rather than wrecking the detector', () => {
  assert.deepEqual(detection('down=nope'), {});
  assert.deepEqual(detection('up=0'), {}, 'zero would make every frame a completed rep');
  assert.deepEqual(detection('smoothing=-1'), {});
});
