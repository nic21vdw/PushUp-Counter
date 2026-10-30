import test from "node:test";
import assert from "node:assert/strict";
import {
  hudModel,
  CelebrationGate,
  trackingQuality,
  clock,
} from "../public/js/scene-hud.js";

const session = (over = {}) => ({
  phase: "active",
  setNumber: 2,
  setReps: 7,
  streak: 7,
  sessionBest: 12,
  target: 50,
  requireArm: true,
  milestones: [
    { at: 25, label: "Chat picks the next game", reached: false },
    { at: 100, label: "Century", reached: false },
  ],
  celebrations: [],
  boss: {
    name: "Gravity Golem",
    hp: 30,
    maxHp: 50,
    stage: "Cracking",
    stageIndex: 1,
  },
  ...over,
});

test("the scene reads DONE / TARGET with reps in flight already counted", () => {
  const hud = hudModel({ done: 19, session: session() }, { pendingReps: 1 });
  assert.equal(hud.big, "20");
  assert.equal(hud.targetText, "/ 50");
  assert.equal(hud.phaseText, "SET 2 LIVE");
  assert.match(
    hud.progressText,
    /^30 to go · next: Chat picks the next game at 25/,
  );
  assert.deepEqual(
    hud.ticks.map((t) => t.pct),
    [50],
  );
});

test("rest shows a timer, a scene pause says paused, a finished goal says so", () => {
  const now = Date.parse("2026-10-30T20:00:00Z");
  const rest = hudModel(
    {
      done: 5,
      session: session({
        phase: "rest",
        restStartedAt: "2026-10-30T19:58:55Z",
      }),
    },
    { now },
  );
  assert.equal(rest.phaseText, "RESTING 1:05");
  const scene = hudModel(
    { done: 5, session: session({ phase: "rest", pausedBy: "scene" }) },
    { now },
  );
  assert.equal(scene.phaseText, "PAUSED");
  const done = hudModel({ done: 50, session: session({ phase: "ready" }) });
  assert.equal(done.phaseText, "GOAL COMPLETE");
});

test("tracking uncertainty is a word on screen, and never touches the number", () => {
  const hud = hudModel(
    { done: 9, session: session() },
    { tracking: "holding" },
  );
  assert.equal(hud.trackText, "TRACKING…");
  assert.equal(hud.big, "9");
  const ready = hudModel(
    { done: 9, session: session({ phase: "ready" }) },
    { tracking: "holding" },
  );
  assert.equal(ready.trackText, null);
  const off = hudModel({ done: 9, session: session() }, { cameraDown: true });
  assert.equal(off.trackText, "CAMERA OFF · COUNT SAVED");
});

test("the legacy countdown display still works", () => {
  const hud = hudModel(
    { done: 3, rawLeft: 7, session: session() },
    { display: "left" },
  );
  assert.equal(hud.big, "7");
  assert.equal(hud.targetText, null);
});

test("celebrations already on the server when the page loads are never replayed", () => {
  const gate = new CelebrationGate();
  const old = { session: { celebrations: [{ id: "a", kind: "boss" }] } };
  assert.deepEqual(gate.take(old), []);
  assert.deepEqual(gate.take(old), []);
  const fresh = {
    session: { celebrations: [{ id: "a" }, { id: "b", kind: "milestone" }] },
  };
  assert.deepEqual(
    gate.take(fresh).map((c) => c.id),
    ["b"],
  );
  assert.deepEqual(gate.take(fresh), []);
});

test("tracking quality only names a fix the measurements support", () => {
  assert.equal(
    trackingQuality({ framing: null, tracking: "searching", sampleRate: 30 })
      .level,
    "none",
  );
  const far = trackingQuality({
    framing: {
      ok: false,
      code: "too-far",
      message: "Move closer to the camera.",
    },
    tracking: "locked",
    sampleRate: 30,
  });
  assert.deepEqual(far, { level: "poor", text: "Move closer to the camera." });
  assert.equal(
    trackingQuality({
      framing: { ok: true, code: "ok" },
      tracking: "locked",
      sampleRate: 30,
    }).level,
    "good",
  );
  assert.equal(
    trackingQuality({
      framing: { ok: true, code: "ok" },
      tracking: "locked",
      sampleRate: 6,
    }).level,
    "poor",
  );
  assert.equal(clock(65_000), "1:05");
});
