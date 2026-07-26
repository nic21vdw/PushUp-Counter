/**
 * Query-string options for the push-up tracker.
 *
 * The tracker is one page: your webcam, the pose skeleton, and the count, on a
 * transparent background so OBS composites the whole thing over your scene.
 * Everything you can change about it lives here — how the panel looks, which
 * camera it watches, and how fussy the rep detector is.
 *
 * They are URL params rather than controls, because a control that can change
 * the count is a control that can fake it, and one you can reach mid-set is one
 * you will reach for.
 *
 * Kept pure and DOM-free so the parsing rules can be tested, and so a typo in a
 * browser-source URL fails predictably rather than silently turning a feature
 * off halfway through a stream.
 */

export const DEFAULT_OVERLAY_OPTIONS = {
  /** Height of the number, in px. */
  size: 88,
  /** Colour of the number. White on transparent is the OBS default for a reason. */
  color: '#ffffff',
  /** Text under the number. An empty string hides it. */
  label: 'PUSH-UPS LEFT',
  /** Any font installed on the machine; null keeps the built-in stack. */
  font: null,
  /** Font weight of the number. */
  weight: 800,
  /** Drop shadow, so white text survives a light scene behind it. */
  shadow: true,
  /** Progress bar showing how much of what you owe is done. */
  bar: true,
  /** Second line with the subscriber count. */
  subs: false,
  /** Flip the picture, so it reads like a mirror rather than a photograph. */
  mirror: true,
  /** Draw the pose skeleton over the picture. */
  skeleton: true,
  /** Show the camera tile at all. Off leaves just the number. */
  video: true,
  /** Corner radius of the camera tile, in px. */
  radius: 18,
  /** Open the webcam and count reps. Off is a display-only duplicate. */
  count: true,
  /**
   * Which webcam to watch: any part of its name, or a full deviceId. Null takes
   * the browser's default, which on a streaming machine is often the one OBS
   * has already claimed.
   */
  camera: null,
  /** Show the detector's live readout while you tune. Never use on stream. */
  setup: false,
};

/** Detector thresholds, overridable per machine without a settings panel. */
export const DETECTION_PARAMS = [
  ['down', 'downAngle'],
  ['up', 'upAngle'],
  ['plank', 'minPlankAngle'],
  ['smoothing', 'smoothing'],
  ['minrep', 'minRepMs'],
];

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function bool(raw, fallback) {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  // A bare `?setup` reads as "turn it on".
  if (value === '') return true;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

/** `ffffff`, `#ffffff`, `white` — anything CSS understands, plus bare hex. */
export function normalizeColor(raw, fallback = null) {
  if (raw === null) return fallback;
  const value = raw.trim();
  if (value === '') return fallback;
  if (/^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(value)) return `#${value}`;
  return value;
}

function positive(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(raw, fallback) {
  // Zero is a legitimate answer here (square corners), so absence has to be
  // ruled out first — `Number(null)` is 0, which would read as "squared off".
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * @param {URLSearchParams} params
 * @returns {typeof DEFAULT_OVERLAY_OPTIONS}
 */
export function parseOverlayOptions(params) {
  const d = DEFAULT_OVERLAY_OPTIONS;

  // A label of '' is meaningful — it is how you keep only the digits — so a
  // present-but-empty param is not the same as an absent one.
  const rawLabel = params.get('label');

  return {
    size: positive(params.get('size'), d.size),
    color: normalizeColor(params.get('color'), d.color),
    label: rawLabel === null ? d.label : rawLabel,
    font: params.get('font')?.trim() || d.font,
    weight: positive(params.get('weight'), d.weight),
    // `shadow=none` is the spelling the README has always documented.
    shadow: params.get('shadow') === 'none' ? false : bool(params.get('shadow'), d.shadow),
    bar: bool(params.get('bar'), d.bar),
    subs: bool(params.get('subs'), d.subs),
    mirror: bool(params.get('mirror'), d.mirror),
    skeleton: bool(params.get('skeleton'), d.skeleton),
    video: bool(params.get('video'), d.video),
    radius: nonNegative(params.get('radius'), d.radius),
    count: bool(params.get('count'), d.count),
    camera: params.get('camera')?.trim() || d.camera,
    setup: bool(params.get('setup'), d.setup),
  };
}

/**
 * Detector thresholds pulled out of the same URL. Only params that are actually
 * present come back, so the RepCounter keeps its own defaults for the rest.
 *
 * @param {URLSearchParams} params
 * @returns {Record<string, number>}
 */
export function parseDetectionOptions(params) {
  const patch = {};
  for (const [key, option] of DETECTION_PARAMS) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (Number.isFinite(value) && value > 0) patch[option] = value;
  }
  return patch;
}
