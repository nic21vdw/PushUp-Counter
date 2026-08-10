import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, 'state.json');
// The count is the one thing here that cannot be recreated: push-ups already
// done are gone if the number goes. So the last-known-good file is kept beside
// it, every change is appended to a journal, and a file that will not parse is
// put aside rather than overwritten.
const BACKUP_FILE = `${STATE_FILE}.bak`;
const HISTORY_FILE = path.join(ROOT, 'state-history.jsonl');
const TOKEN_FILE = path.join(ROOT, '.admin-token');

// ---------------------------------------------------------------------------
// Config (.env file + real environment variables; env wins)
// ---------------------------------------------------------------------------

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadDotEnv();
const env = (key, fallback = '') => process.env[key] ?? fileEnv[key] ?? fallback;

const CONFIG = {
  apiKey: env('YOUTUBE_API_KEY'),
  channelId: env('YOUTUBE_CHANNEL_ID'),
  handle: env('YOUTUBE_HANDLE'),
  // Without both halves there is nothing to ask YouTube, so don't ask. Counting
  // push-ups works on its own; a setup that is deliberately key-less should not
  // spend the whole stream showing an error about a key it never wanted.
  get subsEnabled() {
    return Boolean(this.apiKey && (this.channelId || this.handle));
  },
  port: Number(env('PORT', '4747')),
  host: env('HOST', '127.0.0.1'),
  pollSeconds: Math.max(15, Number(env('POLL_SECONDS', '30'))),
  // One subscriber, one push-up. Configurable because the arithmetic stops
  // being survivable somewhere north of a few hundred subs a stream, but it is
  // a number you set once in .env — not something a page can move.
  perSub: (() => {
    const value = Number(env('PUSHUPS_PER_SUB', '1'));
    return Number.isFinite(value) && value > 0 ? value : 1;
  })(),
  // Restarting after this long counts as a new stream. Short gaps (a crash, a
  // reboot, closing the laptop between scenes) resume the session in progress.
  // "off" never starts one automatically; "0" always does.
  newStreamAfterHours: (() => {
    const raw = env('NEW_STREAM_AFTER_HOURS', '6').toLowerCase();
    if (raw === 'off' || raw === 'never') return Infinity;
    const hours = Number(raw);
    return Number.isFinite(hours) && hours >= 0 ? hours : 6;
  })(),
};

// ---------------------------------------------------------------------------
// State
//
// Two numbers move it, and nothing else can:
//   a subscriber arrives while you are live  ->  you owe one more
//   the camera sees a push-up                ->  you owe one less
//
// There is deliberately no endpoint that sets `done` or the amount owed. The
// whole point is that the number is earned, so the only writer is the pose
// detector reporting a rep it actually saw.
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  // Push-ups still owed from previous streams. Only ever written by the
  // start-of-stream rollover, so a debt survives but cannot be edited away.
  carriedOver: 0,
  // Subscriber count this stream is measured from.
  baselineSubs: null,
  // Push-ups the camera has counted this stream.
  done: 0,
  // Last successful reading from the YouTube API.
  subs: null,
  subsUpdatedAt: null,
  hiddenSubscriberCount: false,
  channelTitle: '',
  // When the current stream session began, and when the server last ran. The
  // gap between the two is how we tell "crashed mid-stream" from "next stream".
  streamStartedAt: null,
  lastSeenAt: null,
  // When the camera last banked a rep — the status page uses it to say whether
  // anything is actually counting.
  lastRepAt: null,
  // Which webcam to watch, by name. Lives here rather than in the browser
  // because the setup view and the OBS source are two different browsers with
  // separate storage — the server is the only thing they both see.
  camera: null,
  // Whether that camera is a choice someone made in the panel, or just the
  // untouched default. A choice outranks the `?camera=` in an OBS source URL;
  // an untouched default does not, or a source pinned to a name could never be
  // changed from the panel it is meant to be changed from.
  cameraChosen: false,
  // Which sound a counted rep makes, and how loud, chosen in the tracker's
  // options panel. Here for the same reason the camera is: the panel you use
  // and the OBS source are two different browsers, and this is what they share.
  // Null means "whatever the page defaults to" rather than a choice.
  sound: null,
  volume: null,
};

let state = { ...DEFAULT_STATE };
let lastError = null;
/**
 * Something about the count itself is not to be trusted — it came from a
 * backup, or from nothing at all. Separate from `lastError`, which is the
 * YouTube connection and is cleared by every successful poll: a doubt about the
 * count has to outlive thirty seconds of everything else going fine, and only a
 * person looking at the number can settle it.
 */
let warning = null;
let saveQueue = Promise.resolve();

function loadState() {
  for (const file of [STATE_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      // The byte-order mark is stripped because Windows puts one on any file
      // saved by Notepad or PowerShell, and hand-editing this file is exactly
      // what someone does when the count has gone wrong. Refusing to read it
      // afterwards would turn a repair into a second outage.
      const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      state = { ...DEFAULT_STATE, ...JSON.parse(text) };
      if (file === BACKUP_FILE) {
        console.error('[state] state.json was unreadable — the count came from the backup.');
        // A restored count can be a poll behind, so it is flagged until someone
        // confirms it. Not in `lastError`: that is the YouTube line, and the
        // next successful poll clears it — which would take this with it.
        warning = 'The count was restored from a backup — check it before you count on it.';
      }
      return;
    } catch (err) {
      console.error(`[state] could not read ${path.basename(file)}: ${err.message}`);
    }
  }

  // Nothing readable. Move whatever is there aside instead of letting the first
  // save write zeroes over it: an unparseable file is still the only record of
  // the count, and a person can pick a number out of it by eye.
  if (fs.existsSync(STATE_FILE)) {
    const kept = `${STATE_FILE}.broken`;
    try {
      fs.renameSync(STATE_FILE, kept);
      console.error(`[state] kept the unreadable file as ${path.basename(kept)}`);
    } catch (err) {
      console.error(`[state] could not set the unreadable file aside: ${err.message}`);
    }
    warning = 'The saved count could not be read. The counter started from zero.';
  }
}

/**
 * @param {string|null} reason What moved the count, for the journal. Null for
 *   the routine saves that only restamp `lastSeenAt`.
 */
function saveState(reason = null) {
  const snapshot = JSON.stringify(state, null, 2);
  saveQueue = saveQueue
    // Yesterday's file, kept one save behind. Written before the new one lands,
    // so a crash in the middle of a save leaves a readable count either way.
    .then(() => fsp.copyFile(STATE_FILE, BACKUP_FILE).catch(() => {}))
    .then(() => writeDurably(`${STATE_FILE}.tmp`, snapshot))
    .then(() => fsp.rename(`${STATE_FILE}.tmp`, STATE_FILE))
    .then(() => appendHistory(reason))
    .catch((err) => console.error(`[state] save failed: ${err.message}`));
  return saveQueue;
}

/**
 * Write, and make sure it is really on the disk before anything renames it.
 *
 * A plain write followed by a rename looks atomic and is not: the rename can
 * reach the disk while the bytes are still in the cache, so a machine that
 * loses power leaves a state.json that exists, has the right name, and is
 * empty. This machine hard-crashes often enough for that to be the likely way
 * a count disappears.
 */
async function writeDurably(file, contents) {
  const handle = await fsp.open(file, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Append the count to the journal whenever it moves.
 *
 * A counter that resets is unanswerable without this: "it was 40 a minute ago"
 * and "it has been 0 all night" look identical in a file that only holds the
 * present. One line per change, so a stream is a few kilobytes.
 */
let lastJournalled = null;
async function appendHistory(reason) {
  const now = view();
  const entry = {
    at: new Date().toISOString(),
    reason,
    left: now.left,
    owed: now.owed,
    done: now.done,
    carriedOver: state.carriedOver,
    subs: state.subs,
    baselineSubs: state.baselineSubs,
    streamStartedAt: state.streamStartedAt,
  };

  const fingerprint = JSON.stringify([
    entry.left,
    entry.owed,
    entry.done,
    entry.carriedOver,
    entry.subs,
    entry.baselineSubs,
    entry.streamStartedAt,
  ]);
  if (fingerprint === lastJournalled && !reason) return;
  lastJournalled = fingerprint;

  await fsp
    .appendFile(HISTORY_FILE, `${JSON.stringify(entry)}\n`)
    .catch((err) => console.error(`[state] could not write the journal: ${err.message}`));
}

/**
 * The secret that lets a person at this machine repair the count.
 *
 * It is a file rather than a password because of what it has to keep out: an
 * overlay page. A page can reach every endpoint on this server, and the rule
 * that only push-ups move the number is worth keeping — so the one endpoint
 * that can set it asks for something no page can read.
 */
let token = null;
function adminToken() {
  if (token) return token;
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    /* not made yet */
  }
  if (!token) {
    token = crypto.randomUUID();
    try {
      fs.writeFileSync(TOKEN_FILE, `${token}\n`);
    } catch (err) {
      console.error(`[state] could not save the admin token: ${err.message}`);
    }
  }
  return token;
}

/**
 * Which camera page last reported a rep, and when. Only one page should be
 * counting; if two are, every push-up lands twice. The most recent counter is
 * broadcast so the other page can say so, and the status page can tell you
 * whether anything is counting at all.
 */
let activeCamera = null;
const CAMERA_ACTIVE_MS = 30_000;

function activeCameraView() {
  if (!activeCamera) return null;
  if (Date.now() - activeCamera.at > CAMERA_ACTIVE_MS) return null;
  return activeCamera.id;
}

/** Bank push-ups the camera actually saw. The only way `done` ever moves. */
function recordReps(reps, clientId = null) {
  state.done += reps;
  state.lastRepAt = new Date().toISOString();
  if (clientId) activeCamera = { id: clientId, at: Date.now() };
}

/**
 * Begin a fresh stream session.
 *
 * Only subscribers gained from this moment on add push-ups. Whatever you still
 * owed at the end of the last stream carries over, so the number on screen
 * never jumps — it just stops counting yesterday's growth.
 *
 * `closingSubs` is the count the *previous* stream ended on, which is not the
 * same as `subs` when the server was off overnight. Settling up against the
 * live count instead would bill you for every subscriber gained while you were
 * asleep — the exact thing per-stream tracking exists to avoid.
 */
function startNewStream(subs, closingSubs = subs) {
  const gained =
    closingSubs !== null && state.baselineSubs !== null ? closingSubs - state.baselineSubs : 0;
  const stillOwed = Math.max(0, state.carriedOver + gained * CONFIG.perSub - state.done);

  state.carriedOver = stillOwed;
  state.done = 0;
  state.baselineSubs = subs ?? state.subs;
  state.streamStartedAt = new Date().toISOString();
  return stillOwed;
}

/**
 * Put the number on screen back to what it should be.
 *
 * Written as "make the total owed come out at this", not "add this many", so
 * the number you type is the number you see. Push-ups already done this stream
 * stay done — they are a record of what happened, and a repair to the owed side
 * is not a reason to un-count them.
 */
function setLeft(left) {
  const subsGained =
    state.subs !== null && state.baselineSubs !== null ? state.subs - state.baselineSubs : 0;
  state.carriedOver = left + state.done - subsGained * CONFIG.perSub;
  return view().left;
}

// ---------------------------------------------------------------------------
// The maths
// ---------------------------------------------------------------------------

function view() {
  const subs = state.subs;
  const baseline = state.baselineSubs;
  const subsGained = subs !== null && baseline !== null ? subs - baseline : 0;
  const fromSubs = subsGained * CONFIG.perSub;
  // Losing subscribers mid-stream makes `subsGained` negative, which used to
  // drag the total owed below zero and put "3 / -11" on screen. You cannot owe
  // a negative number of push-ups; the floor is nothing owed.
  const owed = Math.max(0, state.carriedOver + fromSubs);
  const rawLeft = owed - state.done;

  return {
    // What the overlay shows. Never negative: getting ahead banks nothing.
    left: Math.max(0, rawLeft),
    rawLeft,
    owed,
    done: state.done,
    carriedOver: state.carriedOver,
    perSub: CONFIG.perSub,
    subs,
    baselineSubs: baseline,
    subsGained,
    fromSubs,
    subsUpdatedAt: state.subsUpdatedAt,
    hiddenSubscriberCount: state.hiddenSubscriberCount,
    channelTitle: state.channelTitle,
    streamStartedAt: state.streamStartedAt,
    lastRepAt: state.lastRepAt,
    camera: state.camera,
    cameraChosen: state.cameraChosen,
    sound: state.sound,
    volume: state.volume,
    countingClientId: activeCameraView(),
    pollSeconds: CONFIG.pollSeconds,
    // Whether subscribers are being watched at all. `false` is a mode, not a
    // fault — the pages say "off" rather than showing an error.
    subsEnabled: CONFIG.subsEnabled,
    error: lastError,
    warning,
  };
}

// ---------------------------------------------------------------------------
// YouTube Data API v3
// ---------------------------------------------------------------------------

/**
 * Strip the API key out of anything on its way to a screen.
 *
 * `lastError` is broadcast to every page and rendered on the status page, which
 * on a streaming machine may well be captured. The key travels as a query
 * param, so any error that quotes the request URL would put it on air. Nothing
 * currently does — this is here so nothing ever can.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let safe = String(text);
  if (CONFIG.apiKey) safe = safe.split(CONFIG.apiKey).join('***');
  // Belt and braces: any `key=` in a quoted URL, whatever its value.
  return safe.replace(/([?&]key=)[^&\s'")]+/gi, '$1***');
}

async function fetchSubscriberCount() {
  if (!CONFIG.apiKey) throw new Error('YOUTUBE_API_KEY is not set (see .env.example)');
  if (!CONFIG.channelId && !CONFIG.handle) {
    throw new Error('Set YOUTUBE_CHANNEL_ID or YOUTUBE_HANDLE in .env');
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'statistics,snippet');
  url.searchParams.set('key', CONFIG.apiKey);
  if (CONFIG.channelId) {
    url.searchParams.set('id', CONFIG.channelId);
  } else {
    url.searchParams.set('forHandle', CONFIG.handle.replace(/^@/, ''));
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    const message = body?.error?.message ?? res.statusText;
    throw new Error(`YouTube API ${res.status}${reason ? ` (${reason})` : ''}: ${message}`);
  }

  const channel = body?.items?.[0];
  if (!channel) throw new Error('YouTube API returned no channel — check the ID or handle');

  const stats = channel.statistics ?? {};
  return {
    subs: Number(stats.subscriberCount ?? 0),
    hidden: Boolean(stats.hiddenSubscriberCount),
    title: channel.snippet?.title ?? '',
  };
}

/**
 * True when this process start should begin a new stream rather than pick up
 * where the last one left off. Decided once, on the first successful poll, so
 * that the session always starts from a real subscriber count.
 */
let streamDecisionPending = true;

function shouldStartNewStream() {
  if (state.streamStartedAt === null) return true;
  // A missing baseline only matters when subscribers are actually being
  // counted. Without a key there is no baseline to be missing, and treating
  // that as "start a new stream" would reset the session on every restart.
  if (CONFIG.subsEnabled && state.baselineSubs === null) return true;
  if (CONFIG.newStreamAfterHours === Infinity) return false;
  if (!state.lastSeenAt) return true;
  const hoursDown = (Date.now() - Date.parse(state.lastSeenAt)) / 3_600_000;
  return hoursDown >= CONFIG.newStreamAfterHours;
}

async function poll({ quiet = false } = {}) {
  // Nothing configured: no request, no error, no red banner. The session still
  // has to open, though, or the counter sits there with no stream to belong to.
  if (!CONFIG.subsEnabled) {
    if (streamDecisionPending) {
      streamDecisionPending = false;
      if (shouldStartNewStream()) startNewStream(null, null);
      state.lastSeenAt = new Date().toISOString();
      await saveState();
      broadcast();
    }
    return;
  }

  try {
    const { subs, hidden, title } = await fetchSubscriberCount();
    const previous = state.subs;

    state.subs = subs;
    state.hiddenSubscriberCount = hidden;
    state.channelTitle = title;
    state.subsUpdatedAt = new Date().toISOString();
    lastError = null;

    let reason = null;

    // Only subscribers gained during this stream count toward push-ups.
    if (streamDecisionPending) {
      streamDecisionPending = false;
      if (shouldStartNewStream()) {
        // `previous` is where the last stream left off — see startNewStream.
        const carried = startNewStream(subs, previous);
        reason = `new stream session at ${subs} subs, ${carried} carried over`;
        console.log(
          `[stream] new session at ${subs} subs` +
            (carried ? ` — ${carried} push-ups carried over from last time` : ''),
        );
      } else {
        console.log(
          `[stream] resuming the session from ${new Date(state.streamStartedAt).toLocaleString()}` +
            ` (${view().left} push-ups left)`,
        );
      }
    }

    if (!quiet && previous !== null && previous !== subs) {
      const delta = subs - previous;
      console.log(
        `[youtube] ${previous} -> ${subs} subs (${delta > 0 ? '+' : ''}${delta}) ` +
          `= ${view().left} push-ups left`,
      );
    }

    // The baseline ratchets down, never up.
    //
    // It is captured from one reading, and YouTube's public number is not
    // stable — it lags, caches, and swings by a dozen or more either way. If
    // the baseline gets stamped on a high reading, every later reading is
    // "below baseline" and the next real subscriber adds nothing, because the
    // count has to climb back through the phantom deficit first. Following the
    // count downward keeps the next subscriber worth exactly one push-up.
    if (state.baselineSubs !== null && subs < state.baselineSubs) {
      console.log(`[stream] sub count fell to ${subs}; baseline follows it down`);
      reason ??= `sub count fell to ${subs}; baseline followed it down`;
      state.baselineSubs = subs;
    }

    // Written every poll, not just on a change: this timestamp is what tells a
    // restart whether the stream is still going, so it must not go stale while
    // the sub count happens to sit still.
    state.lastSeenAt = new Date().toISOString();
    await saveState(reason);
    broadcast();
  } catch (err) {
    const raw = err.name === 'TimeoutError' ? 'YouTube API request timed out' : err.message;
    // Redacted before it is stored, not just before it is shown — `lastError`
    // goes out over SSE to every page, including ones that are on stream.
    const message = redactSecrets(raw);
    if (lastError !== message) console.error(`[youtube] ${message}`);
    lastError = message;
    broadcast();
  }
}

// ---------------------------------------------------------------------------
// Server-sent events so the overlay updates without a refresh
// ---------------------------------------------------------------------------

const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(view())}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // The vendored pose runtime ships as .mjs, and browsers refuse to import a
  // module that isn't served as JavaScript.
  '.mjs': 'text/javascript; charset=utf-8',
  // WebAssembly.instantiateStreaming rejects anything but application/wasm.
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  // The rep sounds. `decodeAudioData` will take almost anything, but a wrong
  // Content-Type is one of the ways a file arrives and still will not play.
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// A rep report can carry more than one because the overlay holds reps while the
// server is unreachable and flushes them when it comes back. The ceiling is
// just a sanity bound — nobody banks 50 push-ups inside one network blip.
const MAX_REPS_PER_REPORT = 50;

/** A repaired count is a number someone typed, so it gets a typo-sized bound. */
const MAX_COUNT = 100_000;

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/status.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    // HEAD gets the headers only — the overlay uses it to check whether the
    // pose model has been vendored before deciding to fall back to the CDN.
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // --- read-only -----------------------------------------------------------
  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, view());
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(view())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  // --- the one thing that writes -------------------------------------------
  //
  // Push-ups the camera saw. Whole positive numbers only: there is no way to
  // hand back a rep, and no other endpoint touches the count.
  if (url.pathname === '/api/rep' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const reps = body.reps === undefined ? 1 : Number(body.reps);
    if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS_PER_REPORT) {
      return sendJson(res, 400, {
        error: `reps must be a whole number between 1 and ${MAX_REPS_PER_REPORT}`,
      });
    }

    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null;
    recordReps(reps, clientId);

    await saveState(`${reps} push-up${reps === 1 ? '' : 's'} counted`);
    broadcast();
    return sendJson(res, 200, view());
  }

  // Putting the number back after it has gone wrong.
  //
  // The count is meant to move two ways only — a subscriber adds, a push-up
  // takes away — and that rule is why no page can set it. But a rule with no
  // repair door means a count lost to a bad restart is lost for good, mid
  // stream, with the only remedy being to stop the server and hand-edit a file.
  // So the door exists and is locked with a token from a file on this machine,
  // which a browser page cannot read.
  if (url.pathname === '/api/count' && req.method === 'POST') {
    if ((req.headers['x-pushup-admin'] ?? '') !== adminToken()) {
      return sendJson(res, 403, {
        error: 'the count is set from this machine, with the token in .admin-token',
      });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const left = Number(body.left);
    if (!Number.isInteger(left) || left < 0 || left > MAX_COUNT) {
      return sendJson(res, 400, {
        error: `left must be a whole number between 0 and ${MAX_COUNT}`,
      });
    }

    const before = view().left;
    setLeft(left);
    // Someone has looked at the number and said what it should be, which is the
    // only thing that can answer a doubt about where the count came from.
    warning = null;
    console.log(`[state] count set by hand: ${before} -> ${view().left}`);
    await saveState(`set by hand from ${before} to ${left}`);
    broadcast();
    return sendJson(res, 200, view());
  }

  // The journal, newest last. The question it answers is "what was the count an
  // hour ago, and what moved it" — unanswerable from state.json, which only
  // ever holds the present.
  if (url.pathname === '/api/history' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    let entries = [];
    try {
      entries = fs
        .readFileSync(HISTORY_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line));
    } catch {
      // No journal yet is not a fault: nothing has moved since this landed.
    }
    return sendJson(res, 200, { entries });
  }

  // What is in the sounds folder. The page builds its bank from this rather
  // than from a list in the code, so adding a noise to a rep is a matter of
  // dropping an mp3 in `public/sounds/` — no edit, no restart of anything but
  // the page. Read-only, and it only ever names files that are already served.
  if (url.pathname === '/api/sounds' && req.method === 'GET') {
    let sounds = [];
    try {
      sounds = fs
        .readdirSync(path.join(PUBLIC_DIR, 'sounds'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(mp3|ogg|wav|m4a)$/i.test(entry.name))
        .map((entry) => ({
          name: entry.name.replace(/\.[^.]+$/, '').toLowerCase(),
          src: `/sounds/${encodeURIComponent(entry.name)}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // No folder is not a fault: the synthesised sounds need no files, and the
      // page falls back to them on its own.
    }
    return sendJson(res, 200, { sounds });
  }

  // Preferences, not scores: which camera to watch, which noise a rep makes,
  // how loud. None of them can reach `done`, `carriedOver` or anything else the
  // count is made of, so they stay controls you are allowed to have — and they
  // live here rather than in the browser because the options panel and the OBS
  // source are two different browsers with separate storage.
  //
  // `/api/camera` is the older spelling of the same thing, kept because it is
  // in URLs and notes that predate the panel.
  if ((url.pathname === '/api/prefs' || url.pathname === '/api/camera') && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    // Only what was sent is changed. Absent is "leave it alone", which is not
    // the same as null — null is how you go back to the page's own default.
    if ('camera' in body) {
      if (body.camera !== null && typeof body.camera !== 'string') {
        return sendJson(res, 400, { error: 'camera must be a device name, or null for the default' });
      }
      state.camera = body.camera === null ? null : body.camera.trim().slice(0, 200) || null;
      // Null here is "the default camera, and I mean it" — still a choice, and
      // still the thing every page should follow.
      state.cameraChosen = true;
    }

    if ('sound' in body) {
      if (body.sound !== null && typeof body.sound !== 'string') {
        return sendJson(res, 400, { error: 'sound must be a name, or null for the default' });
      }
      // The server does not know which sounds exist, and should not: the page
      // owns that list and falls back on its own when handed a name it cannot
      // place. All that matters here is that it is a short, plain word.
      state.sound = body.sound === null ? null : body.sound.trim().toLowerCase().slice(0, 32) || null;
    }

    if ('volume' in body) {
      const volume = body.volume === null ? null : Number(body.volume);
      if (volume !== null && (!Number.isFinite(volume) || volume < 0 || volume > 1)) {
        return sendJson(res, 400, { error: 'volume must be between 0 and 1, or null for the default' });
      }
      state.volume = volume;
    }

    await saveState();
    broadcast();
    return sendJson(res, 200, view());
  }

  // `/api/rep` is the only endpoint that writes the count. Anything else under /api/ is
  // gone on purpose — say so plainly rather than letting it fall through to the
  // static handler and come back as a confusing 405.
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
    return;
  }

  return serveStatic(req, res, url);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadState();

server.listen(CONFIG.port, CONFIG.host, async () => {
  const base = `http://${CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host}:${CONFIG.port}`;
  // Made now rather than on first use, so `count.mjs` works the first time it
  // is reached for — which is always a moment when something has gone wrong.
  adminToken();
  console.log('');
  console.log('  Push-up counter is running.');
  console.log(`  OBS source    ${base}/overlay.html      <- add this as a Browser Source`);
  console.log(`  Set it up     ${base}/overlay.html?setup=1   <- pick a camera, check framing`);
  console.log(`  Status        ${base}/status.html`);
  if (CONFIG.subsEnabled) {
    const plural = CONFIG.perSub === 1 ? '' : 's';
    console.log(`  ${CONFIG.perSub} push-up${plural} per subscriber gained while live.`);
  } else {
    // A mode, not a missing key. Plenty of setups never want the YouTube half.
    console.log('  Subscribers: off. The camera counts your push-ups down; nothing adds to them.');
    console.log('  Add YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID to .env to have subscribers add.');
  }
  console.log('');

  await poll();
  // Nothing to poll for when subscribers are off, so don't wake up to do it.
  if (CONFIG.subsEnabled) setInterval(poll, CONFIG.pollSeconds * 1000);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveQueue.finally(() => process.exit(0));
  });
}
