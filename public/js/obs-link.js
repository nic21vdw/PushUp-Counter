/**
 * Builds the Browser Source URLs you paste into OBS.
 *
 * The tracker page takes nine query params and the overlay eight more, which is
 * a lot to hand-assemble on a phone with your hands still shaky from a set. The
 * control page drives this and shows the finished URL, so the answer to "what do
 * I put in OBS" is always one copy away.
 *
 * Kept pure and DOM-free so the rules below can be tested.
 */

import { DEFAULT_TRACKER_OPTIONS } from './tracker-options.js';

/** Query keys, in the order they should appear, mapped to their option name. */
const TRACKER_KEYS = [
  ['count', 'count'],
  ['cutout', 'cutout'],
  ['bg', 'background'],
  ['video', 'video'],
  ['skeleton', 'skeleton'],
  ['counter', 'counter'],
  ['mirror', 'mirror'],
  ['size', 'size'],
  ['color', 'color'],
];

/**
 * Only params that differ from the page's own defaults are emitted. A URL that
 * restates every default is unreadable, and worse, it pins behaviour that would
 * otherwise track the defaults — so a source pasted today keeps whatever the
 * page did on the day it was built.
 *
 * @param {string} origin e.g. `http://127.0.0.1:4747`
 * @param {Partial<typeof DEFAULT_TRACKER_OPTIONS> & {label?: string|null}} choices
 * @param {string|null} token value of CONTROL_TOKEN, if the server requires one
 * @returns {string}
 */
export function buildTrackerUrl(origin, choices = {}, token = null) {
  const params = new URLSearchParams();

  for (const [key, option] of TRACKER_KEYS) {
    if (!(option in choices)) continue;
    const value = choices[option];
    const fallback = DEFAULT_TRACKER_OPTIONS[option];

    // `bg` has no default worth comparing against — null means "don't send it".
    if (value === null || value === undefined || value === '') continue;
    if (value === fallback) continue;

    if (typeof value === 'boolean') params.set(key, value ? '1' : '0');
    else if (key === 'bg' || key === 'color') params.set(key, stripHash(String(value)));
    else params.set(key, String(value));
  }

  // A label of '' is meaningful — it hides the word after the number — so it is
  // checked separately from the falsy skips above.
  if (choices.label !== null && choices.label !== undefined) params.set('label', choices.label);

  // Without the token the source loads, draws, and then silently fails to bank
  // a single rep. Carry it whenever the page counts.
  if (token && choices.count) params.set('token', token);

  return withQuery(`${origin}/tracker.html`, params);
}

/**
 * @param {string} origin
 * @param {{size?: number|null, label?: string|null, align?: string|null,
 *          subs?: boolean, numberonly?: boolean}} choices
 * @returns {string}
 */
export function buildOverlayUrl(origin, choices = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(choices.size) && choices.size > 0) params.set('size', String(choices.size));
  if (choices.label !== null && choices.label !== undefined) params.set('label', choices.label);
  if (choices.align) params.set('align', choices.align);
  if (choices.subs) params.set('subs', '1');
  if (choices.numberonly) params.set('numberonly', '1');
  return withQuery(`${origin}/overlay.html`, params);
}

/**
 * The overlay never writes, so it needs no token — but the tracker does, and a
 * token in a URL you are about to read out on stream is worth hiding.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactToken(url) {
  return url.replace(/([?&]token=)[^&]*/, '$1••••••••');
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
