/**
 * Camera page: watch the webcam, count push-ups, tell the server about them.
 *
 * The server owns the running total, so the OBS overlay ticks down on its own as
 * reps land. Detection thresholds are per-machine tuning and stay in
 * localStorage here.
 */

import { RepCounter, DEFAULT_OPTIONS, STATE } from './rep-counter.js';
import { anglesFromLandmarks } from './pose-math.js';
import { CounterClient } from './counter-client.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

const el = {
  video: $('video'),
  canvas: $('overlay'),
  remaining: $('remaining'),
  remainingLabel: $('remaining-label'),
  subs: $('subs'),
  done: $('done'),
  sessionReps: $('session-reps'),
  pending: $('pending'),
  banner: $('banner'),
  angle: $('angle'),
  angleBar: $('angle-bar'),
  depth: $('depth'),
  phase: $('phase'),
  status: $('status'),
  feedback: $('feedback'),
  toggleCamera: $('toggle-camera'),
  correct: $('correct'),
  undo: $('undo'),
  resetSession: $('reset-session'),
  sound: $('sound'),
  voice: $('voice'),
  sliders: {
    downAngle: $('opt-down'),
    upAngle: $('opt-up'),
    minPlankAngle: $('opt-plank'),
    smoothing: $('opt-smoothing'),
    minRepMs: $('opt-minrep'),
  },
  sliderOuts: {
    downAngle: $('opt-down-out'),
    upAngle: $('opt-up-out'),
    minPlankAngle: $('opt-plank-out'),
    smoothing: $('opt-smoothing-out'),
    minRepMs: $('opt-minrep-out'),
  },
  requirePlank: $('opt-require-plank'),
};

const SETTINGS_KEY = 'pushup-counter/detection-settings/v1';
const token = new URLSearchParams(location.search).get('token');

const counter = new RepCounter(loadSettings());
let sessionReps = 0;
let serverState = null;
let pendingReps = 0;

// Distinguishes this page from an OBS tracker source that is also counting.
const clientId = `camera-${Math.random().toString(36).slice(2, 10)}`;

const client = new CounterClient({
  token,
  clientId,
  onState: (state) => {
    serverState = state;
    render();
    if (state.countingClientId && state.countingClientId !== clientId) {
      showBanner(
        'The OBS tracker source is also counting reps — every push-up will be counted twice. ' +
          'Close one of them, or open the tracker with count=0.',
      );
    }
  },
  onError: showBanner,
  onPending: (count) => {
    pendingReps = count;
    render();
  },
});

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSettings() {
  const { downAngle, upAngle, minPlankAngle, smoothing, minRepMs, requirePlank } = counter.options;
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ downAngle, upAngle, minPlankAngle, smoothing, minRepMs, requirePlank }),
    );
  } catch {
    /* private browsing — settings just won't persist */
  }
}

function syncSliderUI() {
  const o = counter.options;
  el.sliders.downAngle.value = o.downAngle;
  el.sliders.upAngle.value = o.upAngle;
  el.sliders.minPlankAngle.value = o.minPlankAngle;
  el.sliders.smoothing.value = o.smoothing;
  el.sliders.minRepMs.value = o.minRepMs;
  el.requirePlank.checked = o.requirePlank;
  el.sliderOuts.downAngle.textContent = `${o.downAngle}°`;
  el.sliderOuts.upAngle.textContent = `${o.upAngle}°`;
  el.sliderOuts.minPlankAngle.textContent = `${o.minPlankAngle}°`;
  el.sliderOuts.smoothing.textContent = Number(o.smoothing).toFixed(2);
  el.sliderOuts.minRepMs.textContent = `${o.minRepMs} ms`;
}

/* ------------------------------------------------------------------ output */

// One shared AudioContext: browsers cap how many can exist at once, so creating
// one per rep would go silent partway through a long set.
let audioCtx = null;

function beep() {
  if (!el.sound.checked) return;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch {
    /* audio unavailable — counting still works */
  }
}

function speak(text) {
  if (!el.voice.checked || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.25;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function showBanner(message) {
  el.banner.textContent = message ?? '';
  el.banner.hidden = !message;
}

/**
 * Reps in flight are already counted locally but not yet in the server's total,
 * so subtract them to keep the big number honest and instant.
 */
function remainingNow() {
  if (!serverState) return null;
  const raw = serverState.rawRemaining ?? serverState.remaining ?? 0;
  return raw - pendingReps;
}

function render() {
  const remaining = remainingNow();
  el.remaining.textContent = remaining === null ? '—' : fmt(Math.abs(Math.max(-1e12, remaining)));
  el.remaining.classList.toggle('is-clear', remaining !== null && remaining <= 0);
  el.remainingLabel.textContent =
    remaining === null
      ? 'waiting for server'
      : remaining > 0
        ? 'push-ups left'
        : remaining === 0
          ? 'all square'
          : 'push-ups banked';

  el.subs.textContent = serverState?.hiddenSubscriberCount ? 'hidden' : fmt(serverState?.subs);
  el.done.textContent = fmt((serverState?.done ?? 0) + pendingReps);
  el.sessionReps.textContent = fmt(sessionReps);

  el.pending.hidden = pendingReps === 0;
  el.pending.textContent = `${fmt(pendingReps)} rep${pendingReps === 1 ? '' : 's'} not yet saved`;

  if (serverState?.error) showBanner(serverState.error);
}

const PHASE_LABEL = {
  [STATE.NO_POSE]: 'no pose',
  [STATE.UNKNOWN]: 'get set',
  [STATE.UP]: 'top',
  [STATE.DOWN]: 'bottom',
};

function renderFrame(result) {
  el.phase.textContent = PHASE_LABEL[result.state] ?? result.state;
  el.phase.dataset.state = result.state;
  el.feedback.textContent = result.feedback;

  if (result.angle === null) {
    el.angle.textContent = '—';
    el.angleBar.style.setProperty('--fill', '0%');
  } else {
    el.angle.textContent = `${Math.round(result.angle)}°`;
    const { downAngle, upAngle } = counter.options;
    const pct = ((result.angle - downAngle) / (upAngle - downAngle)) * 100;
    el.angleBar.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
  }

  el.depth.textContent = result.lastRepDepth === null ? '—' : `${Math.round(result.lastRepDepth)}°`;
}

/* ------------------------------------------------------------------ camera */

/**
 * The pose tracker pulls in a large WASM runtime and a model file, so it is
 * imported on first use. If those assets can't load, everything else on the
 * page still works.
 */
let tracker = null;
async function getTracker() {
  if (tracker) return tracker;
  const { PoseTracker } = await import('./pose-tracker.js');
  tracker = new PoseTracker({
    video: el.video,
    canvas: el.canvas,
    onPose: handlePose,
    onStatus: (msg) => {
      el.status.textContent = msg;
    },
  });
  return tracker;
}

function handlePose({ landmarks, worldLandmarks, timestamp }) {
  const { elbowAngle, plankAngle } = anglesFromLandmarks(
    landmarks,
    worldLandmarks,
    counter.options.minVisibility,
  );
  const result = counter.update({ elbowAngle, plankAngle, timestamp });

  if (result.repCompleted) {
    sessionReps += 1;
    client.reportReps(1);
    tracker?.flash();
    beep();

    const left = remainingNow();
    if (left !== null) {
      speak(left > 0 ? String(left) : left === 0 ? 'All paid off' : `${Math.abs(left)} ahead`);
    }

    document.body.classList.add('rep-flash');
    setTimeout(() => document.body.classList.remove('rep-flash'), 200);
  }

  renderFrame(result);
}

/** Turn a start-up exception into something actionable. */
function describeStartFailure(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow it in your browser’s site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No webcam found. Plug one in, or log sets from the control page.';
    case 'NotReadableError':
      return 'The webcam is in use by another app (OBS may have it). Close it and try again.';
    default:
      break;
  }
  if (!window.isSecureContext) {
    return 'Cameras need a secure origin. Open this page as http://127.0.0.1:4747/camera.html on the machine itself, not over your LAN IP.';
  }
  return `Could not start tracking (${err?.message ?? 'unknown error'}). The pose model may have failed to download — run “npm run fetch-assets” to vendor it locally.`;
}

/* ----------------------------------------------------------------- wiring */

el.toggleCamera.addEventListener('click', async () => {
  if (tracker?.running) {
    tracker.stop();
    el.toggleCamera.textContent = 'Start camera';
    el.toggleCamera.classList.remove('is-live');
    return;
  }
  el.toggleCamera.disabled = true;
  showBanner('');
  try {
    const active = await getTracker();
    await active.start();
    el.toggleCamera.textContent = 'Stop camera';
    el.toggleCamera.classList.add('is-live');
    el.feedback.textContent = 'Get into a push-up position with your whole body in frame.';
  } catch (err) {
    console.error(err);
    el.status.textContent = 'Tracking unavailable';
    el.feedback.textContent = '';
    showBanner(describeStartFailure(err));
  } finally {
    el.toggleCamera.disabled = false;
  }
});

// Take back a rep the camera counted that you didn't actually do.
el.correct.addEventListener('click', () => {
  sessionReps = Math.max(0, sessionReps - 1);
  client.reportReps(-1);
});

el.undo.addEventListener('click', async () => {
  const res = await fetch('/api/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showBanner(data.error ?? `Undo failed (${res.status})`);
  serverState = data;
  render();
});

el.resetSession.addEventListener('click', () => {
  sessionReps = 0;
  counter.reset();
  render();
});

for (const [key, input] of Object.entries(el.sliders)) {
  input.addEventListener('input', () => {
    const value = key === 'smoothing' ? Number(input.value) : Math.round(Number(input.value));
    counter.configure({ [key]: value });
    syncSliderUI();
    saveSettings();
  });
}

el.requirePlank.addEventListener('change', () => {
  counter.configure({ requirePlank: el.requirePlank.checked });
  saveSettings();
});

// Space bar logs a rep by hand, for when the camera misses one.
//
// preventDefault is unconditional on purpose: a focused button treats space as a
// click, so without it, space after using any control would re-fire that control
// instead of logging a rep. Buttons still work with Enter.
const isTextEntry = (target) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || isTextEntry(e.target)) return;
  e.preventDefault();
  sessionReps += 1;
  client.reportReps(1);
  beep();
});

document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || isTextEntry(e.target)) return;
  e.preventDefault();
});

// Don't quietly lose reps if the tab is closed mid-flush.
window.addEventListener('beforeunload', (e) => {
  if (client.pending === 0) return;
  e.preventDefault();
  e.returnValue = '';
});

counter.configure({ ...DEFAULT_OPTIONS, ...loadSettings() });
syncSliderUI();
render();
client.connect();
