import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, 'state.json');

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
  port: Number(env('PORT', '4747')),
  host: env('HOST', '127.0.0.1'),
  pollSeconds: Math.max(15, Number(env('POLL_SECONDS', '30'))),
  controlToken: env('CONTROL_TOKEN'),
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
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  // Push-ups you owe on top of anything subscribers add (sponsor pledges, dares...).
  pledged: 500,
  // How many push-ups each new subscriber costs you.
  perSub: 1,
  // Subscriber count that "zero subscriber push-ups" is measured from.
  baselineSubs: null,
  // Push-ups you have actually knocked out.
  done: 0,
  // Last successful reading from the YouTube API.
  subs: null,
  subsUpdatedAt: null,
  hiddenSubscriberCount: false,
  channelTitle: '',
  // Recent mutations, newest first, so the control page can undo mistakes.
  history: [],
  // When the current stream session began, and when the server last ran. The
  // gap between the two is how we tell "crashed mid-stream" from "next stream".
  streamStartedAt: null,
  lastSeenAt: null,
};

let state = { ...DEFAULT_STATE };
let lastError = null;
let saveQueue = Promise.resolve();

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...DEFAULT_STATE, ...saved };
  } catch (err) {
    console.error(`[state] could not read ${STATE_FILE}: ${err.message}`);
    console.error('[state] starting from defaults; the old file is left untouched.');
  }
}

function saveState() {
  const snapshot = JSON.stringify(state, null, 2);
  saveQueue = saveQueue
    .then(() => fsp.writeFile(`${STATE_FILE}.tmp`, snapshot))
    .then(() => fsp.rename(`${STATE_FILE}.tmp`, STATE_FILE))
    .catch((err) => console.error(`[state] save failed: ${err.message}`));
  return saveQueue;
}

function pushHistory(entry) {
  state.history.unshift({ ...entry, at: new Date().toISOString() });
  state.history = state.history.slice(0, 25);
}

/**
 * Begin a fresh stream session.
 *
 * Only subscribers gained from this moment on add push-ups. Whatever you still
 * owed at the end of the last stream carries over as the new base, so the
 * number on screen never jumps — it just stops counting yesterday's growth.
 *
 * `closingSubs` is the count the *previous* stream ended on, which is not the
 * same as `subs` when the server was off overnight. Settling up against the
 * live count instead would bill you for every subscriber gained while you were
 * asleep — the exact thing per-stream tracking exists to avoid.
 */
function startNewStream(subs, closingSubs = subs) {
  const gained =
    closingSubs !== null && state.baselineSubs !== null ? closingSubs - state.baselineSubs : 0;
  const carriedOver = Math.max(0, state.pledged + gained * state.perSub - state.done);

  state.pledged = carriedOver;
  state.done = 0;
  state.baselineSubs = subs ?? state.subs;
  state.streamStartedAt = new Date().toISOString();
  state.history = [];
  return carriedOver;
}

// ---------------------------------------------------------------------------
// The maths
// ---------------------------------------------------------------------------

function view() {
  const subs = state.subs;
  const baseline = state.baselineSubs;
  const gained = subs !== null && baseline !== null ? subs - baseline : 0;
  const fromSubs = gained * state.perSub;
  const total = state.pledged + fromSubs;
  const rawRemaining = total - state.done;

  return {
    remaining: Math.max(0, rawRemaining),
    rawRemaining,
    total,
    done: state.done,
    pledged: state.pledged,
    perSub: state.perSub,
    subs,
    baselineSubs: baseline,
    subsGained: gained,
    fromSubs,
    subsUpdatedAt: state.subsUpdatedAt,
    hiddenSubscriberCount: state.hiddenSubscriberCount,
    channelTitle: state.channelTitle,
    history: state.history,
    streamStartedAt: state.streamStartedAt,
    pollSeconds: CONFIG.pollSeconds,
    configured: Boolean(CONFIG.apiKey && (CONFIG.channelId || CONFIG.handle)),
    error: lastError,
  };
}

// ---------------------------------------------------------------------------
// YouTube Data API v3
// ---------------------------------------------------------------------------

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
  if (state.streamStartedAt === null || state.baselineSubs === null) return true;
  if (CONFIG.newStreamAfterHours === Infinity) return false;
  if (!state.lastSeenAt) return true;
  const hoursDown = (Date.now() - Date.parse(state.lastSeenAt)) / 3_600_000;
  return hoursDown >= CONFIG.newStreamAfterHours;
}

async function poll({ quiet = false } = {}) {
  try {
    const { subs, hidden, title } = await fetchSubscriberCount();
    const previous = state.subs;

    state.subs = subs;
    state.hiddenSubscriberCount = hidden;
    state.channelTitle = title;
    state.subsUpdatedAt = new Date().toISOString();
    lastError = null;

    // Only subscribers gained during this stream count toward push-ups.
    let opened = false;
    if (streamDecisionPending) {
      streamDecisionPending = false;
      if (shouldStartNewStream()) {
        // `previous` is where the last stream left off — see startNewStream.
        const carried = startNewStream(subs, previous);
        opened = true;
        console.log(
          `[stream] new session at ${subs} subs` +
            (carried ? ` — ${carried} push-ups carried over from last time` : ''),
        );
      } else {
        console.log(
          `[stream] resuming the session from ${new Date(state.streamStartedAt).toLocaleString()}` +
            ` (${view().remaining} push-ups left)`,
        );
      }
    }

    if (!quiet && previous !== null && previous !== subs) {
      const delta = subs - previous;
      console.log(
        `[youtube] ${previous} -> ${subs} subs (${delta > 0 ? '+' : ''}${delta}) ` +
          `= ${view().remaining} push-ups left`,
      );
    }

    // Written every poll, not just on a change: this timestamp is what tells a
    // restart whether the stream is still going, so it must not go stale while
    // the sub count happens to sit still.
    state.lastSeenAt = new Date().toISOString();
    await saveState();
    broadcast();
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'YouTube API request timed out' : err.message;
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

function authorized(req, url) {
  if (!CONFIG.controlToken) return true;
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === CONFIG.controlToken || url.searchParams.get('token') === CONFIG.controlToken;
}

/** Only accept a finite number; everything else is a client mistake. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/control.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
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

  // --- mutations -----------------------------------------------------------
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    if (!authorized(req, url)) return sendJson(res, 401, { error: 'Bad or missing control token' });

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    switch (url.pathname) {
      // "Okay, I did 50 push-ups."
      case '/api/done': {
        const amount = num(body.amount);
        if (amount === null || amount === 0) {
          return sendJson(res, 400, { error: 'amount must be a non-zero number' });
        }
        state.done += amount;
        pushHistory({ type: 'done', amount });
        break;
      }

      // Add (or remove) push-ups that did not come from subscribers.
      case '/api/pledge': {
        const amount = num(body.amount);
        if (amount === null || amount === 0) {
          return sendJson(res, 400, { error: 'amount must be a non-zero number' });
        }
        state.pledged += amount;
        pushHistory({ type: 'pledge', amount });
        break;
      }

      case '/api/undo': {
        const last = state.history.shift();
        if (!last) return sendJson(res, 400, { error: 'Nothing to undo' });
        if (last.type === 'done') state.done -= last.amount;
        else if (last.type === 'pledge') state.pledged -= last.amount;
        else if (last.type === 'settings') Object.assign(state, last.before);
        break;
      }

      // Going live: only subscribers from here on add push-ups. Whatever is
      // still owed carries over, so the number on screen does not jump.
      case '/api/new-stream': {
        if (state.subs === null) return sendJson(res, 400, { error: 'No subscriber count yet' });
        startNewStream(state.subs);
        break;
      }

      case '/api/settings': {
        const before = {};
        const next = {};
        for (const key of ['pledged', 'perSub', 'done', 'baselineSubs']) {
          if (!(key in body)) continue;
          const value = num(body[key]);
          if (value === null) return sendJson(res, 400, { error: `${key} must be a number` });
          before[key] = state[key];
          next[key] = value;
        }
        if (!Object.keys(next).length) return sendJson(res, 400, { error: 'Nothing to change' });
        Object.assign(state, next);
        pushHistory({ type: 'settings', before });
        break;
      }

      case '/api/refresh': {
        await poll({ quiet: true });
        return sendJson(res, 200, view());
      }

      default:
        return sendJson(res, 404, { error: 'Unknown endpoint' });
    }

    await saveState();
    broadcast();
    return sendJson(res, 200, view());
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET, POST' }).end('Method not allowed');
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
  console.log('');
  console.log('  Push-up counter is running.');
  console.log(`  Control page  ${base}/control.html`);
  console.log(`  OBS overlay   ${base}/overlay.html`);
  if (CONFIG.controlToken) console.log('  Control token required for edits (CONTROL_TOKEN is set).');
  if (!CONFIG.apiKey) console.log('  ! YOUTUBE_API_KEY is missing — copy .env.example to .env.');
  console.log('');

  await poll();
  setInterval(poll, CONFIG.pollSeconds * 1000);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveQueue.finally(() => process.exit(0));
  });
}
