/**
 * Repair the count, or read back what happened to it, without stopping the
 * server.
 *
 *   node count.mjs              what the counter says now
 *   node count.mjs 40           put 40 push-ups on the clock
 *   node count.mjs --history    the last 20 things that moved the number
 *
 * The alternative — stop the server, edit state.json, start it again — drops
 * the camera and blanks the overlay, which is a bad thing to do to a stream
 * that is already showing the wrong number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = readEnv('PORT') ?? '4747';
const BASE = `http://127.0.0.1:${PORT}`;

function readEnv(key) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const [name, ...rest] = line.split('=');
      if (name.trim() === key) return rest.join('=').trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env is fine — the defaults below cover it */
  }
  return process.env[key];
}

function token() {
  try {
    return fs.readFileSync(path.join(ROOT, '.admin-token'), 'utf8').trim();
  } catch {
    fail('No .admin-token here yet. Start the counter once and it will make one.');
  }
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function ask(endpoint, init) {
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, init);
  } catch {
    fail(`Nothing answered on ${BASE}. Is the counter running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `${endpoint} said ${res.status}`);
  return body;
}

const [arg] = process.argv.slice(2);

if (arg === '--history' || arg === '-h') {
  const { entries } = await ask('/api/history?limit=20');
  if (!entries.length) console.log('\n  Nothing in the journal yet.\n');
  for (const entry of entries) {
    const when = new Date(entry.at).toLocaleString();
    console.log(`  ${when}  ${String(entry.left).padStart(5)} left   ${entry.reason ?? ''}`);
  }
  console.log();
} else if (arg === undefined) {
  const state = await ask('/api/state');
  console.log(
    `\n  ${state.left} push-ups left — ${state.owed} owed, ${state.done} done this stream.\n`,
  );
} else {
  const left = Number(arg);
  if (!Number.isInteger(left) || left < 0) fail(`"${arg}" is not a whole number of push-ups.`);

  const state = await ask('/api/count', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pushup-admin': token() },
    body: JSON.stringify({ left }),
  });
  console.log(`\n  The counter now says ${state.left}.\n`);
}
