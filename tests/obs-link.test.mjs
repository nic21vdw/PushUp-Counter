import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrackerUrl, buildOverlayUrl, redactToken } from '../public/js/obs-link.js';
import { parseTrackerOptions } from '../public/js/tracker-options.js';

const ORIGIN = 'http://127.0.0.1:4747';
const query = (url) => new URLSearchParams(new URL(url).search);

test('no choices gives the bare page', () => {
  assert.equal(buildTrackerUrl(ORIGIN), `${ORIGIN}/tracker.html`);
  assert.equal(buildOverlayUrl(ORIGIN), `${ORIGIN}/overlay.html`);
});

test('choices that match the defaults are left out of the URL', () => {
  const url = buildTrackerUrl(ORIGIN, { video: true, skeleton: true, counter: true, size: 64 });
  assert.equal(url, `${ORIGIN}/tracker.html`);
});

test('turning a default-on feature off is emitted', () => {
  assert.equal(query(buildTrackerUrl(ORIGIN, { video: false })).get('video'), '0');
  assert.equal(query(buildTrackerUrl(ORIGIN, { skeleton: false })).get('skeleton'), '0');
});

test('the built URL parses back to the options that were asked for', () => {
  const choices = { count: true, cutout: true, mirror: true, counter: false, size: 96 };
  const parsed = parseTrackerOptions(query(buildTrackerUrl(ORIGIN, choices)));
  for (const [key, value] of Object.entries(choices)) {
    assert.equal(parsed[key], value, key);
  }
});

test('a colour keeps its hash out of the URL', () => {
  // A raw `#` would start a fragment and truncate the query at the colour.
  const url = buildTrackerUrl(ORIGIN, { color: '#ff0044', background: '#00ff00' });
  assert.ok(!url.includes('#'), url);
  assert.equal(query(url).get('color'), 'ff0044');
  assert.equal(query(url).get('bg'), '00ff00');
});

test('an empty label is kept — it is how you hide the word after the number', () => {
  assert.equal(query(buildTrackerUrl(ORIGIN, { label: '' })).get('label'), '');
  assert.equal(query(buildOverlayUrl(ORIGIN, { label: '' })).get('label'), '');
});

test('spaces in a label survive as spaces, not plus signs', () => {
  const url = buildOverlayUrl(ORIGIN, { label: 'PUSH-UPS TO GO' });
  assert.ok(!url.includes('+'), url);
  assert.equal(query(url).get('label'), 'PUSH-UPS TO GO');
});

test('the token rides along only when the source counts', () => {
  assert.equal(query(buildTrackerUrl(ORIGIN, { count: true }, 'sekrit')).get('token'), 'sekrit');
  // Display-only sources never write, so they have no reason to carry it.
  assert.equal(query(buildTrackerUrl(ORIGIN, { count: false }, 'sekrit')).get('token'), null);
  assert.equal(query(buildTrackerUrl(ORIGIN, { count: true }, null)).get('token'), null);
});

test('a token is hidden for display without mangling the rest', () => {
  const shown = redactToken(`${ORIGIN}/tracker.html?count=1&token=sekrit`);
  assert.ok(!shown.includes('sekrit'), shown);
  assert.ok(shown.includes('count=1'), shown);
});

test('overlay options are emitted only when set', () => {
  assert.equal(buildOverlayUrl(ORIGIN, { subs: false, numberonly: false }), `${ORIGIN}/overlay.html`);
  const url = buildOverlayUrl(ORIGIN, { size: 120, align: 'center', subs: true });
  assert.deepEqual([...query(url).entries()], [
    ['size', '120'],
    ['align', 'center'],
    ['subs', '1'],
  ]);
});
