import test from 'node:test';
import assert from 'node:assert/strict';

import { maskToCanvas, renderTrackerFrame } from '../public/js/tracker-render.js';
import { parseTrackerOptions } from '../public/js/tracker-options.js';

/** Minimal 2D-context stand-in that records what was asked of it. */
function fakeCanvas(width = 640, height = 360) {
  const calls = [];
  const ctx = {
    calls,
    globalCompositeOperation: 'source-over',
    fillStyle: null,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (x, y) => calls.push(['translate', x, y]),
    scale: (x, y) => calls.push(['scale', x, y]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillRect: function (...a) {
      calls.push(['fillRect', this.fillStyle, ...a]);
    },
    drawImage: function (source, ...rest) {
      calls.push(['drawImage', source?.tag ?? 'canvas', this.globalCompositeOperation, ...rest]);
    },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image) => calls.push(['putImageData', image.width, image.height]),
  };
  return { tag: 'canvas', width, height, getContext: () => ctx, ctx, calls };
}

const scratchPair = () => ({ mask: fakeCanvas(1, 1), layer: fakeCanvas(1, 1) });
const parse = (q) => parseTrackerOptions(new URLSearchParams(q));

const frameWith = (over = {}) => {
  const canvas = fakeCanvas();
  return {
    ctx: canvas.ctx,
    canvas,
    video: { tag: 'video' },
    landmarks: [{ x: 0.5, y: 0.5 }],
    mask: null,
    highlight: false,
    ...over,
  };
};

/* -------------------------------------------------------------- maskToCanvas */

function fakeMask(width, height, fill = 255) {
  return {
    width,
    height,
    getAsUint8Array: () => new Uint8Array(width * height).fill(fill),
  };
}

test('a mask becomes an alpha stencil at the mask resolution', () => {
  const scratch = fakeCanvas(1, 1);
  const out = maskToCanvas(fakeMask(4, 4, 128), scratch);
  assert.equal(out, scratch);
  assert.equal(scratch.width, 4);
  assert.equal(scratch.height, 4);
  assert.deepEqual(scratch.calls.at(-1), ['putImageData', 4, 4]);
});

test('a missing or unreadable mask yields no stencil rather than throwing', () => {
  assert.equal(maskToCanvas(null, fakeCanvas()), null);
  assert.equal(maskToCanvas({ width: 4, height: 4, getAsUint8Array: () => [] }, fakeCanvas()), null);
  assert.equal(
    maskToCanvas(
      {
        width: 4,
        height: 4,
        getAsUint8Array: () => {
          throw new Error('gpu buffer already closed');
        },
      },
      fakeCanvas(),
    ),
    null,
  );
});

test('a mask smaller than its declared size is rejected, not read past the end', () => {
  const truncated = { width: 8, height: 8, getAsUint8Array: () => new Uint8Array(4) };
  assert.equal(maskToCanvas(truncated, fakeCanvas()), null);
});

/* -------------------------------------------------------- renderTrackerFrame */

test('the default view draws the camera frame and the skeleton', () => {
  const frame = frameWith();
  let skeletonDrawn = false;
  renderTrackerFrame(
    { ...frame, drawSkeleton: () => (skeletonDrawn = true) },
    parse(''),
    scratchPair(),
  );

  const drew = frame.canvas.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(drew.length, 1);
  assert.equal(drew[0][1], 'video');
  assert.equal(skeletonDrawn, true);
});

test('skeleton=0 leaves the skeleton off', () => {
  const frame = frameWith();
  let skeletonDrawn = false;
  renderTrackerFrame(
    { ...frame, drawSkeleton: () => (skeletonDrawn = true) },
    parse('skeleton=0'),
    scratchPair(),
  );
  assert.equal(skeletonDrawn, false);
});

test('video=0 draws no camera frame, so only the skeleton lands on the scene', () => {
  const frame = frameWith();
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse('video=0'), scratchPair());
  assert.equal(
    frame.canvas.calls.filter((c) => c[0] === 'drawImage').length,
    0,
  );
});

test('the cutout clips the video to the body on its own layer', () => {
  const scratch = scratchPair();
  const frame = frameWith({ mask: fakeMask(8, 8) });
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse('cutout=1'), scratch);

  // The stencil is applied to the layer, not to the visible canvas.
  const layerOps = scratch.layer.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(layerOps[0][1], 'video');
  assert.equal(layerOps[1][2], 'destination-in', 'mask must clip, not paint over');

  // The finished layer is what reaches the output canvas.
  const out = frame.canvas.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(out.length, 1);
  assert.equal(out[0][2], 'source-over');
});

test('a chroma background is painted behind the cutout, not over it', () => {
  const frame = frameWith({ mask: fakeMask(8, 8) });
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse('bg=00ff00'), scratchPair());

  const order = frame.canvas.calls.map((c) => c[0]);
  const fill = order.indexOf('fillRect');
  const draw = order.indexOf('drawImage');
  assert.ok(fill !== -1, 'background should be filled');
  assert.ok(fill < draw, 'background must be painted before the person');
  assert.equal(frame.canvas.calls[fill][1], '#00ff00');
});

test('losing the mask shows the full frame rather than blinking the source out', () => {
  const scratch = scratchPair();
  const frame = frameWith({ mask: null });
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse('cutout=1'), scratch);

  const layerOps = scratch.layer.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(layerOps.length, 1, 'video is drawn');
  assert.ok(!layerOps.some((c) => c[2] === 'destination-in'), 'nothing clips it away');
  assert.equal(frame.canvas.calls.filter((c) => c[0] === 'drawImage').length, 1);
});

test('mirror flips the frame and always restores the transform', () => {
  const frame = frameWith();
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse('mirror=1'), scratchPair());

  const ops = frame.canvas.calls.map((c) => c.join(':'));
  assert.ok(ops.includes('scale:-1:1'), 'horizontal flip');
  assert.ok(ops.includes(`translate:${frame.canvas.width}:0`), 'flip is about the far edge');
  assert.equal(frame.canvas.calls.at(0)[0], 'save');
  assert.equal(frame.canvas.calls.at(-1)[0], 'restore');
});

test('an unmirrored frame applies no transform at all', () => {
  const frame = frameWith();
  renderTrackerFrame({ ...frame, drawSkeleton: () => {} }, parse(''), scratchPair());
  const ops = frame.canvas.calls.map((c) => c[0]);
  assert.ok(!ops.includes('scale'));
  assert.ok(!ops.includes('translate'));
});
