/**
 * The URL the status page hands you to paste into OBS.
 *
 * There is one browser source now, so there is one URL. It has to round-trip
 * through the overlay's own parser — a link that reads back as something else
 * is how you end up live with a source that quietly counts nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOverlayUrl } from '../public/js/obs-link.js';
import { parseOverlayOptions, DEFAULT_OVERLAY_OPTIONS } from '../public/js/overlay-options.js';

const ORIGIN = 'http://127.0.0.1:4747';
const optionsOf = (url) => parseOverlayOptions(new URL(url).searchParams);

test('no choices gives the bare page', () => {
  assert.equal(buildOverlayUrl(ORIGIN), `${ORIGIN}/overlay.html`);
});

test('choices that match the defaults are left out of the URL', () => {
  const url = buildOverlayUrl(ORIGIN, {
    size: DEFAULT_OVERLAY_OPTIONS.size,
    color: DEFAULT_OVERLAY_OPTIONS.color,
    count: true,
  });
  assert.equal(url, `${ORIGIN}/overlay.html`, 'a URL that restates the defaults pins them forever');
});

test('the built URL parses back to the options that were asked for', () => {
  const url = buildOverlayUrl(ORIGIN, { size: 140, subs: true, mirror: false, radius: 0 });
  const options = optionsOf(url);

  assert.equal(options.size, 140);
  assert.equal(options.subs, true);
  assert.equal(options.mirror, false);
  assert.equal(options.radius, 0);
  assert.equal(options.count, true, 'still counting — never turned off by accident');
  assert.equal(options.video, true, 'and still showing the camera');
});

test('a colour keeps its hash out of the URL', () => {
  const url = buildOverlayUrl(ORIGIN, { color: '#00ff00' });
  assert.ok(!url.includes('#'), 'a raw # would truncate the URL at the colour');
  assert.equal(optionsOf(url).color, '#00ff00');
});

test('an empty label survives the round trip', () => {
  const url = buildOverlayUrl(ORIGIN, { label: '' });
  assert.equal(optionsOf(url).label, '', 'it is how you show only the digits');
});

test('spaces in a label survive as spaces, not plus signs', () => {
  const url = buildOverlayUrl(ORIGIN, { label: 'TO GO' });
  assert.ok(!url.includes('+'), 'some OBS builds paste a literal plus');
  assert.equal(optionsOf(url).label, 'TO GO');
});

test('turning counting off is emitted, because it is not the default', () => {
  const url = buildOverlayUrl(ORIGIN, { count: false });
  assert.match(url, /count=0/);
  assert.equal(optionsOf(url).count, false);
});

test('muting a source survives the round trip, silence included', () => {
  const muted = buildOverlayUrl(ORIGIN, { sound: null });
  assert.match(muted, /sound=0/, 'silence is spelled with the switch, not a missing param');
  assert.equal(optionsOf(muted).sound, null);

  assert.equal(optionsOf(buildOverlayUrl(ORIGIN, { sound: 'boing' })).sound, 'boing');
  assert.equal(
    buildOverlayUrl(ORIGIN, { sound: 'coin' }),
    `${ORIGIN}/overlay.html`,
    'the default sound is not worth a query param',
  );

  const quiet = buildOverlayUrl(ORIGIN, { volume: 0 });
  assert.match(quiet, /volume=0/, 'zero is a choice, not an absent value');
  assert.equal(optionsOf(quiet).volume, 0);
});

test('shadow is emitted the way the overlay reads it', () => {
  const url = buildOverlayUrl(ORIGIN, { shadow: false });
  assert.match(url, /shadow=none/);
  assert.equal(optionsOf(url).shadow, false);
});

test('a named camera survives the round trip, spaces and all', () => {
  const url = buildOverlayUrl(ORIGIN, { camera: 'Brio 100' });
  assert.ok(!url.includes('+'), 'a literal plus would not match the device name');
  assert.equal(optionsOf(url).camera, 'Brio 100');
});

test('the URL points at the overlay, and carries no token', () => {
  const url = buildOverlayUrl(ORIGIN, { size: 140, camera: 'Brio' });
  assert.ok(url.startsWith(`${ORIGIN}/overlay.html?`));
  assert.ok(!/token/i.test(url), 'there is no token in this app any more');
});

test('the everyday source needs no query string at all', () => {
  // The bar and the subscriber line are on by default, and the camera comes
  // from the picker, so the URL you paste into OBS is just the page.
  assert.equal(buildOverlayUrl(ORIGIN, { subs: true, bar: true }), `${ORIGIN}/overlay.html`);
});
