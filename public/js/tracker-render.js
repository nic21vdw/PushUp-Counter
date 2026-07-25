/**
 * Paints one frame of the OBS tracker view.
 *
 * Everything is composited into a single canvas so OBS gets one surface with a
 * real alpha channel — no chroma key needed unless you ask for one.
 */

/**
 * Turn a MediaPipe segmentation mask into a canvas whose alpha is the mask.
 *
 * The mask comes back much smaller than the video (256×256 for the lite model),
 * so it is built at its own size and scaled up on draw, which also softens the
 * edge for free. The scratch canvas is reused: allocating one per frame at 30fps
 * is a steady stream of garbage.
 *
 * @returns {HTMLCanvasElement|null} null when the mask can't be read.
 */
export function maskToCanvas(mask, scratch) {
  if (!mask) return null;

  let values;
  try {
    values = mask.getAsUint8Array();
  } catch {
    return null;
  }
  if (!values?.length) return null;

  const { width, height } = mask;
  if (!width || !height || values.length < width * height) return null;

  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(width, height);
  const rgba = image.data;

  // Colour is irrelevant — this is only ever used as an alpha stencil.
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    rgba[p] = 255;
    rgba[p + 1] = 255;
    rgba[p + 2] = 255;
    rgba[p + 3] = values[i];
  }
  ctx.putImageData(image, 0, 0);
  return scratch;
}

/**
 * @param {object} frame        the payload PoseTracker hands to onFrame
 * @param {object} options      parsed tracker options
 * @param {object} scratch      reused canvases: {mask, layer}
 */
export function renderTrackerFrame(frame, options, scratch) {
  const { ctx, canvas, video, landmarks, mask, highlight } = frame;
  const { width, height } = canvas;

  ctx.save();
  if (options.mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  if (options.video && video) {
    if (options.cutout) {
      // Compose the cutout on its own layer, so clipping the video to the body
      // shape can't also clip away the background colour or the skeleton.
      const layer = scratch.layer;
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      const lctx = layer.getContext('2d');
      lctx.clearRect(0, 0, width, height);
      lctx.drawImage(video, 0, 0, width, height);

      const stencil = maskToCanvas(mask, scratch.mask);
      if (stencil) {
        lctx.save();
        lctx.globalCompositeOperation = 'destination-in';
        lctx.drawImage(stencil, 0, 0, width, height);
        lctx.restore();
      }
      // No mask yet (the first frames, or nobody in shot) — better to show the
      // full frame for an instant than to blink the source out entirely.

      if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(layer, 0, 0);
    } else {
      if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(video, 0, 0, width, height);
    }
  } else if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }

  if (options.skeleton && landmarks) {
    frame.drawSkeleton?.(landmarks, { highlight });
  }

  ctx.restore();
}
