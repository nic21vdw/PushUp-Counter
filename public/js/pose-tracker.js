/**
 * Webcam + MediaPipe Pose plumbing.
 *
 * Owns the camera stream, the PoseLandmarker, and the requestAnimationFrame
 * loop. Hands each detected pose to a callback and draws the skeleton overlay.
 *
 * Assets (the WASM runtime and the pose model) load from public/vendor when it
 * has been populated by `npm run fetch-assets`, and from a CDN otherwise. This
 * module is imported lazily by camera.js so an asset failure degrades to the
 * manual buttons instead of taking the whole page down.
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

export class PoseTracker {
  /**
   * @param {{video: HTMLVideoElement, canvas: HTMLCanvasElement,
   *          onPose: (pose: {landmarks: Array|null, worldLandmarks: Array|null, timestamp: number}) => void,
   *          onStatus?: (message: string) => void,
   *          segmentation?: boolean,
   *          onFrame?: ((frame: object) => void)|null}} config
   */
  constructor({ video, canvas, onPose, onStatus = () => {}, segmentation = false, onFrame = null }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPose = onPose;
    this.onStatus = onStatus;
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
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
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
