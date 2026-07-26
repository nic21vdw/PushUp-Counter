/**
 * Builds the Browser Source URL you paste into OBS.
 *
 * There is one source now — the overlay counts and displays at the same time —
 * so this is one function. The status page shows what it returns.
 *
 * Kept pure and DOM-free so the rules below can be tested.
 */

import { DEFAULT_OVERLAY_OPTIONS } from './overlay-options.js';

/** Query keys, in the order they should appear, mapped to their option name. */
const KEYS = [
  ['size', 'size'],
  ['color', 'color'],
  ['font', 'font'],
  ['weight', 'weight'],
  ['subs', 'subs'],
  ['bar', 'bar'],
  ['mirror', 'mirror'],
  ['skeleton', 'skeleton'],
  ['video', 'video'],
  ['layout', 'layout'],
  ['radius', 'radius'],
  ['count', 'count'],
  ['camera', 'camera'],
];

/** `shadow` is spelled as a word, not a flag, because `shadow=none` predates it. */
const SHADOW_OFF = 'none';

/**
 * Only params that differ from the page's own defaults are emitted. A URL that
 * restates every default is unreadable, and worse, it pins behaviour that would
 * otherwise track the defaults — so a source pasted today keeps whatever the
 * page did on the day it was built.
 *
 * @param {string} origin e.g. `http://127.0.0.1:4747`
 * @param {Partial<typeof DEFAULT_OVERLAY_OPTIONS>} choices
 * @returns {string}
 */
export function buildOverlayUrl(origin, choices = {}) {
  const params = new URLSearchParams();

  for (const [key, option] of KEYS) {
    if (!(option in choices)) continue;
    const value = choices[option];
    const fallback = DEFAULT_OVERLAY_OPTIONS[option];

    if (value === null || value === undefined || value === '') continue;
    if (value === fallback) continue;

    if (typeof value === 'boolean') params.set(key, value ? '1' : '0');
    else if (key === 'color') params.set(key, stripHash(String(value)));
    else params.set(key, String(value));
  }

  // A label of '' is meaningful — it is how you hide the words after the number
  // — so it is checked separately from the falsy skips above.
  if (choices.label !== null && choices.label !== undefined && choices.label !== DEFAULT_OVERLAY_OPTIONS.label) {
    params.set('label', choices.label);
  }

  if (choices.shadow === false) params.set('shadow', SHADOW_OFF);

  return withQuery(`${origin}/overlay.html`, params);
}

function stripHash(value) {
  // `#` starts a fragment; a raw one truncates the URL at the colour.
  return value.startsWith('#') ? value.slice(1) : value;
}

function withQuery(base, params) {
  const query = params.toString();
  // URLSearchParams percent-encodes spaces as `+`, which is correct for form
  // bodies but reads as a literal plus in a browser-source box on some builds.
  return query ? `${base}?${query.replace(/\+/g, '%20')}` : base;
}
