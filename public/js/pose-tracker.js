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

const CDN_VERSION = '0.10.14';
const LOCAL = {
  bundle: '/vendor/tasks-vision/vision_bundle.mjs',
  wasm: '/vendor/tasks-vision/wasm',
  model: '/vendor/models/pose_landmarker_lite.task',
};
const CDN = {
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CDN_VERSION}/vision_bundle.mjs`,
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CDN_VERSION}/wasm`,
  model:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

/** True when the vendored runtime is actually present and served. */
async function hasLocalAssets() {
  try {
    const [bundle, model] = await Promise.all([
      fetch(LOCAL.bundle, { method: 'HEAD' }),
      fetch(LOCAL.model, { method: 'HEAD' }),
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
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');

  let cameras = await videoInputs();
  if (cameras.length && cameras.every((d) => !d.label)) {
    try {
      const priming = await navigator.mediaDevices.getUserMedia({ video: true });
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
    this.ctx = canvas.getContext('2d');
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
    this.assetSource = null;
    this.lastVideoTime = -1;
    this.frameHandle = null;
    this.highlight = false;
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
      this.onStatus(isLocal ? 'Loading pose model…' : 'Loading pose model (CDN)…');
      try {
        await this.#loadFrom(assets);
        this.assetSource = isLocal ? 'local' : 'cdn';
        return;
      } catch (err) {
        lastError = err;
        console.warn(`pose assets failed to load from ${isLocal ? 'vendor/' : 'the CDN'}`, err);
      }
    }
    throw lastError ?? new Error('Could not load the pose model');
  }

  async #loadFrom(assets) {
    const { FilesetResolver, PoseLandmarker, DrawingUtils } = await import(
      /* @vite-ignore */ new URL(assets.bundle, document.baseURI).href
    );

    const fileset = await FilesetResolver.forVisionTasks(assets.wasm);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assets.model, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: this.segmentation,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.drawingUtils = new DrawingUtils(this.ctx);
    this.connections = PoseLandmarker.POSE_CONNECTIONS;
  }

  async start() {
    if (this.running) return;
    await this.load();

    this.onStatus('Requesting camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: await this.#videoConstraints(),
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (this.video.videoWidth === 0) {
      await new Promise((resolve) => this.video.addEventListener('loadeddata', resolve, { once: true }));
    }

    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.running = true;
    this.onStatus('Tracking');
    this.#loop();
  }

  /**
   * Resolve `camera` to a constraint. A streaming machine usually has several
   * video inputs — a real webcam or two, a phone-as-webcam bridge, OBS's own
   * virtual camera — and whichever the browser considers default is often the
   * one OBS has already taken. Naming the camera is how you avoid that.
   */
  async #videoConstraints() {
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (!this.camera) return { ...size, facingMode: 'user' };

    const cameras = await listCameras();
    const needle = this.camera.trim().toLowerCase();
    const match =
      cameras.find((d) => d.deviceId === this.camera) ??
      cameras.find((d) => d.label.toLowerCase().includes(needle));

    if (!match) {
      const names = cameras.map((d) => d.label || d.deviceId.slice(0, 8)).join(', ');
      throw new Error(
        `No camera matching "${this.camera}". This machine has: ${names || 'none'}`,
      );
    }
    return { ...size, deviceId: { exact: match.deviceId } };
  }

  stop() {
    this.running = false;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onStatus('Camera off');
  }

  /** Briefly tint the skeleton to acknowledge a counted rep. */
  flash() {
    this.highlight = true;
    setTimeout(() => {
      this.highlight = false;
    }, 220);
  }

  #loop() {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(() => this.#loop());

    // Only run inference when the decoder has actually produced a new frame.
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const timestamp = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, timestamp);
    } catch (err) {
      // A single bad frame shouldn't kill the loop.
      console.warn('pose detection frame failed', err);
      return;
    }

    const landmarks = result?.landmarks?.[0] ?? null;
    const worldLandmarks = result?.worldLandmarks?.[0] ?? null;
    const mask = result?.segmentationMasks?.[0] ?? null;

    try {
      this.#draw(landmarks, mask);
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
      return;
    }

    if (!landmarks || !this.drawingUtils) return;
    this.drawSkeleton(landmarks);
  }

  /** The default skeleton, exposed so a custom renderer can still use it. */
  drawSkeleton(landmarks, { highlight = this.highlight } = {}) {
    if (!landmarks || !this.drawingUtils) return;
    const { canvas } = this;
    const accent = highlight ? '#4ade80' : '#38bdf8';
    this.drawingUtils.drawConnectors(landmarks, this.connections, {
      color: accent,
      lineWidth: Math.max(2, canvas.width / 300),
    });
    this.drawingUtils.drawLandmarks(landmarks, {
      color: highlight ? '#bbf7d0' : '#f8fafc',
      fillColor: accent,
      radius: Math.max(2, canvas.width / 450),
    });
  }
}
