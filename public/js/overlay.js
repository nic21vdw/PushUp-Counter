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
import { RepSound, SOUND_NAMES } from './rep-sound.js';
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
const optionsEl = document.getElementById('options');
const optionsOpen = document.getElementById('options-open');
const optionsClose = document.getElementById('options-close');
const optCamera = document.getElementById('opt-camera');
const optSound = document.getElementById('opt-sound');
const optVolume = document.getElementById('opt-volume');
const optVolumeValue = document.getElementById('opt-volume-value');
const optionsNote = document.getElementById('options-note');
const optSaved = document.getElementById('opt-saved');

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
// true. Nothing is painted outside `?setup`: this source is on stream, and a
// banner across the scene tells the audience about a problem only you can fix.
const statuses = new StatusSlots(['camera', 'server']);

function setStatus(slot, message, tone = 'error') {
  const winner = statuses.set(slot, message, tone);

  // The fault is recorded either way — `setup` decides who is shown it, not
  // whether a dead camera goes unnoticed. This is the log you open when the
  // tile is blank and the source is saying nothing about why.
  if (message && tone === 'error') console.error(`[${slot}] ${message}`);

  const show = winner && options.setup;
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
    followServerSound(state);
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
  const rawLeft = (serverState.rawLeft ?? serverState.left ?? 0) - pendingReps;
  const left = Math.max(0, rawLeft);
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

    // Push-ups left bottoms out at zero, so once you are ahead the big number
    // stops moving and every rep after that looks like nothing happened. The
    // done figure always moves, and the credit says how far past the line you
    // are — which is the part the zero was hiding.
    const ahead = Math.max(0, -rawLeft);
    progressText.textContent =
      `${format(done)} done · ${format(owed)} owed` + (ahead ? ` · ${format(ahead)} ahead` : '');
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

/* ----------------------------------------------------------------- sound */

// Doing a push-up puts your face at the floor, so the flash above is confirmation
// you are not in a position to see. Only the source that actually banks the rep
// chirps: a display-only duplicate is watching the same body, and two of them
// would answer every push-up twice.
const repSound = new RepSound({
  preset: options.count ? options.sound : null,
  volume: options.volume,
});

// OBS runs browser sources with autoplay allowed, so the chirp is live from the
// first rep there. A browser has to be touched first, and the tracker is a page
// you leave running — so the first click or key anywhere on it opens the device.
if (repSound.enabled) {
  const arm = () => repSound.arm();
  for (const event of ['pointerdown', 'keydown']) {
    window.addEventListener(event, arm, { once: true, passive: true });
  }
  repSound.arm();
}

/* --------------------------------------------------------------- options */

// The camera and the sound are chosen here and saved on the server, which is
// the only thing this window and the OBS source both see — they are separate
// browsers with separate storage. A `?sound=` in the URL is an explicit
// instruction and still wins, the same way `?camera=` does.
const soundFromUrl = params.has('sound');
const volumeFromUrl = params.has('volume');

function followServerSound(state) {
  if (!soundFromUrl && state.sound !== undefined && state.sound !== null) {
    repSound.setPreset(options.count ? state.sound : null);
  }
  if (!volumeFromUrl && typeof state.volume === 'number') {
    repSound.setVolume(state.volume);
    if (optVolume) syncVolumeInput(state.volume);
  }
}

function syncVolumeInput(volume) {
  optVolume.value = String(Math.round(volume * 100));
  optVolumeValue.textContent = `${Math.round(volume * 100)}%`;
}

async function savePrefs(patch, message) {
  try {
    const res = await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(String(res.status));
    optSaved.textContent = message;
  } catch {
    // Saying "saved" when it was not is worse than saying nothing: the setting
    // would come back next launch and look like the panel had lied.
    optSaved.textContent = 'Not saved — server did not answer';
  }
  setTimeout(() => {
    optSaved.textContent = '';
  }, 2600);
}

async function buildOptions() {
  for (const name of SOUND_NAMES) {
    optSound.append(new Option(name, name));
  }
  optSound.append(new Option('none', 'off'));
  optSound.value = options.sound ?? 'off';

  syncVolumeInput(options.volume);

  optSound.addEventListener('change', () => {
    const chosen = optSound.value === 'off' ? null : optSound.value;
    repSound.setPreset(options.count ? chosen : null);
    // A sound you cannot hear is indistinguishable from one that failed, and
    // this is the moment you are listening for it.
    repSound.play();
    savePrefs({ sound: chosen }, 'Saved');
  });

  optVolume.addEventListener('input', () => {
    const volume = Number(optVolume.value) / 100;
    syncVolumeInput(volume);
    repSound.setVolume(volume);
  });
  optVolume.addEventListener('change', () => {
    repSound.play();
    savePrefs({ volume: Number(optVolume.value) / 100 }, 'Saved');
  });

  optCamera.addEventListener('change', async () => {
    const chosen = optCamera.value || null;
    optSaved.textContent = 'Switching…';
    await switchCamera(chosen);
    savePrefs({ camera: chosen }, 'Saved');
  });

  optionsNote.textContent = options.camera
    ? `Opened with ?camera=${options.camera}, which overrides the saved camera.`
    : 'These are saved on the server, so the OBS source picks them up too.';

  await refreshCameraList();
}

/**
 * Camera labels only exist once permission has been granted, so this is called
 * again after the camera has actually been opened.
 */
async function refreshCameraList() {
  let cameras = [];
  try {
    const { listCameras } = await import('./pose-tracker.js');
    cameras = await listCameras();
  } catch {
    /* leave the list with just the default entry */
  }

  optCamera.replaceChildren();
  optCamera.append(new Option('Default (whatever the browser picks)', ''));
  for (const device of cameras) {
    // Match by label, not deviceId: ids are rotated per browser profile, so an
    // id chosen here would mean nothing to the OBS source.
    optCamera.append(new Option(device.label || '(unnamed camera)', device.label));
  }

  const current = cameras.find((d) => matches(d.label, activeCamera));
  optCamera.value = current ? current.label : '';
}

// This page is the browser source as well as the window you set it up in, so
// the controls appear only for something with a pointer. OBS has none, and
// never will, so nothing here can reach the stream.
let hideControls;
function showControls() {
  document.body.dataset.pointer = '1';
  clearTimeout(hideControls);
  hideControls = setTimeout(() => {
    if (optionsEl.hidden) document.body.dataset.pointer = '0';
  }, 2600);
}

window.addEventListener('pointermove', showControls, { passive: true });
optionsOpen.addEventListener('click', () => {
  optionsEl.hidden = false;
  optionsOpen.hidden = true;
  refreshCameraList();
});
optionsClose.addEventListener('click', () => {
  optionsEl.hidden = true;
  optionsOpen.hidden = false;
  showControls();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !optionsEl.hidden) optionsClose.click();
});

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
    //
    // The sample rate is here because it is the first thing to look at when fast
    // reps go missing: below about 25/s a half-second rep is only a handful of
    // samples wide, and no threshold will save it. The last rep's range is the
    // second thing — it says whether you are actually reaching `down` and `up`.
    const deg = (value) => (value === null ? '—' : `${Math.round(value)}°`);
    tuneEl.hidden = false;
    tuneEl.innerHTML =
      `<b>${detectedThisSession}</b> rep${detectedThisSession === 1 ? '' : 's'} detected · ` +
      `elbow <b>${deg(result.angle)}</b> · ` +
      `plank <b>${deg(result.plankAngle)}</b> · ` +
      `last <b>${deg(result.lastRepDepth)}→${deg(result.lastRepTop)}</b> · ` +
      `<b>${Math.round(tracker?.sampleRate ?? 0)}</b>/s · ` +
      `<b>${result.state}</b> · ` +
      `sound <b>${repSound.preset ?? 'off'}/${repSound.status}` +
      `${repSound.latencyMs === null ? '' : ` ${repSound.latencyMs}ms`}</b> · ${result.feedback}`;
  }

  if (result.repCompleted) {
    detectedThisSession += 1;
    // Sound first. The two flashes below touch the DOM and force a style
    // recalculation, and every millisecond of that would sit between the rep
    // and the noise — which is the one piece of feedback being timed by ear.
    repSound.play();
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

function matches(label, wanted) {
  if (!label || !wanted) return false;
  return label.toLowerCase().includes(wanted.trim().toLowerCase());
}

// OBS reloads a browser source when the scene comes back; release the camera on
// the way out so the next load isn't fighting a stream that never stopped.
window.addEventListener('pagehide', () => {
  tracker?.stop();
  client.stop();
  repSound.stop();
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
    // Camera labels only exist once permission has been granted, so the list
    // in the options panel is filled in after the first attempt, failed or not.
    await refreshCameraList().catch((err) => console.error(err));
  }

  await buildOptions().catch((err) => console.error(err));

  client.connect();
}

boot();
