/**
 * The 3D layer's guard rails.
 *
 * The stage is decoration on a page that is live on stream, so what matters
 * most is that it can never get in the way: with reduced motion, with no
 * document, with no WebGL, or with three.js unreachable it must resolve to
 * null and leave the page exactly as it was. The pure helpers that pick
 * colours and tiers are covered here too; the drawing itself is eyeballed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createHypeStage,
  hasWebGL,
  GRADE_COLORS,
  TIER_PALETTES,
  TIER_AURA,
  COUNTDOWN_COLORS,
  COMBO_FLOOR,
  FONT_URL,
  hexToRgb,
  hsvToRgb,
  milestoneTheme,
  tierAfterRep,
  clamp,
  smoothstep,
  easeOutBack,
} from "../public/js/hype-stage.js";

function fakeDocument({ gl = null, throwOnCanvas = false } = {}) {
  const doc = {
    hidden: false,
    defaultView: null,
    createElement(tag) {
      if (throwOnCanvas) throw new Error("no canvas");
      if (tag !== "canvas") return {};
      return {
        getContext(kind) {
          return kind === "webgl2" || kind === "webgl" ? gl : null;
        },
      };
    },
  };
  return doc;
}

test("resolves to null when motion is reduced", async () => {
  const host = { ownerDocument: fakeDocument({ gl: {} }) };
  assert.equal(await createHypeStage(host, { reducedMotion: true }), null);
});

test("resolves to null with no host and with no document", async () => {
  assert.equal(await createHypeStage(null), null);
  assert.equal(await createHypeStage({}), null);
});

test("resolves to null when the browser reports reduced motion", async () => {
  const doc = fakeDocument({ gl: {} });
  doc.defaultView = { matchMedia: () => ({ matches: true }) };
  assert.equal(await createHypeStage({ ownerDocument: doc }), null);
});

test("resolves to null without WebGL", async () => {
  const host = { ownerDocument: fakeDocument({ gl: null }) };
  assert.equal(await createHypeStage(host), null);
  const broken = { ownerDocument: fakeDocument({ throwOnCanvas: true }) };
  assert.equal(await createHypeStage(broken), null);
});

test("resolves to null when three.js cannot be loaded", async () => {
  const host = { ownerDocument: fakeDocument({ gl: {} }) };
  assert.equal(await createHypeStage(host), null);
});

test("hasWebGL asks the throwaway canvas and releases its context", () => {
  let lost = false;
  const gl = {
    getExtension: () => ({
      loseContext: () => {
        lost = true;
      },
    }),
  };
  assert.equal(hasWebGL(fakeDocument({ gl })), true);
  assert.equal(lost, true);
  assert.equal(hasWebGL(fakeDocument({ gl: null })), false);
  assert.equal(hasWebGL(undefined), false);
});

test("hasWebGL refuses a software rasteriser and still releases its context", () => {
  const rig = (renderer) => {
    const state = { lost: false };
    const gl = {
      getExtension: (name) =>
        name === "WEBGL_debug_renderer_info"
          ? { UNMASKED_RENDERER_WEBGL: 37446 }
          : {
              loseContext: () => {
                state.lost = true;
              },
            },
      getParameter: () => renderer,
    };
    return { state, doc: fakeDocument({ gl }) };
  };

  const software = rig(
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
  );
  assert.equal(hasWebGL(software.doc), false);
  assert.equal(software.state.lost, true);

  const hardware = rig(
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  );
  assert.equal(hasWebGL(hardware.doc), true);
  assert.equal(hardware.state.lost, true);

  const unreadable = rig(undefined);
  assert.equal(hasWebGL(unreadable.doc), true);
});

test("every grade, tier and countdown number has a colour", () => {
  for (const grade of ["perfect", "great", "good", "sloppy"]) {
    assert.ok(Number.isInteger(GRADE_COLORS[grade]), grade);
  }
  assert.equal(TIER_PALETTES.length, 6);
  assert.equal(TIER_AURA.length, 6);
  assert.equal(TIER_AURA[0], 0);
  for (const left of [10, 5, 3, 2, 1]) {
    assert.ok(Number.isInteger(COUNTDOWN_COLORS[left]), String(left));
  }
  assert.match(FONT_URL, /three@0\.170\.0\/examples\/fonts\/helvetiker_bold/);
});

test("colour helpers stay in range", () => {
  assert.deepEqual(hexToRgb(0xff8000), [1, 128 / 255, 0]);
  for (const h of [0, 0.25, 0.5, 0.99, 1.7, -0.2]) {
    for (const channel of hsvToRgb(h, 0.9, 1)) {
      assert.ok(channel >= 0 && channel <= 1, `${h}: ${channel}`);
    }
  }
  assert.deepEqual(hsvToRgb(0, 1, 1), [1, 0, 0]);
});

test("milestone numbers pick the theme of the largest step reached", () => {
  assert.equal(milestoneTheme(10), milestoneTheme(24));
  assert.notEqual(milestoneTheme(10), milestoneTheme(25));
  assert.equal(milestoneTheme(50), milestoneTheme(74));
  assert.equal(milestoneTheme(100), milestoneTheme(120));
  assert.notEqual(milestoneTheme(150), milestoneTheme(100));
  assert.ok(milestoneTheme(3).glow);
});

test("a rep under the combo floor ends the streak, anything else keeps it", () => {
  assert.equal(tierAfterRep(3, COMBO_FLOOR - 1), 0);
  assert.equal(tierAfterRep(3, COMBO_FLOOR), 3);
  assert.equal(tierAfterRep(3, undefined), 3);
  assert.equal(tierAfterRep(0, 1), 0);
});

test("easing helpers are bounded where the animations need them", () => {
  assert.equal(clamp(5), 1);
  assert.equal(clamp(-5), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.ok(Math.abs(easeOutBack(0)) < 1e-9);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-9);
});
