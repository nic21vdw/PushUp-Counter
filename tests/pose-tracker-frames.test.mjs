import assert from "node:assert/strict";
import { test } from "node:test";
import { PoseTracker } from "../public/js/pose-tracker.js";

const flush = () => new Promise(setImmediate);

function readerFixture() {
  let waiting;
  const queued = [];
  const fixture = {
    cancelled: 0, released: 0,
    read() { return queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => { waiting = { resolve, reject }; }); },
    push(value, done = false) {
      const result = { value, done };
      if (waiting) { const pending = waiting; waiting = null; pending.resolve(result); }
      else queued.push(result);
    },
    fail() { const pending = waiting; waiting = null; pending.reject(new Error("invented reader failure")); },
    async cancel() { fixture.cancelled++; fixture.push(undefined, true); },
    releaseLock() { fixture.released++; },
  };
  return fixture;
}

function frame(width = 640, height = 480) {
  return { displayWidth: width, displayHeight: height, closes: 0, close() { this.closes++; } };
}

async function withFixture(run, { processor = true, videoCallbacks = true, processorThrows = false, drawThrows = false } = {}) {
  const saved = new Map(["navigator", "document", "MediaStreamTrackProcessor", "requestAnimationFrame", "cancelAnimationFrame"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const readers = [];
  const tracks = [];
  const callbacks = new Map();
  let nextCallback = 1;
  const ctx = { clearRect() {}, drawImage() { if (drawThrows) throw new Error("invented canvas failure"); } };
  const canvas = { width: 640, height: 480, getContext: () => ctx };
  const video = { videoWidth: 640, videoHeight: 480, currentTime: 0, play: async () => {} };
  if (videoCallbacks) {
    video.requestVideoFrameCallback = fn => { const id = nextCallback++; callbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => callbacks.delete(id);
  }
  const detected = [];
  const painted = [];
  const masks = [];
  let tracker;
  const install = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  install("navigator", { mediaDevices: { getUserMedia: async () => {
    const track = { stops: 0, stop() { this.stops++; } };
    tracks.push(track);
    return { getVideoTracks: () => [track], getTracks: () => [track] };
  } } });
  install("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  install("requestAnimationFrame", fn => { const id = nextCallback++; callbacks.set(id, fn); return id; });
  install("cancelAnimationFrame", id => callbacks.delete(id));
  install("MediaStreamTrackProcessor", processor ? class {
    constructor({ track }) {
      assert.ok(tracks.includes(track));
      if (processorThrows) throw new Error("invented unsupported processor");
      const reader = readerFixture();
      readers.push(reader);
      this.readable = { getReader: () => reader };
    }
  } : undefined);
  tracker = new PoseTracker({ video, canvas, onPose: pose => detected.push(pose), onFrame: value => painted.push(value) });
  tracker.landmarker = { detectForVideo(source, timestamp) {
    const mask = { closes: 0, close() { this.closes++; } };
    masks.push(mask);
    return { landmarks: [[{ x: source.width ?? 640 }]], segmentationMasks: [mask] };
  } };
  try { await run({ tracker, video, canvas, readers, tracks, callbacks, detected, painted, masks, warnings }); }
  finally {
    tracker.stop();
    await flush();
    console.warn = warn;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("camera-driven frames count without any compositor callback and close decoder/mask buffers", () => withFixture(async f => {
  await f.tracker.start();
  assert.equal(f.callbacks.size, 0);
  for (let i = 0; i < 3; i++) {
    const value = frame(800, 600);
    f.readers[0].push(value);
    await flush();
    assert.equal(value.closes, 1);
  }
  assert.equal(f.detected.length, 3);
  assert.equal(f.painted[0].video, f.tracker.surface);
  assert.equal(f.canvas.width, 800);
  assert.equal(f.canvas.height, 600);
  assert.ok(f.detected[1].timestamp > f.detected[0].timestamp);
  assert.ok(f.tracker.sampleRate > 0);
  assert.ok(f.masks.every(mask => mask.closes === 1));
}));

test("stop cancels and releases the frame reader without starting fallback work", () => withFixture(async f => {
  await f.tracker.start();
  f.tracker.stop();
  await flush();
  assert.ok(f.readers[0].cancelled >= 1);
  assert.equal(f.readers[0].released, 1);
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.tracker.sampleRate, 0);
}));

test("a late frame from a stopped camera is closed and never counted on its replacement", () => withFixture(async f => {
  await f.tracker.start();
  const old = f.readers[0];
  // Simulate a device implementation whose cancellation settles later.
  old.cancel = async () => { old.cancelled++; };
  f.tracker.stop();
  await f.tracker.start();
  const stale = frame();
  old.push(stale);
  await flush();
  assert.equal(stale.closes, 1);
  assert.equal(f.detected.length, 0);
  assert.equal(f.tracker.frameReader, f.readers[1]);
  assert.equal(f.callbacks.size, 0);
  f.readers[1].push(frame());
  await flush();
  assert.equal(f.detected.length, 1);
  assert.equal(old.released, 1);
}));

test("reader failure and end-of-track preserve the current video-callback fallback", async () => {
  for (const fail of [true, false]) await withFixture(async f => {
    await f.tracker.start();
    if (fail) f.readers[0].fail();
    else f.readers[0].push(undefined, true);
    await flush();
    assert.equal(f.readers[0].released, 1);
    assert.equal(f.callbacks.size, 1);
    assert.equal(f.tracker.usingFrameCallback, true);
    const next = f.callbacks.values().next().value;
    f.callbacks.clear();
    next();
    assert.equal(f.detected.length, 1);
    if (fail) assert.equal(f.warnings.length, 1);
  });
});

test("an unsupported processor preserves decoder callbacks", () => withFixture(async f => {
  await f.tracker.start();
  assert.equal(f.callbacks.size, 1);
  assert.equal(f.tracker.usingFrameCallback, true);
}, { processorThrows: true }));

test("absent processor preserves decoder callbacks or duplicate-filtered animation fallback", async () => {
  for (const videoCallbacks of [true, false]) await withFixture(async f => {
    await f.tracker.start();
    assert.equal(f.tracker.usingFrameCallback, videoCallbacks);
    let next = f.callbacks.values().next().value;
    f.callbacks.clear(); next();
    assert.equal(f.detected.length, 1);
    next = f.callbacks.values().next().value;
    f.callbacks.clear(); next();
    assert.equal(f.detected.length, videoCallbacks ? 2 : 1);
    f.tracker.stop();
    assert.equal(f.callbacks.size, 0);
  }, { processor: false, videoCallbacks });
});

test("invalid frames and inference failures release buffers and continue sampling", () => withFixture(async f => {
  await f.tracker.start();
  const invalid = frame(0, 0);
  f.readers[0].push(invalid);
  await flush();
  assert.equal(invalid.closes, 1);
  assert.equal(f.detected.length, 0);
  const original = f.tracker.landmarker.detectForVideo;
  f.tracker.landmarker.detectForVideo = () => { throw new Error("invented model failure"); };
  const broken = frame();
  f.readers[0].push(broken);
  await flush();
  assert.equal(broken.closes, 1);
  f.tracker.landmarker.detectForVideo = original;
  f.readers[0].push(frame());
  await flush();
  assert.equal(f.detected.length, 1);
  assert.equal(f.callbacks.size, 0);
}));

test("canvas failures close the frame and recover through video callbacks", () => withFixture(async f => {
  await f.tracker.start();
  const value = frame();
  f.readers[0].push(value);
  await flush();
  assert.equal(value.closes, 1);
  assert.equal(f.readers[0].released, 1);
  assert.equal(f.callbacks.size, 1);
}, { drawThrows: true }));
