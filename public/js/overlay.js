/**
 * The whole thing, as one OBS browser source.
 *
 * Subscribers arriving while you are live push the number up (the server does
 * that, off the YouTube API). The webcam watching you push the number down.
 * Nothing else moves it — there is no button here, and no endpoint behind one.
 *
 * On stream the camera is opened but never drawn: the page stays transparent
 * and shows only the number. `?setup=1` draws the picture and the skeleton so
 * you can frame yourself once, then you take it back out of the URL.
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
const readout = document.getElementById('readout');
const countEl = document.getElementById('count');
const labelEl = document.getElementById('label');
const barEl = document.getElementById('bar');
const barFill = barEl.querySelector('i');
const sublineEl = document.getElementById('subline');
const doneNote = document.getElementById('done-note');
const statusEl = document.getElementById('status');

/* ------------------------------------------------------------------ look */

if (options.setup) document.body.dataset.setup = '1';

readout.style.setProperty('--size', `${options.size}px`);
readout.style.setProperty('--color', options.color);
readout.style.setProperty('--weight', String(options.weight));
if (options.font) readout.style.setProperty('--font', options.font);
if (!options.shadow) readout.style.setProperty('--shadow', 'none');
readout.style.setProperty('--align', options.align);
readout.style.setProperty(
  '--items',
  options.align === 'center' ? 'center' : options.align === 'right' ? 'flex-end' : 'flex-start',
);

labelEl.textContent = options.label;
labelEl.hidden = options.label === '';
readout.classList.add('ready');

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
const clientId = `overlay-${Math.random().toString(36).slice(2, 10)}`;

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
  onConnection: (up) => readout.classList.toggle('offline', !up),
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

  doneNote.hidden = left !== 0;

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

/* ----------------------------------------------------------- the counting */

let tracker = null;

/**
 * On stream nothing is drawn: clearing the canvas and returning leaves it fully
 * transparent. Handing PoseTracker a frame callback at all is what stops it
 * painting its own skeleton over your scene.
 */
function onFrame({ ctx, canvas: c, video: v, landmarks }) {
  if (!options.setup) return;
  ctx.drawImage(v, 0, 0, c.width, c.height);
  tracker?.drawSkeleton(landmarks);
}

function handlePose({ landmarks, worldLandmarks, timestamp }) {
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
 * A blank source is the worst thing that can happen mid-stream, so say which
 * camera it wanted and which ones it can see. "Device in use" on a machine with
 * four video inputs is not a diagnosis on its own.
 */
async function describeCameraFailure(err) {
  if (err?.name !== 'NotReadableError') return `Camera could not start: ${err?.message ?? err}`;

  let names = '';
  try {
    const { listCameras } = await import('./pose-tracker.js');
    names = (await listCameras()).map((d) => d.label).filter(Boolean).join(', ');
  } catch {
    /* nothing to add */
  }

  return (
    `The ${options.camera ? `"${options.camera}" ` : ''}webcam is already in use — ` +
    'close the setup tab, and remove any Video Capture Device for it from your OBS scenes.' +
    (names ? ` Cameras on this machine: ${names}. Pick one with ?camera=NAME.` : '')
  );
}

if (options.count) {
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
