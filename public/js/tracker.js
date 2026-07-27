/**
 * OBS tracker view: the webcam, the skeleton, and the count as one transparent
 * browser source.
 *
 * This page can also be the thing doing the counting (`?count=1`), which is the
 * setup that avoids fighting OBS over the webcam — see tracker.html.
 */

import { RepCounter, DEFAULT_OPTIONS } from './rep-counter.js';
import { anglesFromLandmarks } from './pose-math.js';
import { CounterClient } from './counter-client.js';
import { parseTrackerOptions, needsSegmentation } from './tracker-options.js';
import { renderTrackerFrame } from './tracker-render.js';
import { StatusSlots } from './status-slots.js';

const params = new URLSearchParams(location.search);
const options = parseTrackerOptions(params);
const token = params.get('token');

const video = document.getElementById('video');
const canvas = document.getElementById('stage');
const countEl = document.getElementById('count');
const labelEl = document.getElementById('label');
const readout = document.getElementById('readout');
const statusEl = document.getElementById('status');
const settingsLink = document.getElementById('settings-link');

if (options.controls) {
  settingsLink.hidden = false;
  if (token) settingsLink.href = `camera.html?token=${encodeURIComponent(token)}`;
}

// Detection settings are tuned on the camera page; reuse them so the numbers
// don't change just because the reps are being counted somewhere else.
const SETTINGS_KEY = 'pushup-counter/detection-settings/v1';
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

// Identifies this page among camera clients, so the server can tell the pages
// apart and warn when two of them are counting the same push-ups.
const clientId = `tracker-${Math.random().toString(36).slice(2, 10)}`;

const counter = new RepCounter({ ...DEFAULT_OPTIONS, ...loadSettings() });
let serverState = null;
let pendingReps = 0;

const client = new CounterClient({
  token,
  clientId,
  onState: (state) => {
    serverState = state;
    renderCount();
    warnOnDoubleCounting(state);
  },
  onPending: (count) => {
    pendingReps = count;
    renderCount();
  },
  onError: (message) => setStatus('server', message),
});

// The camera lifecycle, the server connection, the double-counting check and the
// MediaPipe asset source all report through the one status box; slots keep them
// from wiping each other. `assets` is last: it is advice, not a fault.
const statuses = new StatusSlots(['camera', 'server', 'double', 'assets']);

/**
 * @param {'camera'|'server'|'double'|'assets'} slot
 * @param {string} message falsy clears this slot
 * @param {'error'|'info'} [tone] `info` is progress, not a problem
 */
function setStatus(slot, message, tone = 'error') {
  const winner = statuses.set(slot, message, tone);

  // Faults always reach the console, whether or not they are painted — `?status`
  // controls what the audience sees, not whether the problem is recorded.
  if (message && tone === 'error') console.error(`[${slot}] ${message}`);

  if (!options.status) {
    statusEl.hidden = true;
    return;
  }

  statusEl.textContent = winner?.message ?? '';
  statusEl.hidden = !winner;
  statusEl.dataset.tone = winner?.tone ?? 'error';
}

/**
 * Another page counting the same push-ups doubles them. The server can't tell
 * which one is wanted, so say it rather than silently picking — and take it
 * back as soon as the other page stops, because the server lets the claim
 * expire and a stale warning is worse than none.
 */
function warnOnDoubleCounting(state) {
  if (!options.count) return;
  const other = state.countingClientId;
  setStatus(
    'double',
    other && other !== clientId
      ? 'Another page is also counting reps — close the camera page, or open this one with count=0.'
      : '',
  );
}

function renderCount() {
  if (!options.counter) return;
  const raw = serverState?.rawRemaining ?? serverState?.remaining ?? null;
  if (raw === null) {
    countEl.textContent = '—';
    return;
  }
  const remaining = Math.max(0, raw - pendingReps);
  countEl.textContent = remaining.toLocaleString('en-US');
  labelEl.hidden = false;
}

/* --------------------------------------------------------------- rendering */

const scratch = { mask: document.createElement('canvas'), layer: document.createElement('canvas') };

let tracker = null;

function onFrame(frame) {
  renderTrackerFrame({ ...frame, drawSkeleton: (l, o) => tracker.drawSkeleton(l, o) }, options, scratch);
}

function handlePose({ landmarks, worldLandmarks, timestamp }) {
  if (!options.count) return;

  const { elbowAngle, plankAngle } = anglesFromLandmarks(
    landmarks,
    worldLandmarks,
    counter.options.minVisibility,
  );
  const result = counter.update({ elbowAngle, plankAngle, timestamp });
  if (result.repCompleted) {
    client.reportReps(1);
    tracker?.flash();
  }
}

/**
 * How long the CDN notice stays up on the OBS source, in ms.
 *
 * Unlike the camera page, this page *is* the stream overlay — a permanent notice
 * would be burnt into the broadcast for the whole session. Long enough to catch
 * while you are adding the source or switching scenes, short enough that it is
 * gone before anyone watching reads it. It is also logged to the console, which
 * OBS keeps in the source's inspector, so it survives being dismissed.
 */
const CDN_NOTICE_MS = 20_000;

async function start() {
  const { PoseTracker, CDN_FALLBACK_NOTICE } = await import('./pose-tracker.js');
  tracker = new PoseTracker({
    video,
    canvas,
    onPose: handlePose,
    onFrame,
    segmentation: needsSegmentation(options),
    // Loading and requesting the camera are progress, not faults — a red box
    // for them reads as a broken source while it is still coming up.
    onStatus: (message) => setStatus('camera', message === 'Tracking' ? '' : message, 'info'),
  });

  await tracker.start();
  // The canvas is sized from the video; the page scales it to the source.
  setStatus('camera', '');

  if (tracker.assetSource === 'cdn') {
    console.warn(CDN_FALLBACK_NOTICE);
    setStatus('assets', CDN_FALLBACK_NOTICE, 'info');
    setTimeout(() => setStatus('assets', ''), CDN_NOTICE_MS);
  }
}

start().catch((err) => {
  console.error(err);
  setStatus(
    'camera',
    err?.name === 'NotReadableError'
      ? 'Webcam is held by another app. In OBS, remove the Video Capture Device for this camera — this browser source replaces it.'
      : `Tracker could not start: ${err?.message ?? err}`,
  );
});

// OBS reloads a browser source when the scene comes back; release the camera on
// the way out so the next load isn't fighting a stream that never stopped.
window.addEventListener('pagehide', () => {
  tracker?.stop();
  client.stop();
});

if (!options.counter) readout.hidden = true;
client.connect();
renderCount();
