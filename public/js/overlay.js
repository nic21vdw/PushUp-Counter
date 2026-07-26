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
const progressEl = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const barFill = document.getElementById('bar').querySelector('i');
const sublineEl = document.getElementById('subline');
const tuneEl = document.getElementById('tune');
const statusEl = document.getElementById('status');
const pickerEl = document.getElementById('picker');
const selectEl = document.getElementById('camera-select');
const pickerNote = document.getElementById('picker-note');

/* ------------------------------------------------------------------ look */

document.body.dataset.mirror = options.mirror ? '1' : '0';
document.body.dataset.video = options.video ? '1' : '0';
document.body.dataset.layout = options.layout;

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
/** Reps this page has seen since it loaded. Proof the detector is working. */
let detectedThisSession = 0;

/**
 * Which camera to open. A `?camera=` in the URL is an explicit instruction and
 * wins; otherwise the source follows whatever was chosen in the setup view, so
 * swapping cameras does not mean re-pasting a URL into OBS.
 */
let activeCamera = options.camera;

const client = new CounterClient({
  clientId,
  onState: (state) => {
    serverState = state;
    render();
    if (!options.camera) followServerCamera(state.camera ?? null);
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

  const owed = serverState.owed ?? 0;
  const done = (serverState.done ?? 0) + pendingReps;

  if (options.bar) {
    // Nothing owed yet is an empty bar, not a full one — you have not finished,
    // there is simply nothing to finish.
    const fraction = owed > 0 ? Math.min(1, Math.max(0, done / owed)) : 0;
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    // The bar alone cannot say how big the job is; the figures can.
    progressText.textContent = `${format(done)} / ${format(owed)}`;
    progressEl.hidden = false;
  }

  // What this stream's subscribers have actually cost you, in push-ups. That is
  // the number the chat is responsible for, so it is the one worth showing them
  // — the raw subscriber total is a vanity figure by comparison.
  if (options.subs && serverState.subsEnabled) {
    const gained = serverState.subsGained ?? 0;
    const fromSubs = serverState.fromSubs ?? 0;
    sublineEl.textContent =
      gained > 0
        ? `+${format(fromSubs)} from ${format(gained)} sub${gained === 1 ? '' : 's'} this stream`
        : 'No subs yet this stream';
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
    //
    // `detected` is counted here rather than read back from the server on
    // purpose: when you owe nothing, the push-ups-left figure cannot go below
    // zero, so a working detector and a broken one look identical. This is the
    // readout that tells you the difference.
    tuneEl.hidden = false;
    tuneEl.innerHTML =
      `<b>${detectedThisSession}</b> rep${detectedThisSession === 1 ? '' : 's'} detected · ` +
      `elbow <b>${result.angle === null ? '—' : Math.round(result.angle)}°</b> · ` +
      `plank <b>${result.plankAngle === null ? '—' : Math.round(result.plankAngle)}°</b> · ` +
      `<b>${result.state}</b> · ${result.feedback}`;
  }

  if (result.repCompleted) {
    detectedThisSession += 1;
    tracker?.flash();
    flashRep();
    if (options.count) client.reportReps(1);
  }
}

async function startCamera() {
  const { PoseTracker } = await import('./pose-tracker.js');
  tracker = new PoseTracker({
    video,
    canvas,
    camera: activeCamera,
    onPose: handlePose,
    onFrame,
    onStatus: (message) => setStatus('camera', message === 'Tracking' ? '' : message, 'info'),
  });
  await tracker.start();
  setStatus('camera', '');
}

/**
 * Swap to a different webcam without a reload. The old stream has to be
 * released first or the new one may come back "device in use" against
 * ourselves.
 */
let switching = false;
async function switchCamera(name) {
  if (switching) return;
  switching = true;
  activeCamera = name;
  try {
    tracker?.stop();
    tracker = null;
    await startCamera();
  } catch (err) {
    console.error(err);
    setStatus('camera', await describeCameraFailure(err));
  } finally {
    switching = false;
  }
}

/** The OBS source has no controls, so it takes the setup view's choice. */
function followServerCamera(name) {
  if (name === activeCamera) return;
  switchCamera(name);
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

  // Name the camera actually being opened, which after a switch is not the one
  // in the URL — reporting "the default camera" while trying to open a named
  // one sends you looking in the wrong place.
  const wanted = activeCamera ? `The "${activeCamera}" camera` : 'The default camera';
  const problem =
    err.name === 'NotFoundError'
      ? 'was not found'
      : 'is already in use — remove any Video Capture Device for it from your OBS scenes';

  return (
    `${wanted} ${problem}.` +
    (names ? ` Cameras on this machine: ${names}. Pick one with ?camera=NAME.` : '')
  );
}

/* ------------------------------------------------- the setup-only picker */

/**
 * Lists the machine's cameras so you can swap without editing a URL. Setup view
 * only: a dropdown baked into the browser source would be on stream, and the
 * source has no one sitting in front of it to use it anyway.
 *
 * The choice goes to the server, which is the only thing the setup view (in
 * Chrome) and the browser source (in OBS) both see — they are separate browsers
 * with separate storage.
 */
async function buildPicker() {
  const { listCameras } = await import('./pose-tracker.js');
  const cameras = await listCameras();

  selectEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default (whatever the browser picks)';
  selectEl.appendChild(auto);

  for (const device of cameras) {
    const option = document.createElement('option');
    // Match by label, not deviceId: ids are rotated per browser profile, so an
    // id chosen here would mean nothing to the OBS source.
    option.value = device.label;
    option.textContent = device.label || '(unnamed camera)';
    selectEl.appendChild(option);
  }

  const current = cameras.find((d) => matches(d.label, activeCamera));
  selectEl.value = current ? current.label : '';

  selectEl.addEventListener('change', async () => {
    const chosen = selectEl.value || null;
    pickerNote.textContent = 'Switching…';
    await switchCamera(chosen);
    try {
      await fetch('/api/camera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera: chosen }),
      });
      pickerNote.textContent = chosen
        ? 'Saved. The OBS source will switch to this too.'
        : 'Saved. The OBS source will use the default camera.';
    } catch {
      pickerNote.textContent = 'Switched here, but the server did not save it.';
    }
  });

  pickerNote.textContent = options.camera
    ? `This page was opened with ?camera=${options.camera}, which overrides the saved choice.`
    : 'Whatever you pick here is what the OBS source will use.';
  pickerEl.hidden = false;
}

function matches(label, wanted) {
  if (!label || !wanted) return false;
  return label.toLowerCase().includes(wanted.trim().toLowerCase());
}

// OBS reloads a browser source when the scene comes back; release the camera on
// the way out so the next load isn't fighting a stream that never stopped.
window.addEventListener('pagehide', () => {
  tracker?.stop();
  client.stop();
});

async function boot() {
  // Paint immediately rather than showing a dash until the first event, and
  // learn the saved camera before opening one — starting on the default and
  // swapping a moment later would drop and re-acquire the device for nothing.
  try {
    const state = await (await fetch('/api/state')).json();
    serverState = state;
    render();
    if (!options.camera && state.camera) activeCamera = state.camera;
  } catch {
    /* the SSE connection below will fill this in */
  }

  // The tile is the point of this layout, so open the camera whenever it is
  // shown — even with counting off, a display-only duplicate still wants the
  // picture. Only `video=0` with counting off skips it entirely.
  if (options.video || options.count) {
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      setStatus('camera', await describeCameraFailure(err));
    }
    // Labels only exist once permission has been granted, so the picker is
    // built after the first camera attempt, failed or not.
    if (options.setup) await buildPicker().catch((err) => console.error(err));
  }

  client.connect();
}

boot();
