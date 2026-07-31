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

import { SOUND_NAMES, DEFAULT_PRESET } from './rep-sound.js';

export const DEFAULT_OVERLAY_OPTIONS = {
  /** Height of the number, in px. */
  size: 88,
  /** Colour of the number. White on transparent is the OBS default for a reason. */
  color: '#ffffff',
  /**
   * Text under the number. An empty string hides it. "To do" rather than
   * "left": the figure is work outstanding, and leftovers are what you have
   * when you are finished.
   */
  label: 'PUSH-UPS TO DO',
  /** Any font installed on the machine; null keeps the built-in stack. */
  font: null,
  /** Font weight of the number. */
  weight: 800,
  /** Drop shadow, so white text survives a light scene behind it. */
  shadow: true,
  /** Progress bar toward the number you owe, with the done/owed figures. */
  bar: true,
  /** Line showing how many push-ups this stream's subscribers have cost you. */
  subs: true,
  /**
   * Flip the picture horizontally. Off by default: a selfie view wants
   * mirroring, but this camera is side-on to a push-up, and mirroring reverses
   * any text behind you.
   */
  mirror: false,
  /** Draw the pose skeleton over the picture. */
  skeleton: true,
  /** Show the camera tile at all. Off leaves just the number. */
  video: true,
  /**
   * How the picture and the number are arranged:
   *
   *   'fill'  the camera fills the whole source, number overlaid in a corner.
   *   'side'  a camera tile with the number beside it, on transparent space.
   *
   * `fill` by default: this source is how you watch yourself, and a preview you
   * cannot make out is not worth the space it takes.
   */
  layout: 'fill',
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
  /**
   * Which sound a counted rep makes: `fahh`, `coin`, `powerup`, `pop`, `boing`
   * or `chirp`. Null is silence. On by default — mid-set your head is down and
   * the number is off to the side, so the sound is the only confirmation you
   * get.
   */
  sound: DEFAULT_PRESET,
  /** How loud that sound is, 0 to 1. */
  volume: 0.45,
  /** Show the detector's live readout while you tune. Never use on stream. */
  setup: false,
};

/**
 * Detector thresholds, overridable per machine without a settings panel.
 *
 * The third entry says whether zero is a real answer. Mostly it is not — an up
 * threshold of zero would make every frame a completed rep — but a tolerance
 * turned all the way off is a meaningful setting, and rejecting it would leave
 * no way to ask for a strict full lockout.
 */
export const DETECTION_PARAMS = [
  ['down', 'downAngle', false],
  ['up', 'upAngle', false],
  ['uptol', 'upTolerance', true],
  ['reversal', 'reversalDeg', false],
  ['plank', 'minPlankAngle', false],
  ['smoothing', 'smoothing', false],
  ['minrep', 'minRepMs', true],
  ['minphase', 'minPhaseMs', true],
  ['gap', 'maxGapMs', true],
  ['plankgrace', 'plankGraceMs', true],
];

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const LAYOUTS = new Set(['fill', 'side']);

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

/**
 * `sound` is both a switch and a choice: `sound=0` is silence, `sound=boing`
 * picks one. A name that does not exist falls back to the default rather than
 * to silence — a typo should cost you the sound you wanted, not the feedback.
 */
function soundPreset(raw, fallback) {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (FALSY.has(value)) return null;
  if (SOUND_NAMES.includes(value)) return value;
  return fallback === null ? DEFAULT_PRESET : fallback;
}

function fraction(raw, fallback) {
  // Silence is a real answer — `volume=0` is how you mute one source without
  // giving up the chirp on the others — so absence has to be ruled out first.
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(1, value);
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
    layout: LAYOUTS.has((params.get('layout') ?? '').trim().toLowerCase())
      ? params.get('layout').trim().toLowerCase()
      : d.layout,
    radius: nonNegative(params.get('radius'), d.radius),
    count: bool(params.get('count'), d.count),
    camera: params.get('camera')?.trim() || d.camera,
    sound: soundPreset(params.get('sound'), d.sound),
    volume: fraction(params.get('volume'), d.volume),
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
  for (const [key, option, zeroAllowed] of DETECTION_PARAMS) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (Number.isFinite(value) && (zeroAllowed ? value >= 0 : value > 0)) patch[option] = value;
  }
  return patch;
}
