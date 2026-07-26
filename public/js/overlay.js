/**
 * The push-up tracker, as one thing OBS displays.
 *
 * Subscribers arriving while you are live push the number up (the server does
 * that, off the YouTube API). The webcam watching you pushes it down. Nothing
 * else moves it — there is no button here, and no endpoint behind one.
 *
 * The page draws a rounded camera tile with the pose skeleton on it and the
 * count beside it, on a transparent background, so the whole panel composites
 * over your scene as a single browser source.
 */

import { RepCounter, DEFAULT_OPTIONS } from './rep-counter.js';
import { anglesFromLandmarks } from './pose-math.js';
import { CounterClient } from './counter-client.js';
import { StatusSlots } from './status-slots.js';
import { parseOverlayOptions, parseDetectionOptions } from './overlay-options.js';

const params = new URLSearchParams(location.search);
const options = parseOverlayOptions(params);

const video = document.getElementById('video');
const canvas = document.getElementById('stage');
const panel = document.getElementById('panel');
const tile = document.getElementById('tile');
const countEl = document.getElementById('count');
const labelEl = document.getElementById('label');
const barEl = document.getElementById('bar');
const barFill = barEl.querySelector('i');
const sublineEl = document.getElementById('subline');
const tuneEl = document.getElementById('tune');
const statusEl = document.getElementById('status');

/* ------------------------------------------------------------------ look */

document.body.dataset.mirror = options.mirror ? '1' : '0';
document.body.dataset.video = options.video ? '1' : '0';

panel.style.setProperty('--size', `${options.size}px`);
panel.style.setProperty('--color', options.color);
panel.style.setProperty('--weight', String(options.weight));
panel.style.setProperty('--radius', `${options.radius}px`);
if (options.font) panel.style.setProperty('--font', options.font);
if (!options.shadow) panel.style.setProperty('--shadow', 'none');

labelEl.textContent = options.label;
labelEl.hidden = options.label === '';
panel.classList.add('ready');

/* ---------------------------------------------------------------- status */

// The camera lifecycle and the server connection both report here; slots stop
// them wiping each other, and let a message be taken back when it stops being
// true. Start-up chatter is only worth showing while you are setting up.
const statuses = new StatusSlots(['camera', 'server']);

function setStatus(slot, message, tone = 'error') {
  const winner = statuses.set(slot, message, tone);
  const show = winner && (winner.tone === 'error' || options.setup);
  statusEl.textContent = show ? winner.message : '';
  statusEl.hidden = !show;
  statusEl.dataset.tone = winner?.tone ?? 'error';
}

/* ----------------------------------------------------------------- state */

// Identifies this page to the server, so two of them counting the same
// push-ups shows up as a warning instead of a silently doubled total.
const clientId = `tracker-${Math.random().toString(36).slice(2, 10)}`;

const counter = new RepCounter({ ...DEFAULT_OPTIONS, ...parseDetectionOptions(params) });

let serverState = null;
let pendingReps = 0;
let lastShown = null;

const client = new CounterClient({
  clientId,
  onState: (state) => {
    serverState = state;
    render();
  },
  onPending: (count) => {
    pendingReps = count;
    render();
  },
  onError: (message) => setStatus('server', message),
  // A number that stopped updating is worse than an obviously dimmed one.
  onConnection: (up) => panel.classList.toggle('offline', !up),
});

const format = (n) => Number(n).toLocaleString('en-US');

function render() {
  if (!serverState) return;

  // Reps in flight are already counted here but not yet in the server's total,
  // so subtract them to keep the number honest and instant.
  const left = Math.max(0, (serverState.rawLeft ?? serverState.left ?? 0) - pendingReps);
  countEl.textContent = format(left);

  if (lastShown !== null && left !== lastShown) {
    countEl.classList.remove('bump');
    void countEl.offsetWidth; // restart the animation
    countEl.style.setProperty('--pulse', left < lastShown ? '#4ade80' : '#ff5a5a');
    countEl.classList.add('bump');
  }
  lastShown = left;

  if (options.bar) {
    const owed = serverState.owed ?? 0;
    const done = (serverState.done ?? 0) + pendingReps;
    // Nothing owed yet is an empty bar, not a full one — you have not finished,
    // there is simply nothing to finish.
    const fraction = owed > 0 ? Math.min(1, Math.max(0, done / owed)) : 0;
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    barEl.hidden = false;
  }

  if (options.subs && serverState.subs !== null) {
    const gained = serverState.subsGained ?? 0;
    sublineEl.textContent =
      `${format(serverState.subs)} subs` +
      (gained ? ` · ${gained > 0 ? '+' : ''}${format(gained)} this stream` : '');
    sublineEl.hidden = false;
  } else {
    sublineEl.hidden = true;
  }
}

/* --------------------------------------------------------------- drawing */

let tracker = null;

function onFrame({ ctx, canvas: c, video: v, landmarks }) {
  ctx.drawImage(v, 0, 0, c.width, c.height);
  if (options.skeleton) tracker?.drawSkeleton(landmarks);
}

/** Acknowledge a counted rep on the tile, for when you cannot see the number. */
function flashRep() {
  tile.classList.add('rep');
  setTimeout(() => tile.classList.remove('rep'), 240);
}

/* -------------------------------------------------------------- counting */

function handlePose({ landmarks, worldLandmarks, timestamp }) {
  const { elbowAngle, plankAngle } = anglesFromLandmarks(
    landmarks,
    worldLandmarks,
    counter.options.minVisibility,
  );
  const result = counter.update({ elbowAngle, plankAngle, timestamp });

  if (options.setup) {
    // The numbers you need to set the thresholds, where you can see them while
    // doing the movement. Off on stream.
    tuneEl.hidden = false;
    tuneEl.innerHTML =
      `elbow <b>${result.angle === null ? '—' : Math.round(result.angle)}°</b> · ` +
      `plank <b>${result.plankAngle === null ? '—' : Math.round(result.plankAngle)}°</b> · ` +
      `<b>${result.state}</b> · ${result.feedback}`;
  }

  if (!options.count) return;
  if (result.repCompleted) {
    client.reportReps(1);
    tracker?.flash();
    flashRep();
  }
}

async function startCamera() {
  const { PoseTracker } = await import('./pose-tracker.js');
  tracker = new PoseTracker({
    video,
    canvas,
    camera: options.camera,
    onPose: handlePose,
    onFrame,
    onStatus: (message) => setStatus('camera', message === 'Tracking' ? '' : message, 'info'),
  });
  await tracker.start();
  setStatus('camera', '');
}

/**
 * A blank tile is the worst thing that can happen mid-stream, so say which
 * camera it wanted and which ones it can see. "Device in use" on a machine with
 * four video inputs is not a diagnosis on its own.
 */
async function describeCameraFailure(err) {
  if (err?.name !== 'NotReadableError' && err?.name !== 'NotFoundError') {
    return `Camera could not start: ${err?.message ?? err}`;
  }

  let names = '';
  try {
    const { listCameras } = await import('./pose-tracker.js');
    names = (await listCameras())
      .map((d) => d.label)
      .filter(Boolean)
      .join(', ');
  } catch {
    /* nothing to add */
  }

  const wanted = options.camera ? `The "${options.camera}" camera` : 'The default camera';
  const problem =
    err.name === 'NotFoundError'
      ? 'was not found'
      : 'is already in use — remove any Video Capture Device for it from your OBS scenes';

  return (
    `${wanted} ${problem}.` +
    (names ? ` Cameras on this machine: ${names}. Pick one with ?camera=NAME.` : '')
  );
}

// The tile is the point of this layout, so open the camera whenever it is
// shown — even with counting off, a display-only duplicate still wants the
// picture. Only `video=0` skips it entirely.
if (options.video || options.count) {
  startCamera().catch(async (err) => {
    console.error(err);
    setStatus('camera', await describeCameraFailure(err));
  });
}

// OBS reloads a browser source when the scene comes back; release the camera on
// the way out so the next load isn't fighting a stream that never stopped.
window.addEventListener('pagehide', () => {
  tracker?.stop();
  client.stop();
});

// Paint immediately rather than showing a dash until the first event.
fetch('/api/state')
  .then((res) => res.json())
  .then((state) => {
    if (!serverState) {
      serverState = state;
      render();
    }
  })
  .catch(() => {});

client.connect();
