/**
 * The 3D layer over the counter.
 *
 * A transparent WebGL canvas (three.js, loaded on demand from the import map in
 * overlay.html) that reacts to hype events: a drifting warp field that speeds up
 * with heat, bursts and shockwaves on every rep, an aura that climbs with the
 * combo, extruded milestone numbers that shatter, fireworks, meteors and glass.
 *
 * Every pixel it draws is premultiplied and the clear colour is fully
 * transparent, so the page still composites over the stream. If WebGL or the
 * library is unavailable `createHypeStage` resolves to null and the page works
 * exactly as it did before.
 */

export const FONT_URL =
  "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json";

export const GRADE_COLORS = {
  perfect: 0xffd23f,
  great: 0x2de2ff,
  good: 0x4ade80,
  sloppy: 0xff5a4a,
};

export const COMBO_FLOOR = 5;

export const TIER_PALETTES = [
  { a: 0x38d9ff, b: 0x7c5cff },
  { a: 0x3dffa0, b: 0x1fd1ff },
  { a: 0xffd23f, b: 0xff8a1f },
  { a: 0xff9a2f, b: 0xff2f6d },
  { a: 0xff4a2f, b: 0xff00c8 },
  { a: 0xffffff, b: 0xff00ff },
];

export const TIER_AURA = [0, 0.5, 0.66, 0.82, 0.95, 1];

export const COUNTDOWN_COLORS = {
  10: 0x38d9ff,
  5: 0xffd23f,
  3: 0xff9a2f,
  2: 0xff5a2f,
  1: 0xff2a2a,
};

export const MILESTONE_THEMES = {
  10: { top: 0xb8f4ff, bottom: 0x0a90ff, glow: 0x38d9ff },
  25: { top: 0xc8ff9a, bottom: 0x0fbf5f, glow: 0x4ade80 },
  50: { top: 0xffe066, bottom: 0xff8000, glow: 0xffd23f },
  75: { top: 0xffc48a, bottom: 0xff3a10, glow: 0xff7a2f },
  100: { top: 0xffb0ff, bottom: 0x9a1fff, glow: 0xff4fd8 },
};

const FALLBACK_THEME = { top: 0xffffff, bottom: 0xff3dcb, glow: 0xff7ae8 };

const FOV = 50;
const TAU = Math.PI * 2;
const MAX_PARTICLES = 2200;
const SIZE_BOOST = 1.5;
const STREAKS = 220;
const DUST = 480;
const RING_POOL = 10;
const BOLT_POOL = 8;
const BOLT_POINTS = 22;
const GLASS_COLS = 12;
const GLASS_ROWS = 7;
const BUSY_FRAME_MS = 12;
const AMBIENT_FRAME_MS = 33;
const SLEEP_FRAME_MS = 66;
const SLEEP_AFTER_MS = 25000;
const MAX_FRAME_ERRORS = 5;

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInCubic = (t) => t ** 3;
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];

/** Hex integer to [r, g, b] in 0..1, with no colour-space conversion. */
export function hexToRgb(hex) {
  return [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  ];
}

/** Hue/saturation/value (all 0..1) to [r, g, b]. */
export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + (((h % 1) + 1) % 1) * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** Which theme a milestone number gets: the largest key not above it. */
export function milestoneTheme(n) {
  const keys = Object.keys(MILESTONE_THEMES)
    .map(Number)
    .sort((a, b) => a - b);
  let found = null;
  for (const key of keys) if (n >= key) found = key;
  if (found === null) return MILESTONE_THEMES[10];
  if (n > 100 && n % 50 === 0) return FALLBACK_THEME;
  return MILESTONE_THEMES[found];
}

/** A rep that lands below the combo floor means the streak is over. */
export function tierAfterRep(tier, combo) {
  return Number.isFinite(combo) && combo < COMBO_FLOOR ? 0 : tier;
}

const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software|basic render/i;

function rendererName(gl) {
  try {
    const info = gl.getExtension?.("WEBGL_debug_renderer_info");
    return info
      ? String(gl.getParameter?.(info.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";
  } catch {
    return "";
  }
}

/**
 * True when a throwaway canvas hands out a hardware WebGL context. A software
 * rasteriser would draw the layer on the CPU, which the pose detector needs.
 */
export function hasWebGL(doc = globalThis.document) {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return false;
    const software = SOFTWARE_RENDERER.test(rendererName(gl));
    gl.getExtension?.("WEBGL_lose_context")?.loseContext?.();
    return !software;
  } catch {
    return false;
  }
}

const NOISE_GLSL = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s;
}
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
`;

const PARTICLE_VERT = `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aKind;
attribute float aSeed;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSeed;
void main() {
  if (aAlpha <= 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 400.0);
  vColor = aColor;
  vAlpha = aAlpha;
  vKind = aKind;
  vSeed = aSeed;
}
`;

const PARTICLE_FRAG = `
uniform float uTime;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSeed;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (vKind < 0.5) {
    float core = exp(-d * d * 6.0);
    float halo = exp(-d * d * 2.2) * 0.5;
    float edge = 1.0 - smoothstep(0.75, 1.0, d);
    float tw = 0.82 + 0.18 * sin(uTime * (12.0 + vSeed * 14.0) + vSeed * 50.0);
    float f = (core + halo) * edge * tw;
    col = (vColor * f + vec3(core * core) * 0.55) * vAlpha;
    a = max(col.r, max(col.g, col.b)) * 0.55;
  } else if (vKind < 1.5) {
    float ang = vSeed * 6.2831 + uTime * (2.0 + vSeed * 3.0);
    float cs = cos(ang);
    float sn = sin(ang);
    vec2 q = mat2(cs, -sn, sn, cs) * p;
    float flip = cos(uTime * (5.0 + vSeed * 7.0) + vSeed * 31.0);
    float m = step(abs(q.x), 0.72) * step(abs(q.y), 0.6 * max(0.14, abs(flip)));
    a = m * vAlpha;
    col = vColor * (0.55 + 0.45 * abs(flip)) * a;
  } else {
    float cross4 = exp(-abs(p.x) * abs(p.y) * 38.0) * (1.0 - smoothstep(0.1, 1.0, d));
    float core = exp(-d * d * 22.0);
    float tw = 0.7 + 0.3 * sin(uTime * (18.0 + vSeed * 20.0) + vSeed * 70.0);
    float f = (cross4 * 0.9 + core) * tw;
    col = (vColor * f + vec3(core) * 0.7) * vAlpha;
    a = max(col.r, max(col.g, col.b)) * 0.55;
  }
  if (a < 0.004 && col.r + col.g + col.b < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

const STREAK_VERT = `
attribute vec4 aData;
uniform vec2 uHalf;
uniform float uTravel;
uniform float uLen;
uniform float uDist;
uniform float uRange;
varying float vHead;
varying float vFade;
varying float vSeed;
void main() {
  float seed = aData.z;
  float z0 = fract(seed * 37.31) * uRange;
  float zh = mod(z0 + uTravel * (0.6 + fract(seed * 11.7) * 0.8), uRange);
  float z = zh - uRange + uDist * 0.9;
  float len = uLen * (0.5 + fract(seed * 5.3));
  float zt = z - (1.0 - aData.w) * len;
  vec3 p = vec3(aData.x * uHalf.x * 2.2, aData.y * uHalf.y * 2.2, zt);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vHead = aData.w;
  vSeed = seed;
  float nearFade = 1.0 - smoothstep(uDist * 0.45, uDist * 0.9, z);
  float farFade = smoothstep(-uRange + uDist * 0.9, -uRange * 0.8 + uDist * 0.9, z);
  vFade = nearFade * farFade;
}
`;

const STREAK_FRAG = `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uIntensity;
uniform float uRainbow;
uniform float uTime;
varying float vHead;
varying float vFade;
varying float vSeed;
${NOISE_GLSL}
void main() {
  vec3 c = mix(uColA, uColB, fract(vSeed * 7.3));
  c = mix(c, hsv(fract(vSeed * 3.0 + uTime * 0.25), 0.8, 1.0), uRainbow);
  float a = vFade * (vHead * 0.95 + 0.05) * uIntensity;
  vec3 col = c * a;
  gl_FragColor = vec4(col, a * 0.6);
}
`;

const DUST_VERT = `
attribute vec4 aData;
uniform vec2 uHalf;
uniform float uTime;
uniform float uDrift;
uniform float uScale;
uniform float uDist;
varying float vFade;
varying float vSeed;
void main() {
  vec3 s = aData.xyz;
  float x = (s.x * 2.0 - 1.0) * uHalf.x * 1.6 + sin(uTime * 0.3 + s.z * 30.0) * 26.0;
  float span = uHalf.y * 3.0;
  float y = mod(s.y * span + uDrift * (14.0 + 50.0 * s.z), span) - span * 0.5;
  float z = -1100.0 * s.z + 120.0;
  vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.5 + aData.w * 7.0) * uScale / max(1.0, -mv.z);
  float tw = sin(uTime * (0.6 + s.z * 1.4) + s.x * 60.0) * 0.5 + 0.5;
  vFade = (0.25 + 0.75 * tw) * smoothstep(-uHalf.y * 1.5, -uHalf.y * 0.9, y) * (1.0 - smoothstep(uHalf.y * 0.9, uHalf.y * 1.5, y));
  vSeed = s.x;
}
`;

const DUST_FRAG = `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uIntensity;
uniform float uRainbow;
uniform float uTime;
varying float vFade;
varying float vSeed;
${NOISE_GLSL}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float f = exp(-d * d * 5.0) * (1.0 - smoothstep(0.7, 1.0, d));
  vec3 c = mix(uColA, uColB, fract(vSeed * 13.7));
  c = mix(c, hsv(fract(vSeed * 5.0 + uTime * 0.2), 0.7, 1.0), uRainbow);
  float a = f * vFade * uIntensity * 0.8;
  vec3 col = c * a;
  gl_FragColor = vec4(col, a * 0.6);
}
`;

const QUAD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = `
float sq(float x) {
  return x * x;
}
uniform vec3 uColor;
uniform float uProgress;
uniform float uWidth;
uniform float uAlpha;
uniform float uSplit;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float r = 0.06 + 0.9 * (1.0 - pow(1.0 - uProgress, 3.0));
  float w = uWidth * (1.0 - 0.55 * uProgress) + 0.004;
  float spl = uSplit * 0.03 * (1.0 - uProgress);
  float rr = exp(-sq((d - r * (1.0 + spl)) / w));
  float gg = exp(-sq((d - r) / w));
  float bb = exp(-sq((d - r * (1.0 - spl)) / w));
  float rim = exp(-sq((d - r) / (w * 0.3)));
  vec3 col = vec3(rr * uColor.r, gg * uColor.g, bb * uColor.b) * 1.3 + vec3(rim * 0.9);
  col += uColor * (1.0 - smoothstep(r * 0.2, r, d)) * 0.12 * (1.0 - uProgress);
  col *= pow(1.0 - uProgress, 1.4) * uAlpha;
  float a = clamp(max(col.r, max(col.g, col.b)) * 0.65, 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(1.0)), a);
}
`;

const AURA_FRAG = `
uniform vec2 uSize;
uniform vec2 uRect;
uniform float uTime;
uniform float uLevel;
uniform float uTier;
uniform float uHeat;
uniform float uRainbow;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec2 vUv;
${NOISE_GLSL}
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 q = (vUv - 0.5) * uSize;
  float sd = sdBox(q, uRect * 0.5, 18.0);
  float up = clamp(q.y / (uSize.y * 0.5), -1.0, 1.0);
  float t = uTime * (1.0 + 0.28 * uTier);
  float n = fbm(vec2(q.x * 0.016, q.y * 0.012 - t * 1.4));
  float n2 = fbm(vec2(q.x * 0.045 + 5.2, q.y * 0.035 - t * 2.4));
  float reach = min((22.0 + 24.0 * uTier + 36.0 * uHeat) * (0.55 + 0.9 * n) * (0.5 + 0.7 * smoothstep(-0.7, 1.0, up)), 190.0);
  float f = 1.0 - smoothstep(0.0, reach, sd + (n2 - 0.5) * 38.0);
  f *= f;
  vec2 hs = uSize * 0.5;
  float border = min(min(q.x + hs.x, hs.x - q.x), min(q.y + hs.y, hs.y - q.y));
  f *= smoothstep(-8.0, 14.0, sd) * smoothstep(0.0, 50.0, border) * uLevel;
  vec3 hot = mix(uColA, vec3(1.0), 0.55);
  vec3 col = mix(uColB, uColA, smoothstep(0.1, 0.7, f));
  col = mix(col, hot, smoothstep(0.65, 1.0, f));
  vec3 rb = hsv(fract(atan(q.y, q.x) / 6.2831 + uTime * 0.35 + n * 0.4), 0.85, 1.0);
  col = mix(col, rb, uRainbow * 0.85);
  col *= f * 1.35;
  float a = clamp(max(col.r, max(col.g, col.b)) * 0.6, 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(1.0)), a);
}
`;

const BOLT_VERT = `
attribute float aSide;
attribute float aT;
varying float vSide;
varying float vT;
void main() {
  vSide = aSide;
  vT = aT;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BOLT_FRAG = `
uniform vec3 uColor;
uniform float uAlpha;
varying float vSide;
varying float vT;
void main() {
  float d = abs(vSide);
  float glow = exp(-d * d * 2.2);
  float core = exp(-d * d * 28.0);
  vec3 col = uColor * glow * 0.9 + vec3(core);
  col *= uAlpha * (0.45 + 0.55 * sin(3.14159 * vT));
  gl_FragColor = vec4(min(col, vec3(1.0)), clamp(max(col.r, max(col.g, col.b)) * 0.65, 0.0, 1.0));
}
`;

const SHARD_VERT = `
attribute vec3 aBary;
attribute float aShade;
attribute float aFade;
varying vec3 vBary;
varying float vShade;
varying float vFade;
void main() {
  vBary = aBary;
  vShade = aShade;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHARD_FRAG = `
varying vec3 vBary;
varying float vShade;
varying float vFade;
void main() {
  float e = min(vBary.x, min(vBary.y, vBary.z));
  float rim = 1.0 - smoothstep(0.0, 0.07, e);
  vec3 tint = mix(vec3(0.55, 0.85, 1.0), vec3(0.95, 0.98, 1.0), vShade);
  float body = 0.05 + 0.1 * vShade;
  vec3 col = tint * (body + rim * 0.7) * vFade;
  float a = clamp(body * 0.8 + rim * 0.7, 0.0, 1.0) * vFade;
  gl_FragColor = vec4(col, a);
}
`;

const VIGNETTE_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const VIGNETTE_FRAG = `
uniform vec3 uColor;
uniform float uAmount;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float v = smoothstep(0.3, 1.25, length(p * vec2(0.9, 1.0)));
  vec3 col = uColor * v * uAmount;
  gl_FragColor = vec4(min(col, vec3(1.0)), clamp(max(col.r, max(col.g, col.b)) * 0.75, 0.0, 1.0));
}
`;

/**
 * Build the stage over `host`. Resolves to `{ handle, setCount, dispose }`, or
 * null when motion is reduced, WebGL is missing or three.js cannot load.
 */
export async function createHypeStage(host, { reducedMotion = false } = {}) {
  if (reducedMotion || !host) return null;
  const doc = host.ownerDocument ?? globalThis.document;
  if (!doc?.createElement) return null;
  const win = doc.defaultView ?? globalThis.window;
  if (win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches)
    return null;
  if (!hasWebGL(doc)) return null;

  let THREE;
  try {
    THREE = await import("three");
  } catch {
    return null;
  }
  const [textModule, fontModule] = await Promise.all([
    import("three/addons/geometries/TextGeometry.js").catch(() => null),
    import("three/addons/loaders/FontLoader.js").catch(() => null),
  ]);

  try {
    return buildStage(
      THREE,
      {
        TextGeometry: textModule?.TextGeometry,
        FontLoader: fontModule?.FontLoader,
      },
      host,
      doc,
      win,
    );
  } catch (err) {
    console.warn("hype-stage: 3D layer disabled", err);
    return null;
  }
}

function buildStage(THREE, addons, host, doc, win) {
  const { TextGeometry, FontLoader } = addons;

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    stencil: false,
  });
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  Object.assign(canvas.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "4",
    display: "block",
  });
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 10000);

  const disposables = [];
  const track = (resource) => {
    disposables.push(resource);
    return resource;
  };

  let W = 1;
  let H = 1;
  let D = 1;
  let pixelRatio = 1;
  let disposed = false;
  let contextLost = false;
  let raf = 0;
  let frameErrors = 0;
  let lastFrameAt = 0;
  let lastActivityAt = 0;
  let simT = 0;

  let heat = 0;
  let heatTarget = 0;
  let warp = 0;
  let shake = 0;
  let travel = 0;
  let drift = 0;
  let comboTier = 0;
  let tierSmooth = 0;
  let auraLevel = 0;
  let auraTarget = 0;
  let rainbow = 0;
  let rainbowTarget = 0;
  let flashAmount = 0;
  let flashDecay = 3;
  let idleLevel = 0;
  let idleUntil = 0;
  let idleBeatAt = 0;
  let idleStart = 0;
  let lastRepAt = 0;
  let progress = 0;
  let stormUntil = 0;
  let stormAcc = 0;
  let emberAcc = 0;
  let chaosBoltAt = 0;
  let chaosConfettiAcc = 0;
  let breakTimer = 0;
  let popGlow = 0;
  let readoutShift = "";
  let anchorAt = -1;
  let anchorCache = null;

  const palA = new THREE.Vector3(...hexToRgb(TIER_PALETTES[0].a));
  const palB = new THREE.Vector3(...hexToRgb(TIER_PALETTES[0].b));
  const palTargetA = new THREE.Vector3().copy(palA);
  const palTargetB = new THREE.Vector3().copy(palB);
  const flashColor = new THREE.Vector3(1, 1, 1);

  const schedule = [];
  const later = (ms, fn) => schedule.push({ at: simT + ms / 1000, fn });

  const readout = doc.getElementById("readout");

  function resize() {
    W = Math.max(1, win.innerWidth || host.clientWidth || 1);
    H = Math.max(1, win.innerHeight || host.clientHeight || 1);
    pixelRatio = Math.min(win.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(W, H, false);
    D = H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    camera.aspect = W / H;
    camera.near = D * 0.05;
    camera.far = D * 14;
    camera.position.set(0, 0, D);
    camera.updateProjectionMatrix();
    ambientUniforms.uHalf.value.set(W / 2, H / 2);
    ambientUniforms.uDist.value = D;
    dustUniforms.uHalf.value.set(W / 2, H / 2);
    dustUniforms.uDist.value = D;
    dustUniforms.uScale.value = D * pixelRatio;
    particleUniforms.uScale.value = D * pixelRatio;
    anchorAt = -1;
  }

  const blend = {
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  };

  const timeUniform = { value: 0 };

  const ambientUniforms = {
    uHalf: { value: new THREE.Vector2(1, 1) },
    uTravel: { value: 0 },
    uLen: { value: 80 },
    uDist: { value: 1 },
    uRange: { value: 3400 },
    uColA: { value: palA },
    uColB: { value: palB },
    uIntensity: { value: 0.3 },
    uRainbow: { value: 0 },
    uTime: timeUniform,
  };
  const streakGeo = track(new THREE.BufferGeometry());
  {
    const data = new Float32Array(STREAKS * 2 * 4);
    for (let i = 0; i < STREAKS; i += 1) {
      const x = rand(-1, 1);
      const y = rand(-1, 1);
      const seed = Math.random();
      data.set([x, y, seed, 0, x, y, seed, 1], i * 8);
    }
    streakGeo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
    streakGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(STREAKS * 2 * 3), 3),
    );
  }
  const streaks = new THREE.LineSegments(
    streakGeo,
    track(
      new THREE.ShaderMaterial({
        uniforms: ambientUniforms,
        vertexShader: STREAK_VERT,
        fragmentShader: STREAK_FRAG,
        ...blend,
      }),
    ),
  );
  streaks.frustumCulled = false;
  streaks.renderOrder = 0;
  scene.add(streaks);

  const dustUniforms = {
    uHalf: { value: new THREE.Vector2(1, 1) },
    uTime: timeUniform,
    uDrift: { value: 0 },
    uScale: { value: 1 },
    uDist: { value: 1 },
    uColA: { value: palA },
    uColB: { value: palB },
    uIntensity: { value: 0.4 },
    uRainbow: { value: 0 },
  };
  const dustGeo = track(new THREE.BufferGeometry());
  {
    const data = new Float32Array(DUST * 4);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random();
    dustGeo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
    dustGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(DUST * 3), 3),
    );
  }
  const dust = new THREE.Points(
    dustGeo,
    track(
      new THREE.ShaderMaterial({
        uniforms: dustUniforms,
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        ...blend,
      }),
    ),
  );
  dust.frustumCulled = false;
  dust.renderOrder = 0;
  scene.add(dust);

  const vignetteGeo = track(new THREE.PlaneGeometry(2, 2));
  function makeVignette(order) {
    const uniforms = {
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uAmount: { value: 0 },
    };
    const mesh = new THREE.Mesh(
      vignetteGeo,
      track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: VIGNETTE_VERT,
          fragmentShader: VIGNETTE_FRAG,
          ...blend,
        }),
      ),
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, uniforms };
  }
  const flashVig = makeVignette(1);
  const idleVig = makeVignette(1);
  idleVig.uniforms.uColor.value.set(0.62, 0.03, 0.06);

  const quadGeo = track(new THREE.PlaneGeometry(1, 1));

  const auraUniforms = {
    uSize: { value: new THREE.Vector2(400, 300) },
    uRect: { value: new THREE.Vector2(240, 90) },
    uTime: timeUniform,
    uLevel: { value: 0 },
    uTier: { value: 0 },
    uHeat: { value: 0 },
    uRainbow: { value: 0 },
    uColA: { value: palA },
    uColB: { value: palB },
  };
  const aura = new THREE.Mesh(
    quadGeo,
    track(
      new THREE.ShaderMaterial({
        uniforms: auraUniforms,
        vertexShader: QUAD_VERT,
        fragmentShader: AURA_FRAG,
        ...blend,
      }),
    ),
  );
  aura.renderOrder = 2;
  aura.visible = false;
  scene.add(aura);

  const rings = [];
  for (let i = 0; i < RING_POOL; i += 1) {
    const uniforms = {
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uProgress: { value: 0 },
      uWidth: { value: 0.06 },
      uAlpha: { value: 1 },
      uSplit: { value: 1 },
    };
    const mesh = new THREE.Mesh(
      quadGeo,
      track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: QUAD_VERT,
          fragmentShader: RING_FRAG,
          ...blend,
        }),
      ),
    );
    mesh.renderOrder = 3;
    mesh.visible = false;
    scene.add(mesh);
    rings.push({ mesh, uniforms, age: 0, life: 1, radius: 100, live: false });
  }
  let ringCursor = 0;

  function spawnRing({
    x,
    y,
    radius,
    color,
    life = 0.7,
    width = 0.06,
    alpha = 1,
    split = 1,
  }) {
    const ring = rings[ringCursor];
    ringCursor = (ringCursor + 1) % rings.length;
    ring.live = true;
    ring.age = 0;
    ring.life = life;
    ring.radius = radius;
    ring.mesh.position.set(x, y, 0);
    ring.mesh.scale.set(radius * 2, radius * 2, 1);
    ring.mesh.visible = true;
    ring.uniforms.uColor.value.set(color[0], color[1], color[2]);
    ring.uniforms.uWidth.value = width;
    ring.uniforms.uAlpha.value = alpha;
    ring.uniforms.uSplit.value = split;
    ring.uniforms.uProgress.value = 0;
  }

  const P = {
    pos: new Float32Array(MAX_PARTICLES * 3),
    col: new Float32Array(MAX_PARTICLES * 3),
    size: new Float32Array(MAX_PARTICLES),
    alpha: new Float32Array(MAX_PARTICLES),
    kind: new Float32Array(MAX_PARTICLES),
    seed: new Float32Array(MAX_PARTICLES),
    vel: new Float32Array(MAX_PARTICLES * 3),
    age: new Float32Array(MAX_PARTICLES),
    life: new Float32Array(MAX_PARTICLES),
    size0: new Float32Array(MAX_PARTICLES),
    size1: new Float32Array(MAX_PARTICLES),
    alpha0: new Float32Array(MAX_PARTICLES),
    drag: new Float32Array(MAX_PARTICLES),
    grav: new Float32Array(MAX_PARTICLES),
    fadeP: new Float32Array(MAX_PARTICLES),
    flutter: new Float32Array(MAX_PARTICLES),
    live: new Uint8Array(MAX_PARTICLES),
  };
  let liveParticles = 0;
  let particleCursor = 0;

  const particleUniforms = {
    uScale: { value: 1 },
    uTime: timeUniform,
  };
  const particleGeo = track(new THREE.BufferGeometry());
  const attributes = {};
  const defineAttribute = (name, array, itemSize) => {
    const attribute = new THREE.BufferAttribute(array, itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    particleGeo.setAttribute(name, attribute);
    attributes[name] = attribute;
  };
  defineAttribute("position", P.pos, 3);
  defineAttribute("aColor", P.col, 3);
  defineAttribute("aSize", P.size, 1);
  defineAttribute("aAlpha", P.alpha, 1);
  defineAttribute("aKind", P.kind, 1);
  defineAttribute("aSeed", P.seed, 1);
  const particles = new THREE.Points(
    particleGeo,
    track(
      new THREE.ShaderMaterial({
        uniforms: particleUniforms,
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        ...blend,
      }),
    ),
  );
  particles.frustumCulled = false;
  particles.renderOrder = 5;
  scene.add(particles);

  function emit(o) {
    let i = particleCursor;
    for (let k = 0; k < 48 && P.live[i]; k += 1) i = (i + 1) % MAX_PARTICLES;
    particleCursor = (i + 1) % MAX_PARTICLES;
    if (!P.live[i]) liveParticles += 1;
    P.live[i] = 1;
    P.pos[i * 3] = o.x;
    P.pos[i * 3 + 1] = o.y;
    P.pos[i * 3 + 2] = o.z ?? 0;
    P.vel[i * 3] = o.vx ?? 0;
    P.vel[i * 3 + 1] = o.vy ?? 0;
    P.vel[i * 3 + 2] = o.vz ?? 0;
    P.col[i * 3] = o.color[0];
    P.col[i * 3 + 1] = o.color[1];
    P.col[i * 3 + 2] = o.color[2];
    P.size0[i] = (o.size ?? 10) * SIZE_BOOST;
    P.size1[i] = (o.size1 ?? 1) * SIZE_BOOST;
    P.size[i] = P.size0[i];
    P.alpha0[i] = o.alpha ?? 1;
    P.alpha[i] = P.alpha0[i];
    P.life[i] = o.life ?? 1;
    P.age[i] = 0;
    P.drag[i] = o.drag ?? 1.5;
    P.grav[i] = o.grav ?? 0;
    P.fadeP[i] = o.fadeP ?? 1;
    P.flutter[i] = o.flutter ?? 0;
    P.kind[i] = o.kind ?? 0;
    P.seed[i] = Math.random();
    attributes.aKind.needsUpdate = true;
    attributes.aSeed.needsUpdate = true;
    attributes.aColor.needsUpdate = true;
  }

  function updateParticles(dt) {
    if (!liveParticles) return;
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      if (!P.live[i]) continue;
      P.age[i] += dt;
      const k = P.age[i] / P.life[i];
      if (k >= 1) {
        P.live[i] = 0;
        P.alpha[i] = 0;
        liveParticles -= 1;
        continue;
      }
      const damp = Math.exp(-P.drag[i] * dt);
      const i3 = i * 3;
      P.vel[i3] *= damp;
      P.vel[i3 + 1] = P.vel[i3 + 1] * damp - P.grav[i] * dt;
      P.vel[i3 + 2] *= damp;
      P.pos[i3] += P.vel[i3] * dt;
      P.pos[i3 + 1] += P.vel[i3 + 1] * dt;
      P.pos[i3 + 2] += P.vel[i3 + 2] * dt;
      if (P.flutter[i] > 0) {
        P.pos[i3] +=
          Math.sin(P.age[i] * 5 + P.seed[i] * 40) * P.flutter[i] * dt;
      }
      P.size[i] = lerp(P.size0[i], P.size1[i], k);
      P.alpha[i] = P.alpha0[i] * Math.max(0, 1 - k) ** P.fadeP[i];
    }
    attributes.position.needsUpdate = true;
    attributes.aSize.needsUpdate = true;
    attributes.aAlpha.needsUpdate = true;
  }

  function tint(base) {
    if (rainbow > 0.5) return hsvToRgb(Math.random(), 0.85, 1);
    return base;
  }

  function mixRgb(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  function whiten(rgb, amount) {
    return mixRgb(rgb, [1, 1, 1], amount);
  }

  function palette() {
    return [
      [palA.x, palA.y, palA.z],
      [palB.x, palB.y, palB.z],
    ];
  }

  function burst({
    x,
    y,
    z = 0,
    n,
    speed = [150, 500],
    size = [8, 18],
    size1 = 1,
    life = [0.5, 1],
    colors,
    kind = 0,
    drag = 1.5,
    grav = 0,
    angle = 0,
    spread = TAU,
    flat = false,
    fadeP = 1,
    alpha = 1,
    flutter = 0,
    lift = 0,
  }) {
    for (let i = 0; i < n; i += 1) {
      const a = angle + (Math.random() - 0.5) * spread;
      const sp = rand(speed[0], speed[1]);
      emit({
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + lift,
        vz: flat ? 0 : (Math.random() - 0.5) * sp * 0.6,
        size: rand(size[0], size[1]),
        size1,
        life: rand(life[0], life[1]),
        color: tint(pick(colors)),
        kind,
        drag,
        grav,
        fadeP,
        alpha,
        flutter,
      });
    }
  }

  function sphereBurst({
    x,
    y,
    n,
    speed,
    colors,
    size = [10, 16],
    life = [1.2, 1.9],
    grav = 140,
    drag = 1.6,
    kind = 0,
  }) {
    for (let i = 0; i < n; i += 1) {
      const u = rand(-1, 1);
      const phi = rand(0, TAU);
      const r = Math.sqrt(1 - u * u);
      const sp = rand(speed[0], speed[1]);
      emit({
        x,
        y,
        vx: Math.cos(phi) * r * sp,
        vy: Math.sin(phi) * r * sp,
        vz: u * sp,
        size: rand(size[0], size[1]),
        size1: 2,
        life: rand(life[0], life[1]),
        color: pick(colors),
        drag,
        grav,
        kind,
      });
    }
  }

  function confettiPiece(x, y, vx, vy, extra = {}) {
    emit({
      x,
      y,
      vx,
      vy,
      vz: rand(-40, 40),
      size: rand(12, 22),
      size1: rand(10, 18),
      life: extra.life ?? rand(2.5, 4),
      color: hsvToRgb(Math.random(), rand(0.55, 0.95), 1),
      kind: 1,
      drag: extra.drag ?? 0.35,
      grav: extra.grav ?? 90,
      fadeP: 0.3,
      flutter: rand(30, 90),
    });
  }

  const bolts = [];
  {
    const index = [];
    for (let i = 0; i < BOLT_POINTS - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const side = new Float32Array(BOLT_POINTS * 2);
    const along = new Float32Array(BOLT_POINTS * 2);
    for (let i = 0; i < BOLT_POINTS; i += 1) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      along[i * 2] = along[i * 2 + 1] = i / (BOLT_POINTS - 1);
    }
    for (let b = 0; b < BOLT_POOL; b += 1) {
      const geo = track(new THREE.BufferGeometry());
      const pos = new Float32Array(BOLT_POINTS * 2 * 3);
      const attr = new THREE.BufferAttribute(pos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("position", attr);
      geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
      geo.setAttribute("aT", new THREE.BufferAttribute(along, 1));
      geo.setIndex(index);
      const uniforms = {
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uAlpha: { value: 1 },
      };
      const mesh = new THREE.Mesh(
        geo,
        track(
          new THREE.ShaderMaterial({
            uniforms,
            vertexShader: BOLT_VERT,
            fragmentShader: BOLT_FRAG,
            side: THREE.DoubleSide,
            ...blend,
          }),
        ),
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      mesh.visible = false;
      scene.add(mesh);
      bolts.push({
        mesh,
        attr,
        pos,
        uniforms,
        live: false,
        age: 0,
        life: 0.2,
        from: [0, 0],
        to: [0, 0],
        width: 8,
        regen: 0,
      });
    }
  }
  let boltCursor = 0;

  function shapeBolt(bolt) {
    const [fx, fy] = bolt.from;
    const [tx, ty] = bolt.to;
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const amp = len * 0.09;
    const centre = [];
    for (let i = 0; i < BOLT_POINTS; i += 1) {
      const t = i / (BOLT_POINTS - 1);
      const kink = Math.sin(Math.PI * t) ** 0.6;
      const j = (Math.random() - 0.5) * 2 * amp * kink;
      centre.push([fx + dx * t + nx * j, fy + dy * t + ny * j]);
    }
    for (let i = 0; i < BOLT_POINTS; i += 1) {
      const a = centre[Math.max(0, i - 1)];
      const b = centre[Math.min(BOLT_POINTS - 1, i + 1)];
      const tx2 = b[0] - a[0];
      const ty2 = b[1] - a[1];
      const tl = Math.hypot(tx2, ty2) || 1;
      const px = -ty2 / tl;
      const py = tx2 / tl;
      const t = i / (BOLT_POINTS - 1);
      const w = bolt.width * (0.35 + 0.65 * Math.sin(Math.PI * t));
      const c = centre[i];
      bolt.pos.set([c[0] + px * w, c[1] + py * w, 2], i * 6);
      bolt.pos.set([c[0] - px * w, c[1] - py * w, 2], i * 6 + 3);
    }
    bolt.attr.needsUpdate = true;
  }

  function spawnBolt(from, to, color, { life = 0.22, width = 9 } = {}) {
    const bolt = bolts[boltCursor];
    boltCursor = (boltCursor + 1) % bolts.length;
    bolt.live = true;
    bolt.age = 0;
    bolt.life = life;
    bolt.width = width;
    bolt.from = from;
    bolt.to = to;
    bolt.regen = 0;
    bolt.uniforms.uColor.value.set(color[0], color[1], color[2]);
    bolt.mesh.visible = true;
    shapeBolt(bolt);
  }

  function randomEdgePoint() {
    const side = (Math.random() * 4) | 0;
    if (side === 0) return [rand(-W / 2, W / 2), H / 2 + 20];
    if (side === 1) return [rand(-W / 2, W / 2), -H / 2 - 20];
    if (side === 2) return [-W / 2 - 20, rand(-H / 2, H / 2)];
    return [W / 2 + 20, rand(-H / 2, H / 2)];
  }

  const glass = {
    live: false,
    age: 0,
    crack: 0.16,
    mesh: null,
    base: null,
    cur: null,
    cent: null,
    vel: null,
    axis: null,
    omega: null,
    delay: null,
    attrPos: null,
    attrFade: null,
    fade: null,
    count: GLASS_COLS * GLASS_ROWS * 2,
  };
  {
    const T = glass.count;
    glass.base = new Float32Array(T * 9);
    glass.cur = new Float32Array(T * 9);
    glass.cent = new Float32Array(T * 3);
    glass.vel = new Float32Array(T * 3);
    glass.axis = new Float32Array(T * 3);
    glass.omega = new Float32Array(T);
    glass.delay = new Float32Array(T);
    glass.fade = new Float32Array(T * 3);
    const bary = new Float32Array(T * 9);
    const shade = new Float32Array(T * 3);
    for (let t = 0; t < T; t += 1) {
      bary.set([1, 0, 0, 0, 1, 0, 0, 0, 1], t * 9);
      const s = Math.random();
      shade[t * 3] = shade[t * 3 + 1] = shade[t * 3 + 2] = s;
    }
    const geo = track(new THREE.BufferGeometry());
    glass.attrPos = new THREE.BufferAttribute(glass.cur, 3);
    glass.attrPos.setUsage(THREE.DynamicDrawUsage);
    glass.attrFade = new THREE.BufferAttribute(glass.fade, 1);
    glass.attrFade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", glass.attrPos);
    geo.setAttribute("aFade", glass.attrFade);
    geo.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
    geo.setAttribute("aShade", new THREE.BufferAttribute(shade, 1));
    glass.mesh = new THREE.Mesh(
      geo,
      track(
        new THREE.ShaderMaterial({
          vertexShader: SHARD_VERT,
          fragmentShader: SHARD_FRAG,
          side: THREE.DoubleSide,
          ...blend,
        }),
      ),
    );
    glass.mesh.frustumCulled = false;
    glass.mesh.renderOrder = 4;
    glass.mesh.visible = false;
    scene.add(glass.mesh);
  }

  function shatterGlass(cx, cy) {
    const cols = GLASS_COLS;
    const rows = GLASS_ROWS;
    const grid = [];
    for (let r = 0; r <= rows; r += 1) {
      for (let c = 0; c <= cols; c += 1) {
        const edgeX = c === 0 || c === cols;
        const edgeY = r === 0 || r === rows;
        const jx = edgeX ? 0 : rand(-0.35, 0.35) * (W / cols);
        const jy = edgeY ? 0 : rand(-0.35, 0.35) * (H / rows);
        grid.push([-W / 2 + (c / cols) * W + jx, H / 2 - (r / rows) * H + jy]);
      }
    }
    const at = (r, c) => grid[r * (cols + 1) + c];
    let t = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const a = at(r, c);
        const b = at(r, c + 1);
        const d = at(r + 1, c);
        const e = at(r + 1, c + 1);
        const tris =
          (r + c) % 2 === 0
            ? [
                [a, b, d],
                [b, e, d],
              ]
            : [
                [a, b, e],
                [a, e, d],
              ];
        for (const tri of tris) {
          for (let v = 0; v < 3; v += 1) {
            glass.base[t * 9 + v * 3] = tri[v][0];
            glass.base[t * 9 + v * 3 + 1] = tri[v][1];
            glass.base[t * 9 + v * 3 + 2] = 4;
          }
          const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
          const my = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          glass.cent.set([mx, my, 4], t * 3);
          const dx = mx - cx;
          const dy = my - cy;
          const dist = Math.hypot(dx, dy) || 1;
          const power = rand(160, 460) * (1 + 380 / (dist + 120));
          glass.vel.set(
            [
              (dx / dist) * power * 0.55 + rand(-60, 60),
              (dy / dist) * power * 0.55 + rand(40, 220),
              rand(60, 420),
            ],
            t * 3,
          );
          const ax = rand(-1, 1);
          const ay = rand(-1, 1);
          const az = rand(-1, 1);
          const al = Math.hypot(ax, ay, az) || 1;
          glass.axis.set([ax / al, ay / al, az / al], t * 3);
          glass.omega[t] = rand(-6, 6);
          glass.delay[t] = (dist / Math.hypot(W, H)) * 0.22 + rand(0, 0.06);
          t += 1;
        }
      }
    }
    glass.cur.set(glass.base);
    glass.fade.fill(1);
    glass.attrPos.needsUpdate = true;
    glass.attrFade.needsUpdate = true;
    glass.age = 0;
    glass.live = true;
    glass.mesh.visible = true;
  }

  function updateGlass(dt) {
    if (!glass.live) return;
    glass.age += dt;
    const T = glass.count;
    const life = 2.3;
    if (glass.age >= life) {
      glass.live = false;
      glass.mesh.visible = false;
      return;
    }
    for (let s = 0; s < T; s += 1) {
      const tt = glass.age - glass.crack - glass.delay[s];
      const s3 = s * 3;
      const s9 = s * 9;
      if (tt <= 0) continue;
      const theta = glass.omega[s] * tt;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const ux = glass.axis[s3];
      const uy = glass.axis[s3 + 1];
      const uz = glass.axis[s3 + 2];
      const cx = glass.cent[s3];
      const cy = glass.cent[s3 + 1];
      const cz = glass.cent[s3 + 2];
      const ox = glass.vel[s3] * tt;
      const oy = glass.vel[s3 + 1] * tt - 0.5 * 900 * tt * tt;
      const oz = glass.vel[s3 + 2] * tt;
      for (let v = 0; v < 3; v += 1) {
        const rx = glass.base[s9 + v * 3] - cx;
        const ry = glass.base[s9 + v * 3 + 1] - cy;
        const rz = glass.base[s9 + v * 3 + 2] - cz;
        const dot = ux * rx + uy * ry + uz * rz;
        const kx = uy * rz - uz * ry;
        const ky = uz * rx - ux * rz;
        const kz = ux * ry - uy * rx;
        glass.cur[s9 + v * 3] =
          cx + rx * cs + kx * sn + ux * dot * (1 - cs) + ox;
        glass.cur[s9 + v * 3 + 1] =
          cy + ry * cs + ky * sn + uy * dot * (1 - cs) + oy;
        glass.cur[s9 + v * 3 + 2] =
          cz + rz * cs + kz * sn + uz * dot * (1 - cs) + oz;
        glass.fade[s3 + v] = 1 - smoothstep(0.7, 1.8, tt);
      }
    }
    glass.attrPos.needsUpdate = true;
    glass.attrFade.needsUpdate = true;
  }

  const glowTexture = makeGlowTexture();
  track(glowTexture);
  const glowMaterial = (color, opacity, depthTest = false) =>
    new THREE.SpriteMaterial({
      map: glowTexture,
      color,
      opacity,
      transparent: true,
      depthTest,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

  function makeGlowTexture() {
    const c = doc.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  const popSprite = new THREE.Sprite(track(glowMaterial(0xffffff, 0)));
  popSprite.renderOrder = 6;
  popSprite.visible = false;
  scene.add(popSprite);

  const labelCache = new Map();
  function labelTexture(text, top, bottom, glowCss) {
    const key = `${text}|${top}|${bottom}`;
    const hit = labelCache.get(key);
    if (hit) return hit;
    const c = doc.createElement("canvas");
    c.width = 640;
    c.height = 256;
    const g = c.getContext("2d");
    let px = 190;
    g.font = `900 ${px}px Inter, "Helvetica Neue", Arial, sans-serif`;
    const measured = g.measureText(text).width;
    if (measured > 590) {
      px = Math.floor((px * 590) / measured);
      g.font = `900 ${px}px Inter, "Helvetica Neue", Arial, sans-serif`;
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.shadowColor = glowCss;
    g.shadowBlur = 40;
    g.strokeStyle = glowCss;
    g.lineWidth = 16;
    g.strokeText(text, 320, 132);
    g.shadowBlur = 0;
    g.strokeStyle = "rgba(20,6,2,0.92)";
    g.lineWidth = 12;
    g.strokeText(text, 320, 132);
    const fill = g.createLinearGradient(0, 40, 0, 220);
    fill.addColorStop(0, top);
    fill.addColorStop(1, bottom);
    g.fillStyle = fill;
    g.fillText(text, 320, 132);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    const entry = { texture, aspect: c.width / c.height };
    labelCache.set(key, entry);
    if (labelCache.size > 18) {
      const oldest = labelCache.keys().next().value;
      labelCache.get(oldest).texture.dispose();
      labelCache.delete(oldest);
    }
    return entry;
  }

  const css = (rgb) =>
    `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;

  const sprites = [];
  function addSprite(spec) {
    const entry = labelTexture(spec.text, spec.top, spec.bottom, spec.glow);
    const material = new THREE.SpriteMaterial({
      map: entry.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 9;
    scene.add(sprite);
    const item = { sprite, material, aspect: entry.aspect, age: 0, ...spec };
    sprites.push(item);
    return item;
  }

  function removeSprite(item) {
    scene.remove(item.sprite);
    item.material.dispose();
    item.glowSprite && scene.remove(item.glowSprite);
    const at = sprites.indexOf(item);
    if (at >= 0) sprites.splice(at, 1);
  }

  const lights = new THREE.Group();
  lights.add(new THREE.AmbientLight(0xffffff, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(300, 500, 900);
  lights.add(keyLight);
  const rimLeft = new THREE.PointLight(0x38d9ff, 3, 0, 0);
  const rimRight = new THREE.PointLight(0xff4fd8, 3, 0, 0);
  lights.add(rimLeft, rimRight);
  scene.add(lights);

  let font = null;
  let fontRequested = false;
  function loadFont() {
    if (fontRequested || !FontLoader) return;
    fontRequested = true;
    fetch(FONT_URL)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("font"))))
      .then((json) => {
        if (disposed) return;
        font = new FontLoader().parse(json);
      })
      .catch(() => {
        fontRequested = false;
        font = null;
      });
  }

  let big = null;

  function themeColors(theme) {
    return {
      top: hexToRgb(theme.top),
      bottom: hexToRgb(theme.bottom),
      glow: hexToRgb(theme.glow),
    };
  }

  function buildBigText(text, theme) {
    const colors = themeColors(theme);
    if (font && TextGeometry) {
      const geo = new TextGeometry(text, {
        font,
        size: 100,
        depth: 32,
        curveSegments: 4,
        bevelEnabled: true,
        bevelThickness: 7,
        bevelSize: 4.5,
        bevelSegments: 3,
      });
      geo.computeBoundingBox();
      geo.center();
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const w = bb.max.x - bb.min.x;
      const h = bb.max.y - bb.min.y;
      const posAttr = geo.attributes.position;
      const paint = new Float32Array(posAttr.count * 3);
      const top = new THREE.Color(theme.top);
      const bottom = new THREE.Color(theme.bottom);
      const c = new THREE.Color();
      for (let i = 0; i < posAttr.count; i += 1) {
        const t = clamp((posAttr.getY(i) - bb.min.y) / h);
        c.copy(bottom).lerp(top, t);
        paint[i * 3] = c.r;
        paint[i * 3 + 1] = c.g;
        paint[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(paint, 3));
      const material = new THREE.MeshPhongMaterial({
        vertexColors: true,
        shininess: 160,
        specular: 0xffffff,
        emissive: new THREE.Color(theme.bottom),
        emissiveIntensity: 0.35,
      });
      const mesh = new THREE.Mesh(geo, material);
      return {
        mesh,
        geo,
        material,
        w,
        h,
        colors,
        sample(count) {
          mesh.updateMatrixWorld(true);
          const v = new THREE.Vector3();
          const out = [];
          for (let i = 0; i < count; i += 1) {
            const at = (Math.random() * posAttr.count) | 0;
            v.fromBufferAttribute(posAttr, at).applyMatrix4(mesh.matrixWorld);
            out.push({
              x: v.x,
              y: v.y,
              z: v.z,
              t: clamp((posAttr.getY(at) - bb.min.y) / h),
            });
          }
          return out;
        },
      };
    }
    const entry = labelTexture(
      text,
      css(colors.top),
      css(colors.bottom),
      css(colors.glow),
    );
    const geo = new THREE.PlaneGeometry(entry.aspect * 100, 100);
    const material = new THREE.MeshBasicMaterial({
      map: entry.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, material);
    const w = entry.aspect * 100;
    return {
      mesh,
      geo,
      material,
      w,
      h: 100,
      colors,
      sample(count) {
        mesh.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        const out = [];
        for (let i = 0; i < count; i += 1) {
          v.set(rand(-w * 0.35, w * 0.35), rand(-30, 30), 0).applyMatrix4(
            mesh.matrixWorld,
          );
          out.push({ x: v.x, y: v.y, z: v.z, t: Math.random() });
        }
        return out;
      },
    };
  }

  function showBigText(text, theme, { dur = 2.8, scaleCap = 0.5 } = {}) {
    if (big) shatterBig();
    loadFont();
    const built = buildBigText(text, theme);
    const fit = Math.min((W * 0.74) / built.w, (H * scaleCap) / built.h);
    const glowSprite = new THREE.Sprite(
      glowMaterial(new THREE.Color(theme.glow), 0, true),
    );
    glowSprite.renderOrder = 4;
    scene.add(glowSprite);
    scene.add(built.mesh);
    big = { ...built, fit, dur, age: 0, glowSprite, theme };
    rimLeft.color.setHex(theme.glow);
    rimRight.color.setHex(theme.top);
    big.mesh.position.set(0, 0, -2600);
    big.mesh.scale.setScalar(fit * 0.2);
  }

  function updateBig(dt) {
    if (!big) return;
    big.age += dt;
    const t = big.age;
    const T = big.dur;
    const inT = 0.62;
    const chargeAt = T - 0.55;
    const m = big.mesh;
    let spin = 0;
    let z = 0;
    let scale = big.fit;
    let emissive = 0.35;
    let glow = 0.5;
    if (t < inT) {
      const u = t / inT;
      const e = easeOutBack(clamp(u));
      z = lerp(-2600, 0, e);
      scale = big.fit * lerp(0.35, 1, easeOutCubic(u));
      spin = (1 - easeOutCubic(u)) * TAU * 2.5;
      glow = u * 0.5;
    } else if (t < chargeAt) {
      const h = t - inT;
      spin = Math.sin(h * 2.2) * 0.3;
      scale = big.fit * (1 + 0.025 * Math.sin(h * 8));
      emissive = 0.45 + 0.35 * Math.sin(h * 6) ** 2;
      glow = 0.55 + 0.25 * Math.sin(h * 5);
      if (Math.random() < dt * 60) {
        const a = rand(0, TAU);
        const rx = big.w * big.fit * 0.55;
        const ry = big.h * big.fit * 0.6;
        emit({
          x: Math.cos(a) * rx * rand(0.6, 1.1),
          y: Math.sin(a) * ry * rand(0.6, 1.1),
          vx: rand(-40, 40),
          vy: rand(30, 120),
          size: rand(10, 20),
          size1: 2,
          life: rand(0.6, 1.1),
          color: whiten(tint(big.colors.top), 0.4),
          kind: 2,
          drag: 0.8,
        });
      }
    } else if (t < T) {
      const k = (t - chargeAt) / (T - chargeAt);
      scale = big.fit * (1 + 0.2 * k * k);
      emissive = 0.8 + 1.8 * k;
      glow = 0.8 + k * 1.1;
      m.position.x = (Math.random() - 0.5) * 12 * k;
      m.position.y = (Math.random() - 0.5) * 12 * k;
      shake = Math.max(shake, 3 + 7 * k);
    } else {
      shatterBig();
      return;
    }
    if (t < chargeAt) {
      m.position.x = 0;
      m.position.y = 0;
    }
    m.position.z = z;
    m.rotation.set(Math.sin(t * 1.7) * 0.06, spin, 0);
    m.scale.setScalar(scale);
    if (big.material.emissiveIntensity !== undefined) {
      big.material.emissiveIntensity = emissive;
    }
    const gs = Math.max(big.w, big.h * 2) * big.fit * 2.4;
    big.glowSprite.scale.set(gs, gs * 0.7, 1);
    big.glowSprite.material.opacity = clamp(glow, 0, 1.6);
    big.glowSprite.position.set(0, 0, z - 70 * big.fit);
  }

  function shatterBig() {
    if (!big) return;
    const current = big;
    big = null;
    const samples = current.sample(380);
    const centre = new THREE.Vector3(0, 0, 0);
    for (const s of samples) {
      const dir = new THREE.Vector3(s.x, s.y, s.z).sub(centre);
      const l = dir.length() || 1;
      dir.multiplyScalar(1 / l);
      const sp = rand(140, 820);
      const base = mixRgb(current.colors.bottom, current.colors.top, s.t);
      emit({
        x: s.x,
        y: s.y,
        z: s.z,
        vx: dir.x * sp + rand(-80, 80),
        vy: dir.y * sp + rand(-30, 120),
        vz: dir.z * sp * 0.7 + rand(-60, 160),
        size: rand(9, 20),
        size1: 1.5,
        life: rand(0.9, 1.9),
        color: whiten(tint(base), rand(0, 0.5)),
        kind: Math.random() < 0.3 ? 2 : 0,
        drag: 1.1,
        grav: 260,
      });
    }
    spawnRing({
      x: 0,
      y: 0,
      radius: Math.max(W, H) * 0.5,
      color: current.colors.glow,
      life: 0.9,
      width: 0.07,
    });
    spawnRing({
      x: 0,
      y: 0,
      radius: Math.max(W, H) * 0.32,
      color: whiten(current.colors.top, 0.5),
      life: 0.6,
      width: 0.05,
    });
    flash(current.colors.glow, 0.7, 2.6);
    shake = Math.max(shake, 20);
    scene.remove(current.mesh);
    scene.remove(current.glowSprite);
    current.geo.dispose();
    current.material.dispose();
    current.glowSprite.material.dispose();
  }

  function flash(rgb, amount, decay = 3) {
    flashColor.set(rgb[0], rgb[1], rgb[2]);
    flashAmount = Math.max(flashAmount, amount);
    flashDecay = decay;
  }

  function anchor(force = false) {
    if (!force && anchorCache && simT - anchorAt < 0.15) return anchorCache;
    const el = doc.getElementById("count");
    let r = null;
    try {
      const range = doc.createRange();
      range.selectNodeContents(el);
      r = range.getBoundingClientRect();
    } catch {
      r = el?.getBoundingClientRect() ?? null;
    }
    if (r && r.width > 2 && r.height > 2 && Number.isFinite(r.left)) {
      anchorCache = {
        x: r.left + r.width / 2 - W / 2,
        y: H / 2 - (r.top + r.height / 2),
        w: r.width,
        h: r.height,
        valid: true,
      };
    } else {
      anchorCache = {
        x: 0,
        y: 0,
        w: Math.min(260, W * 0.3),
        h: 90,
        valid: false,
      };
    }
    anchorAt = simT;
    return anchorCache;
  }

  function setTier(tier) {
    comboTier = tier;
    auraTarget = TIER_AURA[tier];
    rainbowTarget = tier === 5 ? 1 : 0;
  }

  const rockets = [];

  function launchFirework() {
    const x = rand(-0.4, 0.4) * W;
    const y0 = -H / 2 - 10;
    const ty = rand(0.02, 0.4) * H;
    const flight = rand(0.65, 0.95);
    rockets.push({
      x,
      y: y0,
      vx: rand(-30, 30),
      vy: (ty - y0) / flight,
      age: 0,
      flight,
      hue: Math.random(),
    });
  }

  function explodeFirework(x, y, hue) {
    const a = hsvToRgb(hue, 0.85, 1);
    const b = hsvToRgb(hue + 0.12, 0.45, 1);
    const k = H / 720;
    sphereBurst({
      x,
      y,
      n: 74,
      speed: [260 * k, 470 * k],
      colors: [a, a, b],
      size: [12, 18],
    });
    sphereBurst({
      x,
      y,
      n: 22,
      speed: [120 * k, 340 * k],
      colors: [
        [1, 1, 1],
        [1, 0.9, 0.6],
      ],
      size: [11, 16],
      life: [1.8, 2.6],
      grav: 90,
      drag: 1,
      kind: 2,
    });
    emit({ x, y, size: 110 * k, size1: 20, life: 0.28, color: [1, 1, 1] });
    spawnRing({ x, y, radius: 130 * k, color: a, life: 0.55, width: 0.045 });
    shake = Math.max(shake, 3);
  }

  function updateRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i -= 1) {
      const r = rockets[i];
      r.age += dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      emit({
        x: r.x,
        y: r.y,
        vx: rand(-20, 20),
        vy: rand(-60, -10),
        size: 13,
        size1: 1,
        life: rand(0.3, 0.5),
        color: [1, 0.85, 0.5],
        drag: 2,
      });
      if (r.age >= r.flight) {
        explodeFirework(r.x, r.y, r.hue);
        rockets.splice(i, 1);
      }
    }
  }

  const meteors = [];

  function launchMeteor(text) {
    const a = anchor(true);
    const red = [1, 0.28, 0.2];
    const item = addSprite({
      text,
      top: "#fff1c9",
      bottom: "#ff3a1f",
      glow: "rgba(255,70,40,0.95)",
    });
    const headGlow = new THREE.Sprite(glowMaterial(0xff4a2a, 1));
    headGlow.renderOrder = 8;
    scene.add(headGlow);
    item.glowSprite = headGlow;
    const meteor = {
      item,
      headGlow,
      age: 0,
      dur: 0.95,
      from: [a.x + W * 0.32, H / 2 + 140],
      to: [a.x, a.y],
      phase: "fall",
      hold: 0,
      red,
    };
    meteors.push(meteor);
  }

  function updateMeteors(dt) {
    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      const m = meteors[i];
      m.age += dt;
      const sp = m.item.sprite;
      const size = Math.min(H * 0.42, W * 0.25);
      if (m.phase === "fall") {
        const u = clamp(m.age / m.dur);
        const e = easeInCubic(u) * 0.85 + u * 0.15;
        const x = lerp(m.from[0], m.to[0], e);
        const y = lerp(m.from[1], m.to[1], e);
        const z = lerp(-900, 0, e);
        sp.position.set(x, y, z);
        sp.scale.set(size * m.item.aspect, size, 1);
        m.item.material.rotation = -0.35 * (1 - e);
        m.headGlow.position.set(x, y, z - 10);
        m.headGlow.scale.setScalar(size * 1.7);
        for (let k = 0; k < 3; k += 1) {
          emit({
            x: x + rand(-14, 14),
            y: y + rand(-10, 10),
            z,
            vx: rand(-40, 40) + (m.from[0] - m.to[0]) * 0.25,
            vy: rand(-30, 30) + (m.from[1] - m.to[1]) * 0.25,
            size: rand(18, 34),
            size1: 2,
            life: rand(0.35, 0.8),
            color: Math.random() < 0.5 ? [1, 0.45, 0.12] : [1, 0.12, 0.08],
            drag: 3,
          });
        }
        if (u >= 1) {
          m.phase = "hold";
          m.hold = 0;
          const red = m.red;
          spawnRing({
            x: m.to[0],
            y: m.to[1],
            radius: Math.max(W, H) * 0.34,
            color: red,
            life: 0.85,
            width: 0.08,
          });
          spawnRing({
            x: m.to[0],
            y: m.to[1],
            radius: Math.max(W, H) * 0.2,
            color: [1, 0.8, 0.4],
            life: 0.6,
            width: 0.05,
          });
          burst({
            x: m.to[0],
            y: m.to[1],
            n: 120,
            speed: [200, 800],
            size: [10, 26],
            life: [0.6, 1.3],
            colors: [red, [1, 0.55, 0.15], [1, 0.9, 0.6]],
            grav: 500,
            drag: 1.2,
          });
          flash(red, 0.8, 2.4);
          shake = Math.max(shake, 18);
          scene.remove(m.headGlow);
        }
      } else {
        m.hold += dt;
        const u = clamp(m.hold / 0.9);
        sp.position.y = m.to[1] + u * 36;
        sp.position.z = 0;
        sp.scale.set(
          size * m.item.aspect * (1 + 0.1 * u),
          size * (1 + 0.1 * u),
          1,
        );
        m.item.material.rotation = 0;
        m.item.material.opacity = 1 - smoothstep(0.55, 1, u);
        if (u >= 1) {
          removeSprite(m.item);
          m.headGlow.material.dispose();
          meteors.splice(i, 1);
        }
      }
    }
  }

  let punch = null;

  function launchPunch(num, rgb) {
    if (punch) removeSprite(punch.item);
    const item = addSprite({
      text: String(num),
      top: "#ffffff",
      bottom: css(rgb),
      glow: css(rgb),
    });
    punch = { item, age: 0, tilt: rand(-0.12, 0.12) };
  }

  function updatePunch(dt) {
    if (!punch) return;
    punch.age += dt;
    const t = punch.age;
    const dur = 1.0;
    const size = Math.min(H * 0.75, W * 0.4);
    const sp = punch.item.sprite;
    const k =
      t < 0.14
        ? lerp(2.8, 1, easeOutCubic(t / 0.14))
        : lerp(1, 1.18, (t - 0.14) / (dur - 0.14));
    sp.position.set(0, 0, 0);
    sp.scale.set(size * punch.item.aspect * k, size * k, 1);
    punch.item.material.rotation = punch.tilt;
    punch.item.material.opacity =
      t < 0.05 ? t / 0.05 : 1 - smoothstep(0.45, dur, t);
    if (t >= dur) {
      removeSprite(punch.item);
      punch = null;
    }
  }

  function runSchedule() {
    for (let i = schedule.length - 1; i >= 0; i -= 1) {
      if (simT >= schedule[i].at) {
        const [job] = schedule.splice(i, 1);
        try {
          job.fn();
        } catch (err) {
          console.warn("hype-stage: scheduled effect failed", err);
        }
      }
    }
  }

  function updateRings(dt) {
    for (const ring of rings) {
      if (!ring.live) continue;
      ring.age += dt;
      const u = ring.age / ring.life;
      if (u >= 1) {
        ring.live = false;
        ring.mesh.visible = false;
        continue;
      }
      ring.uniforms.uProgress.value = u;
    }
  }

  function updateBolts(dt) {
    for (const bolt of bolts) {
      if (!bolt.live) continue;
      bolt.age += dt;
      bolt.regen += dt;
      if (bolt.age >= bolt.life) {
        bolt.live = false;
        bolt.mesh.visible = false;
        continue;
      }
      if (bolt.regen > 0.045) {
        bolt.regen = 0;
        shapeBolt(bolt);
      }
      const u = bolt.age / bolt.life;
      bolt.uniforms.uAlpha.value = (1 - u * u) * (0.65 + 0.35 * Math.random());
    }
  }

  function updateEmitters(dt) {
    const a = anchor();
    if (comboTier >= 2 && simT - lastRepAt < 20) {
      emberAcc += dt * comboTier * 11;
      const [ca, cb] = palette();
      while (emberAcc >= 1) {
        emberAcc -= 1;
        emit({
          x: a.x + rand(-0.55, 0.55) * a.w,
          y: a.y + rand(-0.2, 0.5) * a.h,
          vx: rand(-25, 25),
          vy: rand(70, 190),
          size: rand(6, 13),
          size1: 1,
          life: rand(0.8, 1.6),
          color: tint(Math.random() < 0.5 ? ca : cb),
          drag: 0.4,
          grav: -30,
        });
      }
    }
    if (comboTier === 5 && simT - lastRepAt < 20) {
      if (simT >= chaosBoltAt) {
        chaosBoltAt = simT + rand(0.1, 0.28);
        const color = hsvToRgb(Math.random(), 0.55, 1);
        spawnBolt([a.x, a.y], randomEdgePoint(), color, {
          life: rand(0.14, 0.26),
          width: rand(5, 11),
        });
        if (Math.random() < 0.4) {
          spawnBolt(
            [a.x + rand(-a.w, a.w) * 0.5, a.y],
            [rand(-W / 2, W / 2), rand(-H / 2, H / 2)],
            color,
            { life: 0.16, width: 5 },
          );
        }
      }
      chaosConfettiAcc += dt * 16;
      while (chaosConfettiAcc >= 1) {
        chaosConfettiAcc -= 1;
        confettiPiece(
          a.x + rand(-a.w, a.w) * 0.4,
          a.y,
          rand(-160, 160),
          rand(160, 420),
          {
            life: rand(1.2, 2),
            grav: 420,
            drag: 0.5,
          },
        );
      }
    }
    if (simT < stormUntil) {
      stormAcc += dt * 72;
      while (stormAcc >= 1) {
        stormAcc -= 1;
        confettiPiece(
          rand(-W / 2, W / 2),
          H / 2 + 20,
          rand(-70, 70),
          -rand(120, 300),
          {
            life: (H + 100) / 200,
          },
        );
      }
    }
    if (idleLevel > 0 && simT < idleUntil && simT >= idleBeatAt) {
      idleBeatAt = simT + (1.7 - idleLevel * 0.5);
      const dark = [0.55, 0.03, 0.06];
      spawnRing({
        x: a.x,
        y: a.y,
        radius: 170 + idleLevel * 130,
        color: dark,
        life: 1.15,
        width: 0.09,
        alpha: 0.9,
        split: 0,
      });
      later(190, () =>
        spawnRing({
          x: a.x,
          y: a.y,
          radius: 140 + idleLevel * 110,
          color: dark,
          life: 0.95,
          width: 0.07,
          alpha: 0.7,
          split: 0,
        }),
      );
    }
  }

  function updateAmbient(dt) {
    heatTarget *= Math.exp(-dt / 7);
    heat += (heatTarget - heat) * (1 - Math.exp(-dt * 5));
    warp *= Math.exp(-dt * 2.2);
    const idleOn = simT < idleUntil;
    if (!idleOn) idleLevel = Math.max(0, idleLevel - dt * 0.4);

    if (idleOn) {
      palTargetA.set(0.75, 0.06, 0.09);
      palTargetB.set(0.32, 0.0, 0.18);
    } else {
      const p = TIER_PALETTES[comboTier];
      palTargetA.set(...hexToRgb(p.a));
      palTargetB.set(...hexToRgb(p.b));
    }
    const pk = 1 - Math.exp(-dt * 3);
    palA.lerp(palTargetA, pk);
    palB.lerp(palTargetB, pk);
    rainbow += (rainbowTarget - rainbow) * pk;
    auraLevel += (auraTarget - auraLevel) * (1 - Math.exp(-dt * 3));
    tierSmooth += (comboTier - tierSmooth) * (1 - Math.exp(-dt * 2.5));

    const speed =
      0.12 +
      1.7 * heat ** 1.2 +
      comboTier * 0.16 +
      warp * 1.6 +
      (simT < stormUntil ? 0.7 : 0);
    travel += dt * speed * 900;
    drift += dt * (0.4 + speed * 0.8);
    const intensity =
      (0.3 + 0.95 * heat + warp * 0.35) * (0.7 + 0.3 * progress);
    ambientUniforms.uTravel.value = travel;
    ambientUniforms.uLen.value = 60 + 560 * clamp(speed / 1.8);
    ambientUniforms.uIntensity.value = clamp(intensity * 0.95, 0, 1.3);
    ambientUniforms.uRainbow.value = rainbow;
    dustUniforms.uDrift.value = drift;
    dustUniforms.uIntensity.value = clamp(intensity * 1.1, 0, 1.4);
    dustUniforms.uRainbow.value = rainbow;
    timeUniform.value = simT;

    flashAmount *= Math.exp(-dt * flashDecay);
    flashVig.mesh.visible = flashAmount > 0.01;
    flashVig.uniforms.uAmount.value = flashAmount;
    flashVig.uniforms.uColor.value.copy(flashColor);

    let idleAmount = 0;
    if (idleOn) {
      const life = idleUntil - idleStart;
      const env = Math.sin(clamp((simT - idleStart) / life) * Math.PI);
      const pulse = (0.5 + 0.5 * Math.sin(simT * (1.9 + idleLevel))) ** 2;
      idleAmount = idleLevel * env * (0.25 + 0.75 * pulse) * 1.1;
    }
    idleVig.mesh.visible = idleAmount > 0.01;
    idleVig.uniforms.uAmount.value = idleAmount;

    if (popGlow > 0.01) {
      popGlow *= Math.exp(-dt * 7);
      popSprite.material.opacity = popGlow;
      popSprite.visible = true;
    } else {
      popSprite.visible = false;
    }
  }

  function updateAura() {
    const a = anchor();
    aura.visible = auraLevel > 0.01 && a.valid;
    if (!aura.visible) return;
    const padX = 230;
    const padY = 270;
    auraUniforms.uRect.value.set(a.w, a.h);
    auraUniforms.uSize.value.set(a.w + padX * 2, a.h + padY * 2);
    aura.scale.set(a.w + padX * 2, a.h + padY * 2, 1);
    aura.position.set(a.x, a.y + 40, 1);
    auraUniforms.uLevel.value = auraLevel;
    auraUniforms.uTier.value = tierSmooth;
    auraUniforms.uHeat.value = heat;
    auraUniforms.uRainbow.value = rainbow;
  }

  function applyShake(dt) {
    shake *= Math.exp(-dt * 8.5);
    if (shake < 0.05) shake = 0;
    const sx = (Math.random() - 0.5) * 2 * shake;
    const sy = (Math.random() - 0.5) * 2 * shake;
    camera.position.x = sx;
    camera.position.y = sy;
    camera.rotation.z = (Math.random() - 0.5) * shake * 0.0006;
    if (readout) {
      const next =
        shake > 0.6
          ? `${(sx * 0.45).toFixed(1)}px ${(-sy * 0.45).toFixed(1)}px`
          : "";
      if (next !== readoutShift) {
        readoutShift = next;
        readout.style.translate = next;
      }
    }
  }

  function isBusy() {
    return (
      liveParticles > 0 ||
      schedule.length > 0 ||
      rockets.length > 0 ||
      meteors.length > 0 ||
      big !== null ||
      punch !== null ||
      glass.live ||
      shake > 0.2 ||
      flashAmount > 0.01 ||
      auraLevel > 0.01 ||
      heat > 0.04 ||
      simT < idleUntil ||
      simT < stormUntil ||
      rings.some((r) => r.live) ||
      bolts.some((b) => b.live)
    );
  }

  function update(dt) {
    simT += dt;
    runSchedule();
    if (comboTier > 0 && simT - lastRepAt > 20) setTier(0);
    updateAmbient(dt);
    updateAura();
    updateEmitters(dt);
    updateRockets(dt);
    updateRings(dt);
    updateBolts(dt);
    updateGlass(dt);
    updateParticles(dt);
    updateBig(dt);
    updateMeteors(dt);
    updatePunch(dt);
    applyShake(dt);
  }

  function frame(now) {
    raf = 0;
    if (disposed || doc.hidden) return;
    raf = win.requestAnimationFrame(frame);
    if (contextLost) return;
    const busy = isBusy();
    const asleep = !busy && now - lastActivityAt > SLEEP_AFTER_MS;
    const gate = busy
      ? BUSY_FRAME_MS
      : asleep
        ? SLEEP_FRAME_MS
        : AMBIENT_FRAME_MS;
    if (now - lastFrameAt < gate) return;
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;
    try {
      update(dt);
      renderer.render(scene, camera);
    } catch (err) {
      frameErrors += 1;
      console.warn("hype-stage: frame failed", err);
      if (frameErrors >= MAX_FRAME_ERRORS) stop();
    }
  }

  function start() {
    if (raf || disposed || doc.hidden) return;
    lastFrameAt = win.performance.now();
    raf = win.requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
  }

  function wake() {
    lastActivityAt = win.performance.now();
    start();
  }

  function onVisibility() {
    if (doc.hidden) stop();
    else start();
  }

  function onLost(event) {
    event.preventDefault();
    contextLost = true;
    stop();
  }

  function onRestored() {
    contextLost = false;
    resize();
    start();
  }

  function circlePulse(a, color, radius, delays = [0]) {
    delays.forEach((ms, i) =>
      later(ms, () =>
        spawnRing({
          x: a.x,
          y: a.y,
          radius: radius * (1 + i * 0.18),
          color,
          life: 0.7,
          width: 0.06,
        }),
      ),
    );
  }

  const handlers = {
    start() {
      const a = anchor(true);
      warp = Math.max(warp, 1.4);
      heatTarget = Math.max(heatTarget, 0.35);
      const [ca, cb] = palette();
      circlePulse(a, ca, 220, [0, 140, 280]);
      burst({
        x: a.x,
        y: a.y,
        n: 110,
        speed: [200, 760],
        size: [8, 20],
        life: [0.7, 1.4],
        colors: [ca, cb, [1, 1, 1]],
        grav: 120,
      });
      flash(ca, 0.5, 2.2);
      shake = Math.max(shake, 8);
    },

    rep(ev) {
      const grade = GRADE_COLORS[ev.grade] ? ev.grade : "good";
      const h = clamp(Number(ev.heat) || 0);
      heatTarget = Math.max(h, heatTarget * 0.5);
      lastRepAt = simT;
      const tierNow = tierAfterRep(comboTier, Number(ev.combo));
      if (tierNow !== comboTier) setTier(tierNow);
      if (doc.hidden) return;
      const a = anchor(true);
      const base = hexToRgb(GRADE_COLORS[grade]);
      const strength =
        0.65 +
        h * 0.9 +
        ({ perfect: 0.55, great: 0.25, good: 0, sloppy: -0.3 }[grade] ?? 0);
      const k = Math.max(0.35, strength);
      warp = Math.max(warp, 0.5 + h * 0.7);
      burst({
        x: a.x,
        y: a.y,
        n: Math.round(34 * k),
        speed: [150, 520 * (0.7 + h * 0.8)],
        size: [8, 20],
        life: [0.5, 1],
        colors: [base, whiten(base, 0.45), base],
        grav: grade === "sloppy" ? 620 : 380,
      });
      burst({
        x: a.x,
        y: a.y,
        n: Math.round(10 * k),
        speed: [260, 760],
        size: [14, 26],
        life: [0.35, 0.8],
        colors: [whiten(base, 0.7)],
        kind: 2,
        drag: 2.2,
      });
      spawnRing({
        x: a.x,
        y: a.y,
        radius:
          (150 + 140 * h + (grade === "perfect" ? 70 : 0)) *
          (grade === "sloppy" ? 0.7 : 1),
        color: base,
        life: grade === "sloppy" ? 0.5 : 0.72,
        width: 0.06,
        alpha: grade === "sloppy" ? 0.7 : 1,
      });
      if (grade === "perfect") {
        later(90, () =>
          spawnRing({
            x: a.x,
            y: a.y,
            radius: 260 + 120 * h,
            color: [1, 0.95, 0.7],
            life: 0.8,
            width: 0.04,
          }),
        );
        burst({
          x: a.x,
          y: a.y,
          n: 16,
          speed: [100, 340],
          size: [14, 24],
          life: [0.8, 1.5],
          colors: [
            [1, 0.85, 0.3],
            [1, 1, 0.8],
          ],
          kind: 2,
          lift: 160,
          grav: 200,
        });
      }
      popGlow = grade === "sloppy" ? 0.45 : 0.9;
      popSprite.material.color.setRGB(...base.map((c) => c ** 2.2));
      popSprite.position.set(a.x, a.y, 3);
      popSprite.scale.set(a.w * 2.4 + 120, a.h * 2.6 + 120, 1);
      shake = Math.max(
        shake,
        (grade === "sloppy" ? 1.5 : 3) + h * 9 + (grade === "perfect" ? 2 : 0),
      );
    },

    combo(ev) {
      const tier = clamp(Math.round(Number(ev.tier) || 1), 1, 5);
      setTier(tier);
      lastRepAt = simT;
      heatTarget = Math.max(heatTarget, 0.5 + tier * 0.1);
      if (doc.hidden) return;
      const a = anchor(true);
      const pal = [
        hexToRgb(TIER_PALETTES[tier].a),
        hexToRgb(TIER_PALETTES[tier].b),
      ];
      warp = Math.max(warp, 1.2 + tier * 0.3);
      flash(pal[0], 0.45 + tier * 0.1, 2.2);
      circlePulse(a, pal[0], 240 + tier * 30, [0, 110, 230]);
      burst({
        x: a.x,
        y: a.y,
        n: 70 + tier * 35,
        speed: [200, 820],
        size: [9, 24],
        life: [0.7, 1.4],
        colors: [pal[0], pal[1], [1, 1, 1]],
        grav: 300,
      });
      if (tier >= 3) {
        for (let i = 0; i < tier - 1; i += 1) {
          later(i * 70, () =>
            spawnBolt([a.x, a.y], randomEdgePoint(), whiten(pal[0], 0.4), {
              life: 0.24,
              width: 8,
            }),
          );
        }
      }
      if (tier === 5) {
        stormUntil = Math.max(stormUntil, simT + 1.2);
        flash([1, 1, 1], 0.8, 3);
      }
      shake = Math.max(shake, 7 + tier * 3);
    },

    "combo-break"() {
      setTier(0);
      heatTarget *= 0.25;
      if (doc.hidden) return;
      const a = anchor(true);
      shatterGlass(a.x, a.y);
      flash([0.7, 0.85, 1], 0.55, 3.2);
      shake = Math.max(shake, 16);
      burst({
        x: a.x,
        y: a.y,
        n: 60,
        speed: [120, 520],
        size: [8, 16],
        life: [0.7, 1.4],
        colors: [
          [0.7, 0.85, 1],
          [0.9, 0.95, 1],
          [0.5, 0.6, 0.8],
        ],
        grav: 700,
      });
      circlePulse(a, [0.7, 0.85, 1], 200, [0]);
      const body = doc.body;
      if (body) {
        body.classList.add("hype-break");
        win.clearTimeout(breakTimer);
        breakTimer = win.setTimeout(
          () => body.classList.remove("hype-break"),
          1400,
        );
      }
    },

    milestone(ev) {
      const n = Math.max(0, Math.round(Number(ev.n) || 0));
      heatTarget = Math.max(heatTarget, 0.7);
      if (doc.hidden) return;
      const theme = milestoneTheme(n);
      showBigText(n.toLocaleString("en-US"), theme, { dur: 2.9 });
      const g = hexToRgb(theme.glow);
      warp = Math.max(warp, 2);
      flash(g, 0.5, 1.8);
      later(200, () => {
        const a = anchor(true);
        for (let i = 0; i < 3; i += 1) {
          spawnBolt([a.x, a.y], randomEdgePoint(), whiten(g, 0.4), {
            life: 0.25,
            width: 8,
          });
        }
      });
    },

    countdown(ev) {
      const left = Math.round(Number(ev.left));
      const rgb = hexToRgb(COUNTDOWN_COLORS[left] ?? 0xff5a2f);
      heatTarget = Math.max(heatTarget, 0.5);
      if (doc.hidden) return;
      const a = anchor(true);
      launchPunch(left, rgb);
      const urgency = left <= 3 ? 1.4 : 1;
      circlePulse(a, rgb, 200 * urgency, [0, 150, 300]);
      burst({
        x: a.x,
        y: a.y,
        n: 40,
        speed: [160, 560],
        size: [9, 20],
        life: [0.5, 1],
        colors: [rgb, whiten(rgb, 0.5)],
        grav: 200,
      });
      flash(rgb, 0.35 + (4 - Math.min(left, 4)) * 0.1, 2.5);
      shake = Math.max(shake, left <= 3 ? 12 : 6);
    },

    finished() {
      heatTarget = 1;
      stormUntil = simT + 6;
      if (doc.hidden) return;
      const a = anchor(true);
      const gold = hexToRgb(0xffd23f);
      for (let i = 0; i < 16; i += 1) {
        later(250 + i * 340 + rand(-80, 80), launchFirework);
      }
      showBigText(
        "DONE!",
        { top: 0xfff8d6, bottom: 0xff9a1f, glow: 0xffd23f },
        { dur: 3.6, scaleCap: 0.46 },
      );
      flash(gold, 0.7, 1.4);
      circlePulse(a, gold, 320, [0, 180, 360, 540]);
      warp = Math.max(warp, 2.5);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 70; i += 1) {
          const ang = side < 0 ? rand(0.5, 1.2) : Math.PI - rand(0.5, 1.2);
          const sp = rand(500, 1100);
          confettiPiece(
            side * (W / 2 - 10),
            -H / 2 + 10,
            Math.cos(ang) * sp,
            Math.sin(ang) * sp,
            {
              life: rand(2.5, 4),
              drag: 0.9,
              grav: 360,
            },
          );
        }
      }
      shake = Math.max(shake, 14);
    },

    ahead() {
      heatTarget = Math.max(heatTarget, 0.55);
      if (doc.hidden) return;
      const a = anchor(true);
      const gold = hexToRgb(0xffd23f);
      circlePulse(a, gold, 230, [0, 120]);
      burst({
        x: a.x,
        y: a.y,
        n: 50,
        speed: [140, 520],
        size: [10, 22],
        life: [0.8, 1.5],
        colors: [gold, [1, 1, 0.8]],
        kind: 2,
        lift: 140,
        grav: 150,
      });
      flash(gold, 0.35, 2.4);
      shake = Math.max(shake, 6);
    },

    subs(ev) {
      const added = Math.max(1, Math.round(Number(ev.added) || 1));
      heatTarget = Math.max(heatTarget, 0.45);
      if (doc.hidden) return;
      launchMeteor(`+${added}`);
    },

    idle(ev) {
      const seconds = Number(ev.seconds) || 20;
      idleLevel = seconds >= 90 ? 1 : seconds >= 45 ? 0.66 : 0.38;
      idleStart = simT;
      idleUntil = simT + 4 + idleLevel * 6;
      idleBeatAt = simT;
    },

    form() {
      if (doc.hidden) return;
      const a = anchor(true);
      const red = hexToRgb(GRADE_COLORS.sloppy);
      circlePulse(a, red, 200, [0, 120]);
      flash(red, 0.4, 3);
      shake = Math.max(shake, 7);
      burst({
        x: a.x,
        y: a.y,
        n: 22,
        speed: [100, 380],
        size: [8, 16],
        life: [0.5, 1],
        colors: [red, [1, 0.3, 0.2]],
        grav: 500,
      });
    },
  };

  function handle(events) {
    if (disposed) return;
    const list = Array.isArray(events) ? events : events ? [events] : [];
    for (const ev of list) {
      if (!ev || typeof ev.type !== "string") continue;
      if (!Object.hasOwn(handlers, ev.type)) continue;
      try {
        handlers[ev.type](ev);
      } catch (err) {
        console.warn("hype-stage: effect failed", ev.type, err);
      }
    }
    wake();
  }

  function setCount({ done = 0, owed = 0 } = {}) {
    progress = owed > 0 ? clamp(done / owed) : 0;
  }

  function warmUp() {
    const probeMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhongMaterial({
        vertexColors: true,
        shininess: 160,
        specular: 0xffffff,
        emissive: new THREE.Color(0x000000),
      }),
    );
    const probeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const targets = [
      aura,
      rings[0].mesh,
      bolts[0].mesh,
      glass.mesh,
      flashVig.mesh,
      idleVig.mesh,
      popSprite,
      probeMesh,
      probeSprite,
    ];
    const was = targets.map((t) => t.visible);
    targets.forEach((t) => {
      t.visible = true;
    });
    scene.add(probeMesh, probeSprite);
    const finish = () => {
      scene.remove(probeMesh, probeSprite);
      probeMesh.geometry.dispose();
      probeMesh.material.dispose();
      probeSprite.material.dispose();
    };
    try {
      const pending = renderer.compileAsync
        ? renderer.compileAsync(scene, camera)
        : Promise.resolve(renderer.compile(scene, camera));
      targets.forEach((t, i) => {
        t.visible = was[i];
      });
      pending.catch(() => {}).finally(finish);
    } catch {
      targets.forEach((t, i) => {
        t.visible = was[i];
      });
      finish();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    win.removeEventListener("resize", resize);
    doc.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    win.clearTimeout(breakTimer);
    doc.body?.classList.remove("hype-break");
    if (readout) readout.style.translate = "";
    schedule.length = 0;
    if (big) {
      scene.remove(big.mesh);
      big.geo.dispose();
      big.material.dispose();
      big.glowSprite.material.dispose();
      big = null;
    }
    for (const item of [...sprites]) removeSprite(item);
    for (const entry of labelCache.values()) entry.texture.dispose();
    labelCache.clear();
    for (const resource of disposables) resource.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  win.addEventListener("resize", resize);
  doc.addEventListener("visibilitychange", onVisibility);
  warmUp();
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  resize();
  setTier(0);
  loadFont();
  lastActivityAt = win.performance.now();
  start();

  return { handle, setCount, dispose };
}
