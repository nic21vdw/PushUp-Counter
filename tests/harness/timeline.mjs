import { rng } from "../rep-traces.mjs";
import { gauss } from "./pose-synth.mjs";

const ease = (k) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, k)))) / 2;

export class Timeline {
  constructor({ fps = 30, seed = 1, frameJitterMs = 0, dropRate = 0 } = {}) {
    this.fps = fps;
    this.random = rng(seed);
    this.frameJitterMs = frameJitterMs;
    this.dropRate = dropRate;
    this.t = 1000;
    this.frames = [];
    this.reps = [];
    this.decoys = [];
    this.base = { pose: "plank", elbow: 168, sag: 0, x: 0 };
  }

  rand(lo, hi) {
    return lo + (hi - lo) * this.random();
  }

  #step() {
    const base = 1000 / this.fps;
    this.t += Math.max(
      4,
      base + (this.frameJitterMs ? gauss(this.random) * this.frameJitterMs : 0),
    );
  }

  #emit(body) {
    if (this.dropRate && this.random() < this.dropRate) return;
    this.frames.push({ t: this.t, body });
  }

  span(ms, bodyAt) {
    const start = this.t;
    const end = start + ms;
    for (; this.t < end; this.#step()) {
      const body = bodyAt((this.t - start) / ms, this.t);
      this.#emit(body && { ...this.base, ...body });
    }
    return this;
  }

  hold(ms, body = {}) {
    return this.span(ms, () => body);
  }

  cover(ms) {
    return this.span(ms, () => null);
  }

  rep({
    top = 168,
    bottom = 78,
    downMs = 600,
    upMs = 600,
    bottomHoldMs = 0,
    topMs = 300,
    endTop = top,
    sag = 0,
    counts = true,
    during = null,
  } = {}) {
    const startAt = this.t;
    const tweak = (body, t) => (during ? during(body, t) : body);
    this.span(downMs, (k, t) =>
      tweak({ elbow: top - (top - bottom) * ease(k), sag }, t),
    );
    const bottomAt = this.t;
    if (bottomHoldMs)
      this.span(bottomHoldMs, (k, t) => tweak({ elbow: bottom, sag }, t));
    this.span(upMs, (k, t) =>
      tweak({ elbow: bottom + (endTop - bottom) * ease(k), sag }, t),
    );
    const endAt = this.t;
    if (topMs) this.span(topMs, (k, t) => tweak({ elbow: endTop, sag }, t));
    (counts ? this.reps : this.decoys).push({ startAt, bottomAt, endAt });
    this.base = { ...this.base, elbow: endTop };
    return this;
  }

  walk(ms, { fromX = -1.2, toX = 3, elbow = 150, pump = 0, cadenceMs = 900 }) {
    const start = this.t;
    this.span(ms, (k, t) => {
      const phase = ((t - start) / cadenceMs) * 2 * Math.PI;
      return {
        pose: "stand",
        x: fromX + (toX - fromX) * k,
        swing: 25 * Math.sin(phase),
        stride: 22 * Math.sin(phase),
        elbow: elbow - pump * (0.5 + 0.5 * Math.sin(phase * 2)),
      };
    });
    this.decoys.push({ startAt: start, bottomAt: start, endAt: this.t });
    return this;
  }

  pickUp(ms, { maxBow = 75, minElbow = 85, x = 0.4 } = {}) {
    const start = this.t;
    this.span(ms, (k) => {
      const bend = Math.sin(Math.PI * k);
      return {
        pose: "stand",
        x,
        bow: 2 + (maxBow - 2) * bend,
        swing: 10 * bend,
        stride: 0,
        elbow:
          168 - (168 - minElbow) * Math.sin(Math.PI * Math.min(1, k * 1.2)),
      };
    });
    this.decoys.push({ startAt: start, bottomAt: start, endAt: this.t });
    return this;
  }

  drink(ms, { x = 0.4 } = {}) {
    const start = this.t;
    this.span(ms, (k) => ({
      pose: "stand",
      x,
      bow: 4,
      swing: 45 * Math.sin(Math.PI * k),
      stride: 0,
      elbow: 165 - 125 * Math.sin(Math.PI * k),
    }));
    this.decoys.push({ startAt: start, bottomAt: start, endAt: this.t });
    return this;
  }

  getDown(ms) {
    this.span(ms, (k) =>
      k < 0.5
        ? { pose: "stand", elbow: 160, swing: 0, stride: 0 }
        : { pose: "plank", elbow: 168 },
    );
    this.base = { pose: "plank", elbow: 168, sag: 0, x: 0 };
    return this;
  }

  standUp(ms) {
    this.span(ms, (k) =>
      k < 0.4
        ? { pose: "plank", elbow: 168, sag: -0.2 * ease(k / 0.4) }
        : { pose: "stand", elbow: 165, swing: 0, stride: 0 },
    );
    return this;
  }
}
