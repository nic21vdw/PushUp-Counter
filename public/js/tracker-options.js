/**
 * Query-string options for the OBS tracker view.
 *
 * Kept pure and separate from the DOM so the parsing rules can be tested, and
 * so a typo in an OBS browser-source URL fails predictably rather than silently
 * turning a feature off mid-stream.
 */

export const DEFAULT_TRACKER_OPTIONS = {
  /** Draw the webcam picture. Off leaves just the skeleton over your scene. */
  video: true,
  /** Cut the background away with the pose segmentation mask. */
  cutout: false,
  /** Solid colour behind you: a chroma key for people who prefer keying in OBS. */
  background: null,
  /** Draw the pose skeleton. */
  skeleton: true,
  /** Show the push-ups-left number baked into the source. */
  counter: true,
  /** Count reps from this page. Off means display-only. */
  count: false,
  /** Flip horizontally, to match a mirrored camera in your scene. */
  mirror: false,
  /**
   * Paint faults into a box on the source. Off by default: this page is on
   * stream, and a red banner across the scene tells the audience about a
   * problem only the streamer can fix. Failures still reach the console, and
   * camera.html reports them properly. Turn it on while you are setting up.
   */
  status: false,
  /** Height of the baked-in counter text, in px. */
  size: 64,
  /** Colour of that text. */
  color: '#ffffff',
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function bool(raw, fallback) {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  // A bare `?cutout` reads as "turn it on".
  if (value === '') return true;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

/** `00ff00`, `#00ff00`, `lime` — anything CSS understands, plus bare hex. */
export function normalizeColor(raw, fallback = null) {
  if (raw === null) return fallback;
  const value = raw.trim();
  if (value === '') return fallback;
  if (/^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(value)) return `#${value}`;
  return value;
}

/**
 * @param {URLSearchParams} params
 * @returns {typeof DEFAULT_TRACKER_OPTIONS}
 */
export function parseTrackerOptions(params) {
  const d = DEFAULT_TRACKER_OPTIONS;
  const size = Number(params.get('size'));

  const options = {
    video: bool(params.get('video'), d.video),
    cutout: bool(params.get('cutout'), d.cutout),
    background: normalizeColor(params.get('bg'), d.background),
    skeleton: bool(params.get('skeleton'), d.skeleton),
    counter: bool(params.get('counter'), d.counter),
    count: bool(params.get('count'), d.count),
    mirror: bool(params.get('mirror'), d.mirror),
    status: bool(params.get('status'), d.status),
    size: Number.isFinite(size) && size > 0 ? size : d.size,
    color: normalizeColor(params.get('color'), d.color),
  };

  // A solid background is only meaningful behind a cutout — otherwise the video
  // frame covers it, and asking for `bg` alone would look like nothing happened.
  if (options.background && options.video) options.cutout = true;

  return options;
}

/** Does this configuration need the segmentation mask computed? */
export function needsSegmentation(options) {
  return Boolean(options.cutout && options.video);
}
