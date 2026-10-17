/**
 * Webcam + MediaPipe Pose plumbing.
 *
 * Owns the camera stream, the PoseLandmarker, and the requestAnimationFrame
 * loop. Hands each detected pose to a callback and draws the skeleton overlay.
 *
 * Assets (the WASM runtime and the pose model) load from public/vendor when it
 * has been populated by `npm run fetch-assets`, and from a CDN otherwise. This
 * module is imported lazily by overlay.js, so a failure to load the model
 * leaves the number on screen and reports why, rather than taking the whole
 * browser source down mid-stream.
 */

import { armReading } from "./pose-math.js";

const CDN_VERSION = "0.10.14";
const LOCAL = {
  bundle: "/vendor/tasks-vision/vision_bundle.mjs",
  wasm: "/vendor/tasks-vision/wasm",
  model: "/vendor/models/pose_landmarker_lite.task",
};
const CDN = {
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CDN_VERSION}/vision_bundle.mjs`,
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CDN_VERSION}/wasm`,
  model:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};

const DRAW_MIN_VISIBILITY = 0.3;
const PULSE_MS = 520;
const HIGHLIGHT_MS = 220;
const TRAIL_LENGTH = 10;
const PALETTE_STEPS = 16;
const GAUGE_STEPS = 32;

const BONES = Uint8Array.of(
  11,
  12,
  11,
  13,
  13,
  15,
  12,
  14,
  14,
  16,
  11,
  23,
  12,
  24,
  23,
  24,
  23,
  25,
  25,
  27,
  24,
  26,
  26,
  28,
  0,
  11,
  0,
  12,
  27,
  31,
  28,
  32,
);

const JOINTS = Uint8Array.of(0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28);
const JOINT_T = Float32Array.of(
  0,
  0.15,
  0.15,
  0.3,
  0.3,
  0.45,
  0.45,
  0.55,
  0.55,
  0.75,
  0.75,
  1,
  1,
);
const JOINT_SIZE = Float32Array.of(
  1.5,
  1.7,
  1.7,
  2.2,
  2.2,
  2.4,
  2.4,
  1.6,
  1.6,
  1.6,
  1.6,
  1.4,
  1.4,
);
const PULSE_BORDERS = [
  [16, 0.3],
  [8, 0.55],
];

const TRAILED = Uint8Array.of(15, 16, 11, 12);
const TRAIL_T = Float32Array.of(0.7, 0.7, 0.1, 0.1);

const ARMS = [
  { side: "left", elbow: 13 },
  { side: "right", elbow: 14 },
];

const COOL_HUES = [190, 268, 322];
const HOT_HUES = [412, 386, 354];

const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const paletteCache = new Map();

function paletteFor(heatStep, accentStep) {
  const key = heatStep * 16 + accentStep;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const heat = heatStep / 10;
  const accent = accentStep / 8;
  const flashHue = lerp(150, 45, heat);
  const colors = [];
  for (let i = 0; i <= PALETTE_STEPS; i++) {
    const u = (i / PALETTE_STEPS) * 2;
    const seg = u < 1 ? 0 : 1;
    const local = u - seg;
    const cool = lerp(COOL_HUES[seg], COOL_HUES[seg + 1], local);
    const hot = lerp(HOT_HUES[seg], HOT_HUES[seg + 1], local);
    const hue = lerp(lerp(cool, hot, heat), flashHue, accent * 0.8);
    colors.push(
      `hsl(${Math.round(hue) % 360} 100% ${Math.round(60 + accent * 22)}%)`,
    );
  }
  paletteCache.set(key, colors);
  return colors;
}

const GAUGE_COLORS = Array.from(
  { length: GAUGE_STEPS + 1 },
  (_, i) => `hsl(${Math.round((130 * i) / GAUGE_STEPS)} 100% 55%)`,
);

function pulseColor(heat) {
  return `hsl(${Math.round(lerp(150, 45, heat))} 100% 62%)`;
}

/** True when the vendored runtime is actually present and served. */
async function hasLocalAssets() {
  try {
    const [bundle, model] = await Promise.all([
      fetch(LOCAL.bundle, { method: "HEAD" }),
      fetch(LOCAL.model, { method: "HEAD" }),
    ]);
    return bundle.ok && model.ok;
  } catch {
    return false;
  }
}

/**
 * Video inputs, with labels. Labels are blank until the origin has been granted
 * camera permission at least once, so prime it with a throwaway request first —
 * without labels there is nothing to match a name against.
 */
export async function listCameras() {
  const videoInputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput",
    );

  let cameras = await videoInputs();
  if (cameras.length && cameras.every((d) => !d.label)) {
    try {
      const priming = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      for (const track of priming.getTracks()) track.stop();
      cameras = await videoInputs();
    } catch {
      // Permission refused, or every camera is busy. Fall through with what we
      // have; the caller reports the real failure.
    }
  }
  return cameras;
}

export class PoseTracker {
  /**
   * @param {{video: HTMLVideoElement, canvas: HTMLCanvasElement,
   *          onPose: (pose: {landmarks: Array|null, worldLandmarks: Array|null, timestamp: number}) => void,
   *          onStatus?: (message: string) => void,
   *          segmentation?: boolean,
   *          onFrame?: ((frame: object) => void)|null}} config
   */
  constructor({
    video,
    canvas,
    onPose,
    onStatus = () => {},
    segmentation = false,
    onFrame = null,
    camera = null,
  }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onPose = onPose;
    this.onStatus = onStatus;
    // Which webcam to open: part of a device label, or a full deviceId. Null
    // takes whatever the browser calls the default — fine on a laptop, wrong on
    // a streaming machine where the default is usually the one OBS already has.
    this.camera = camera;
    // Body-shaped alpha mask, for cutting the background out of the OBS view.
    // Costs GPU work, so it is only requested when a page actually draws it.
    this.segmentation = segmentation;
    // Replaces the built-in skeleton drawing when a page wants to compose the
    // frame itself. Receives everything needed to paint one frame.
    this.onFrame = onFrame;
    this.landmarker = null;
    this.drawingUtils = null;
    this.connections = null;
    this.stream = null;
    this.running = false;
    // Opens run one at a time; `stopRequested` is how one already in flight
    // learns that the page has since finished with the camera.
    this.queue = null;
    this.stopRequested = false;
    this.assetSource = null;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.frameHandle = null;
    this.usingFrameCallback = false;
    this.flashAt = -Infinity;
    this.#heat = 0;
    // The elbow gauge fills from empty at `gaugeTop` degrees to full at
    // `gaugeFull` degrees, which is where it turns green.
    this.gaugeTop = 165;
    this.gaugeFull = 90;
    this.worldLandmarks = null;
    this.pts = new Float32Array(66);
    this.vis = new Float32Array(33);
    this.axis = new Float32Array(4);
    this.trail = new Float32Array(TRAILED.length * TRAIL_LENGTH * 2);
    this.trailHead = 0;
    this.trailCount = 0;
    this.armAngle = new Float32Array(2).fill(NaN);
    this.readings = [null, null];
    this.drawFailures = 0;
    // Samples per second actually reaching the rep counter. A quick push-up is
    // over in a third of a second, so this is the number that decides whether it
    // can be seen at all — the setup view puts it on screen for that reason.
    this.sampleRate = 0;
    this.lastSampleAt = null;
  }

  /** Loads the runtime and model once. Safe to call repeatedly. */
  async load() {
    if (this.landmarker) return;

    // Prefer whichever source looks available, but always try the other one
    // before giving up: the probe can be wrong either way (a server that
    // doesn't answer HEAD, a half-populated vendor directory, no internet).
    const order = (await hasLocalAssets()) ? [LOCAL, CDN] : [CDN, LOCAL];

    let lastError;
    for (const assets of order) {
      const isLocal = assets === LOCAL;
      this.onStatus(
        isLocal ? "Loading pose model…" : "Loading pose model (CDN)…",
      );
      try {
        await this.#loadFrom(assets);
        this.assetSource = isLocal ? "local" : "cdn";
        return;
      } catch (err) {
        lastError = err;
        console.warn(
          `pose assets failed to load from ${isLocal ? "vendor/" : "the CDN"}`,
          err,
        );
      }
    }
    throw lastError ?? new Error("Could not load the pose model");
  }

  async #loadFrom(assets) {
    const { FilesetResolver, PoseLandmarker, DrawingUtils } = await import(
      /* @vite-ignore */ new URL(assets.bundle, document.baseURI).href
    );

    const fileset = await FilesetResolver.forVisionTasks(assets.wasm);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assets.model, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      outputSegmentationMasks: this.segmentation,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.drawingUtils = new DrawingUtils(this.ctx);
    this.connections = PoseLandmarker.POSE_CONNECTIONS;
  }

  /**
   * Opening a camera takes seconds — the model loads, the device wakes, the
   * first frame arrives — and a switch arriving inside that window used to
   * start a second open over the top of the first. `this.stream` then pointed
   * at the new one and the old one was never stopped: a webcam held by a page
   * that had forgotten it, until OBS reloaded the source. So opens are queued,
   * and each one finishes, or fails, before the next begins.
   */
  start() {
    return this.#enqueue(() => this.#open());
  }

  #enqueue(task) {
    // A failed open must not poison the queue: the next attempt is usually the
    // one that works, being a different camera.
    const next = (this.queue ?? Promise.resolve()).catch(() => {}).then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  async #open() {
    if (this.running) return;
    this.stopRequested = false;
    await this.load();

    this.onStatus("Requesting camera…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: await this.#videoConstraints(),
      audio: false,
    });

    // Asked to stop while the device was waking up. Hand it straight back: a
    // camera acquired after the page has finished with it is one nothing will
    // ever release.
    if (this.stopRequested) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = this.stream;
    await this.video.play();
    if (this.video.videoWidth === 0) {
      await new Promise((resolve) =>
        this.video.addEventListener("loadeddata", resolve, { once: true }),
      );
    }

    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.running = true;
    this.onStatus("Tracking");
    this.#loop();
  }

  /**
   * Resolve `camera` to a constraint. A streaming machine usually has several
   * video inputs — a real webcam or two, a phone-as-webcam bridge, OBS's own
   * virtual camera — and whichever the browser considers default is often the
   * one OBS has already taken. Naming the camera is how you avoid that.
   *
   * The frame rate is asked for as high as the camera will go: every frame is
   * one more sample of the elbow angle, and a fast rep is only a handful of
   * samples wide to begin with.
   */
  async #videoConstraints() {
    const size = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
    };
    if (!this.camera) return { ...size, facingMode: "user" };

    const cameras = await listCameras();
    const needle = this.camera.trim().toLowerCase();
    const match =
      cameras.find((d) => d.deviceId === this.camera) ??
      cameras.find((d) => d.label.toLowerCase().includes(needle));

    if (!match) {
      const names = cameras
        .map((d) => d.label || d.deviceId.slice(0, 8))
        .join(", ");
      throw new Error(
        `No camera matching "${this.camera}". This machine has: ${names || "none"}`,
      );
    }
    return { ...size, deviceId: { exact: match.deviceId } };
  }

  /**
   * Point this tracker at a different webcam. Only the stream is swapped: the
   * model is the expensive part, it is already in memory, and a fresh tracker
   * would fetch it again — several seconds of a blank tile and a counter that
   * sees nothing, every time you change camera.
   */
  async setCamera(camera) {
    this.camera = camera;
    return this.#enqueue(() => {
      // Stopped is the state a failed switch leaves behind, so this reopens
      // rather than returning early — otherwise the first camera that refuses
      // to open would be the last one this tracker ever tried.
      if (this.running) this.stop();
      return this.#open();
    });
  }

  stop() {
    this.running = false;
    this.stopRequested = true;
    if (this.frameHandle !== null) {
      if (this.usingFrameCallback)
        this.video.cancelVideoFrameCallback?.(this.frameHandle);
      else cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this.lastSampleAt = null;
    this.sampleRate = 0;
    this.trailCount = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onStatus("Camera off");
  }

  #heat = 0;

  /** How hot the glow runs, 0 (cool cyan and violet) to 1 (gold and red). */
  get heat() {
    return this.#heat;
  }

  set heat(value) {
    this.#heat = Number.isFinite(value) ? clamp01(value) : 0;
  }

  /** True for a moment after `flash()`. */
  get highlight() {
    return performance.now() - this.flashAt < HIGHLIGHT_MS;
  }

  /** Acknowledge a counted rep with a full-tile neon pulse. */
  flash() {
    this.flashAt = performance.now();
  }

  /**
   * Drive inference off the decoder rather than off the display.
   *
   * `requestVideoFrameCallback` fires once per decoded camera frame, so a 60 fps
   * webcam gives 60 samples a second. `requestAnimationFrame` fires once per
   * repaint, which in an OBS browser source is the scene's frame rate — often
   * 30, sometimes less while the encoder is busy — and every sample lost that
   * way comes straight off the resolution of a fast rep.
   */
  #loop() {
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.usingFrameCallback = true;
      const step = () => {
        if (!this.running) return;
        this.frameHandle = this.video.requestVideoFrameCallback(step);
        this.#processFrame();
      };
      this.frameHandle = this.video.requestVideoFrameCallback(step);
      return;
    }

    this.usingFrameCallback = false;
    const step = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(step);
      // Only run inference when the decoder has actually produced a new frame.
      if (this.video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = this.video.currentTime;
      this.#processFrame();
    };
    this.frameHandle = requestAnimationFrame(step);
  }

  #processFrame() {
    // MediaPipe rejects a timestamp that does not advance, and two frames can
    // land inside the same clock tick once the rate is high enough.
    const timestamp = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    if (this.lastSampleAt !== null) {
      const dt = timestamp - this.lastSampleAt;
      if (dt > 0) this.sampleRate += 0.2 * (1000 / dt - this.sampleRate);
    }
    this.lastSampleAt = timestamp;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, timestamp);
    } catch (err) {
      // A single bad frame shouldn't kill the loop.
      console.warn("pose detection frame failed", err);
      return;
    }

    const landmarks = result?.landmarks?.[0] ?? null;
    const worldLandmarks = result?.worldLandmarks?.[0] ?? null;
    const mask = result?.segmentationMasks?.[0] ?? null;

    this.worldLandmarks = worldLandmarks;
    try {
      try {
        this.#draw(landmarks, mask);
      } catch (err) {
        this.drawFailures += 1;
        if (this.drawFailures <= 3) console.warn("pose drawing failed", err);
      }
      this.onPose({ landmarks, worldLandmarks, timestamp });
    } finally {
      // Masks hold GPU/WASM memory that is not garbage collected. Skipping this
      // leaks a buffer per frame and the tab dies partway through a stream.
      mask?.close?.();
    }
  }

  #draw(landmarks, mask) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.onFrame) {
      this.onFrame({
        ctx,
        canvas,
        video: this.video,
        landmarks,
        mask,
        highlight: this.highlight,
        drawingUtils: this.drawingUtils,
        connections: this.connections,
      });
      this.drawPulse();
      return;
    }

    this.drawSkeleton(landmarks);
    this.drawPulse();
  }

  /**
   * The default skeleton, exposed so a custom renderer can still use it.
   *
   * Neon bones in layered glows under a gradient that runs head to feet,
   * glowing joints, a short trail behind wrists and shoulders, and a gauge at
   * each elbow that fills red to green as the arm reaches depth. Drawn
   * additively from preallocated buffers, so a frame costs a few dozen canvas
   * calls and no arrays.
   */
  drawSkeleton(
    landmarks,
    { highlight = this.highlight, now = performance.now() } = {},
  ) {
    if (!landmarks || landmarks.length < 29) {
      this.trailCount = 0;
      return;
    }
    const { ctx, canvas } = this;
    const width = canvas.width;
    const height = canvas.height;
    const heat = this.heat;
    const lit = Math.max(this.#pulseLevel(now), highlight ? 0.6 : 0);
    const palette = paletteFor(Math.round(heat * 10), Math.round(lit * 8));
    const shimmer = heat > 0.5 ? 1 + 0.12 * heat * Math.sin(now / 70) : 1;
    const base = Math.max(2, width / 300) * (1 + 0.5 * heat + 0.8 * lit);

    this.#project(landmarks, width, height);
    this.#pushTrail(width);

    ctx.save();
    try {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "lighter";
      this.#paintTrails(palette, base, heat);
      this.#paintBones(palette, base, shimmer, height);
      this.#paintJoints(palette, base, shimmer, heat, now);
      this.#paintGauges(landmarks, base, width, height, now);
    } finally {
      ctx.restore();
    }
  }

  /** The full-tile pulse that `flash()` starts. Does nothing once it has faded. */
  drawPulse(now = performance.now()) {
    const level = this.#pulseLevel(now);
    if (level <= 0) return;
    const { ctx, canvas } = this;
    const width = canvas.width;
    const height = canvas.height;
    const base = Math.max(2, width / 300);
    const color = pulseColor(this.heat);

    ctx.save();
    try {
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3 * level;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = color;
      for (const [span, alpha] of PULSE_BORDERS) {
        const line = base * span * (0.4 + 0.6 * level);
        ctx.globalAlpha = Math.min(1, alpha * level + 0.1 * level);
        ctx.lineWidth = line;
        ctx.strokeRect(line / 2, line / 2, width - line, height - line);
      }
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.9 * level;
      ctx.lineWidth = base * 2;
      ctx.strokeRect(base, base, width - base * 2, height - base * 2);

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6 * level;
      ctx.lineWidth = base * 6 * level;
      ctx.beginPath();
      ctx.arc(
        width / 2,
        height / 2,
        (1 - level) * 0.55 * Math.hypot(width, height),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } finally {
      ctx.restore();
    }
  }

  #pulseLevel(now) {
    const elapsed = now - this.flashAt;
    if (!(elapsed >= 0 && elapsed < PULSE_MS)) return 0;
    const left = 1 - elapsed / PULSE_MS;
    return left * left;
  }

  #project(landmarks, width, height) {
    const { pts, vis } = this;
    for (let i = 0; i < 33; i++) {
      const lm = landmarks[i];
      if (!lm) {
        vis[i] = 0;
        continue;
      }
      pts[i * 2] = lm.x * width;
      pts[i * 2 + 1] = lm.y * height;
      vis[i] = typeof lm.visibility === "number" ? lm.visibility : 1;
    }
  }

  #midpoint(a, b, slot) {
    const { pts, vis, axis } = this;
    const seenA = vis[a] >= DRAW_MIN_VISIBILITY;
    const seenB = vis[b] >= DRAW_MIN_VISIBILITY;
    if (!seenA && !seenB) return false;
    const from = seenA ? a : b;
    const to = seenB ? b : a;
    axis[slot] = (pts[from * 2] + pts[to * 2]) / 2;
    axis[slot + 1] = (pts[from * 2 + 1] + pts[to * 2 + 1]) / 2;
    return true;
  }

  #bodyGradient(palette, height) {
    const { ctx, axis } = this;
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = height;
    if (
      this.#midpoint(11, 12, 0) &&
      (this.#midpoint(27, 28, 2) ||
        this.#midpoint(25, 26, 2) ||
        this.#midpoint(23, 24, 2)) &&
      Math.hypot(axis[2] - axis[0], axis[3] - axis[1]) > 8
    ) {
      x0 = axis[0];
      y0 = axis[1];
      x1 = axis[2];
      y1 = axis[3];
    }
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, palette[0]);
    gradient.addColorStop(0.5, palette[PALETTE_STEPS / 2]);
    gradient.addColorStop(1, palette[PALETTE_STEPS]);
    return gradient;
  }

  #paintBones(palette, base, shimmer, height) {
    const { ctx, pts, vis } = this;
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < BONES.length; i += 2) {
      const a = BONES[i];
      const b = BONES[i + 1];
      if (vis[a] < DRAW_MIN_VISIBILITY || vis[b] < DRAW_MIN_VISIBILITY)
        continue;
      ctx.moveTo(pts[a * 2], pts[a * 2 + 1]);
      ctx.lineTo(pts[b * 2], pts[b * 2 + 1]);
      any = true;
    }
    if (!any) return;

    ctx.strokeStyle = this.#bodyGradient(palette, height);
    ctx.globalAlpha = 0.14 * shimmer;
    ctx.lineWidth = base * 5.5;
    ctx.stroke();
    ctx.globalAlpha = 0.4 * shimmer;
    ctx.lineWidth = base * 2.6;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = base * 1.4;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = base * 0.55;
    ctx.stroke();
  }

  #paintJoints(palette, base, shimmer, heat, now) {
    const { ctx, pts, vis } = this;
    for (let k = 0; k < JOINTS.length; k++) {
      const joint = JOINTS[k];
      if (vis[joint] < DRAW_MIN_VISIBILITY) continue;
      const x = pts[joint * 2];
      const y = pts[joint * 2 + 1];
      const radius = base * JOINT_SIZE[k];
      const breathe = 1 + 0.25 * heat * Math.sin(now / 90 + k);
      ctx.fillStyle = palette[Math.round(JOINT_T[k] * PALETTE_STEPS)];
      ctx.globalAlpha = 0.13 * shimmer;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.4 * breathe, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.4 * shimmer;
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #pushTrail(width) {
    const { pts, vis, trail } = this;
    const slots = TRAILED.length;
    const newest = (this.trailHead + TRAIL_LENGTH - 1) % TRAIL_LENGTH;
    if (this.trailCount > 0) {
      for (let s = 0; s < slots; s++) {
        const joint = TRAILED[s];
        const last = (newest * slots + s) * 2;
        if (vis[joint] < DRAW_MIN_VISIBILITY || Number.isNaN(trail[last]))
          continue;
        const jump = Math.hypot(
          pts[joint * 2] - trail[last],
          pts[joint * 2 + 1] - trail[last + 1],
        );
        if (jump > width * 0.3) {
          this.trailCount = 0;
          break;
        }
      }
    }
    for (let s = 0; s < slots; s++) {
      const joint = TRAILED[s];
      const at = (this.trailHead * slots + s) * 2;
      const seen = vis[joint] >= DRAW_MIN_VISIBILITY;
      trail[at] = seen ? pts[joint * 2] : NaN;
      trail[at + 1] = seen ? pts[joint * 2 + 1] : NaN;
    }
    this.trailHead = (this.trailHead + 1) % TRAIL_LENGTH;
    this.trailCount = Math.min(this.trailCount + 1, TRAIL_LENGTH);
  }

  #paintTrails(palette, base, heat) {
    const { ctx, trail } = this;
    const slots = TRAILED.length;
    const count = this.trailCount;
    if (count < 2) return;
    const gain = 0.55 + 0.4 * heat;
    for (let s = 0; s < slots; s++) {
      ctx.strokeStyle = palette[Math.round(TRAIL_T[s] * PALETTE_STEPS)];
      for (let k = 1; k < count; k++) {
        const from =
          (this.trailHead - count + k - 1 + TRAIL_LENGTH * 2) % TRAIL_LENGTH;
        const to = (from + 1) % TRAIL_LENGTH;
        const x0 = trail[(from * slots + s) * 2];
        const y0 = trail[(from * slots + s) * 2 + 1];
        const x1 = trail[(to * slots + s) * 2];
        const y1 = trail[(to * slots + s) * 2 + 1];
        if (Number.isNaN(x0) || Number.isNaN(x1)) continue;
        const fade = k / (count - 1);
        ctx.globalAlpha = Math.min(0.9, gain * fade);
        ctx.lineWidth = base * (0.5 + 2.2 * fade);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  #paintGauges(landmarks, base, width, height, now) {
    const aspect = width / height;
    const radius = Math.max(16, width * 0.03);
    const readings = this.readings;
    for (let i = 0; i < ARMS.length; i++) {
      const reading = armReading(
        landmarks,
        this.worldLandmarks,
        ARMS[i].side,
        0.35,
        aspect,
      );
      readings[i] = reading;
      if (!reading) {
        this.armAngle[i] = NaN;
      } else if (Number.isNaN(this.armAngle[i])) {
        this.armAngle[i] = reading.angle;
      } else {
        this.armAngle[i] += 0.6 * (reading.angle - this.armAngle[i]);
      }
    }
    if (readings[0] && readings[1]) {
      const a = ARMS[0].elbow;
      const b = ARMS[1].elbow;
      const apart = Math.hypot(
        this.pts[a * 2] - this.pts[b * 2],
        this.pts[a * 2 + 1] - this.pts[b * 2 + 1],
      );
      if (apart < radius * 1.4) {
        readings[readings[0].weight >= readings[1].weight ? 1 : 0] = null;
      }
    }
    for (let i = 0; i < ARMS.length; i++) {
      if (!readings[i]) continue;
      const elbow = ARMS[i].elbow;
      this.#paintGauge(
        this.pts[elbow * 2],
        this.pts[elbow * 2 + 1],
        radius,
        this.armAngle[i],
        base,
        now,
      );
    }
  }

  #paintGauge(x, y, radius, angle, base, now) {
    const { ctx } = this;
    const fill = clamp01(
      (this.gaugeTop - angle) / (this.gaugeTop - this.gaugeFull),
    );
    const start = -Math.PI / 2;

    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = base * 1.2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (fill < 0.02) return;

    const end = start + fill * Math.PI * 2;
    ctx.strokeStyle = GAUGE_COLORS[Math.round(fill * GAUGE_STEPS)];
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = base * 4.5;
    ctx.beginPath();
    ctx.arc(x, y, radius, start, end);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = base * 1.9;
    ctx.beginPath();
    ctx.arc(x, y, radius, start, end);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(
      x + Math.cos(end) * radius,
      y + Math.sin(end) * radius,
      base * 1.4,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    if (fill >= 0.97) {
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = base * 1.4;
      ctx.beginPath();
      ctx.arc(x, y, radius * (1.3 + 0.08 * Math.sin(now / 60)), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
