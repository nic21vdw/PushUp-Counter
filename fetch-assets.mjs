#!/usr/bin/env node
/**
 * Download the pose model and its WASM runtime into public/vendor so the camera
 * page runs with no network at all.
 *
 * Optional: without it the page loads the same files from a CDN on first use.
 * Vendoring means no CDN dependency and a much faster start. Node 18+ only, no
 * packages to install.
 *
 *   node fetch-assets.mjs            download into public/vendor
 *   node fetch-assets.mjs --clean    remove it again (back to the CDN)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(ROOT, 'public', 'vendor');

const TASKS_VISION_VERSION = '0.10.14';
const TARBALL = `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${TASKS_VISION_VERSION}.tgz`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Only what the browser actually loads — skips source maps and typings.
const WANTED = new Map([
  ['package/vision_bundle.mjs', 'tasks-vision/vision_bundle.mjs'],
  ['package/wasm/vision_wasm_internal.js', 'tasks-vision/wasm/vision_wasm_internal.js'],
  ['package/wasm/vision_wasm_internal.wasm', 'tasks-vision/wasm/vision_wasm_internal.wasm'],
  ['package/wasm/vision_wasm_nosimd_internal.js', 'tasks-vision/wasm/vision_wasm_nosimd_internal.js'],
  ['package/wasm/vision_wasm_nosimd_internal.wasm', 'tasks-vision/wasm/vision_wasm_nosimd_internal.wasm'],
]);

async function download(url) {
  console.log(`  fetching ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function write(relPath, data) {
  const dest = path.join(VENDOR, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);
  console.log(`  wrote public/vendor/${relPath} (${Math.round(data.length / 1024)} KiB)`);
}

/**
 * Minimal tar reader. The npm tarball is a plain gzipped tar, and pulling five
 * known files out of it is a few lines of header parsing — not worth a
 * dependency in a project that deliberately has none.
 */
function readTar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;

    if (typeFlag === '0' || typeFlag === '') files.set(name, buffer.subarray(offset, offset + size));
    // Entries are padded to a 512-byte boundary.
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function gunzip(buffer) {
  const chunks = [];
  const stream = Readable.from(buffer).pipe(createGunzip());
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    total += (await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return total;
}

async function main() {
  if (process.argv.includes('--clean')) {
    await fs.rm(VENDOR, { recursive: true, force: true });
    console.log('Removed public/vendor. The camera page will fall back to the CDN.');
    return;
  }

  console.log(`Vendoring MediaPipe tasks-vision ${TASKS_VISION_VERSION}`);
  const files = readTar(await gunzip(await download(TARBALL)));

  for (const [inTarball, dest] of WANTED) {
    const data = files.get(inTarball);
    if (!data) throw new Error(`tarball did not contain ${inTarball}`);
    await write(dest, data);
  }

  console.log('Downloading pose landmarker model');
  await write('models/pose_landmarker_lite.task', await download(MODEL_URL));

  const size = await directorySize(VENDOR);
  console.log(`\nDone — public/vendor is ${(size / 1024 / 1024).toFixed(1)} MiB. Runs offline now.`);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  console.error('The camera page still works — it will load these files from a CDN instead.');
  process.exit(1);
});
