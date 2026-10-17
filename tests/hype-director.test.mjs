/**
 * The hype director decides what a set means: streaks, milestones, countdowns,
 * taunts. It is pure, so every rule is tested with a hand-driven clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HypeDirector,
  isMilestone,
  COMBO_GAP_MS,
  COMBO_TIERS,
  FAST_GAP_MS,
  SLOW_GAP_MS,
} from "../public/js/hype-director.js";

function session({ left = 100, owed = left, done = 0 } = {}) {
  const clock = { t: 10_000 };
  const state = { left, owed, done };
  const director = new HypeDirector({ now: () => clock.t, random: () => 0.5 });
  const all = [];
  const keep = (events) => {
    all.push(...events);
    return events;
  };
  return {
    director,
    clock,
    state,
    all,
    start: () => keep(director.start({ ...state })),
    rep(gap = 2000, rep = { grade: "good", score: 75 }) {
      clock.t += gap;
      state.left -= 1;
      state.done += 1;
      return keep(director.rep({ at: clock.t, ...state, rep }));
    },
    tick(ms) {
      clock.t += ms;
      return keep(director.tick(clock.t));
    },
    count(patch) {
      Object.assign(state, patch);
      return keep(director.count({ ...state }));
    },
    repsTo(target, gap = 2000) {
      const out = [];
      while (state.left > target) out.push(...this.rep(gap));
      return out;
    },
  };
}

const types = (events) => events.map((e) => e.type);
const only = (events, type) => events.filter((e) => e.type === type);

test("start announces itself once and only once", () => {
  const s = session();
  const first = s.start();
  assert.deepEqual(types(first), ["start"]);
  assert.equal(first[0].left, 100);
  assert.equal(first[0].done, 0);
  assert.deepEqual(s.start(), []);
});

test("a rep event carries the whole picture", () => {
  const s = session({ left: 50 });
  s.start();
  const [event] = s.rep(2000, { grade: "perfect", score: 97 });
  assert.equal(event.type, "rep");
  assert.equal(event.combo, 1);
  assert.equal(event.grade, "perfect");
  assert.equal(event.score, 97);
  assert.equal(event.speed, "steady");
  assert.equal(event.left, 49);
  assert.equal(event.done, 1);
  assert.equal(event.heat, s.director.heat);
});

test("an ungraded rep has no grade and never earns a form event", () => {
  const s = session();
  s.start();
  const out = [];
  for (let i = 0; i < 6; i++) out.push(...s.rep(2000, null));
  const reps = only(out, "rep");
  assert.equal(reps.length, 6);
  for (const event of reps) {
    assert.equal(event.grade, null);
    assert.equal(event.score, null);
  }
  assert.equal(only(out, "form").length, 0);
});

test("rep speed comes from the gap to the previous rep", () => {
  const speedAfter = (gap) => {
    const s = session();
    s.start();
    s.rep(2000);
    return s.rep(gap)[0].speed;
  };
  assert.equal(speedAfter(FAST_GAP_MS - 1), "fast");
  assert.equal(speedAfter(500), "fast");
  assert.equal(speedAfter(FAST_GAP_MS), "steady");
  assert.equal(speedAfter(2000), "steady");
  assert.equal(speedAfter(SLOW_GAP_MS), "steady");
  assert.equal(speedAfter(SLOW_GAP_MS + 1), "slow");
  assert.equal(speedAfter(3400), "slow");
});

test("the first rep, and the first one back from a break, are not slow", () => {
  const s = session();
  s.start();
  assert.equal(s.rep(30_000)[0].speed, "steady");
  assert.equal(s.rep(12_000)[0].speed, "steady", "twelve seconds is a rest");
});

test("a combo is consecutive reps each under the gap limit", () => {
  const s = session();
  s.start();
  for (let i = 1; i <= 8; i++) {
    assert.equal(
      s.rep(COMBO_GAP_MS - 1).find((e) => e.type === "rep").combo,
      i,
    );
  }
  assert.equal(s.director.combo, 8);
  const restart = s.rep(COMBO_GAP_MS).find((e) => e.type === "rep");
  assert.equal(restart.combo, 1, "a gap of exactly the limit ends the streak");
});

test("a slow but steady pusher still builds a combo", () => {
  const s = session();
  s.start();
  const out = [];
  for (let i = 0; i < 12; i++) out.push(...s.rep(3000));
  assert.equal(s.director.combo, 12);
  assert.deepEqual(
    only(out, "combo").map((e) => e.combo),
    [5, 10],
  );
  assert.ok(
    only(out, "rep")
      .slice(1)
      .every((e) => e.speed === "slow"),
  );
});

test("combo tiers fire on 5, 10, 20, 35 and 50, once each", () => {
  const s = session({ left: 200 });
  s.start();
  const out = [];
  for (let i = 0; i < 60; i++) out.push(...s.rep(1500));
  const tiers = only(out, "combo");
  assert.deepEqual(
    tiers.map((e) => [e.tier, e.combo]),
    [
      [1, 5],
      [2, 10],
      [3, 20],
      [4, 35],
      [5, 50],
    ],
  );
  assert.deepEqual(COMBO_TIERS, [5, 10, 20, 35, 50]);
});

test("a rebuilt streak earns its tiers again", () => {
  const s = session({ left: 200 });
  s.start();
  for (let i = 0; i < 6; i++) s.rep(1500);
  s.tick(COMBO_GAP_MS + 100);
  const out = [];
  for (let i = 0; i < 5; i++) out.push(...s.rep(1500));
  assert.equal(only(out, "combo").length, 1);
});

test("a streak of five or more broken by a pause says so, once", () => {
  const s = session();
  s.start();
  for (let i = 0; i < 7; i++) s.rep(1500);
  assert.deepEqual(s.tick(COMBO_GAP_MS - 600), [], "not yet");
  const broke = s.tick(700);
  assert.deepEqual(types(broke), ["combo-break"]);
  assert.equal(broke[0].combo, 7);
  assert.equal(s.director.combo, 0);
  assert.deepEqual(s.tick(1000), [], "once, not every tick");
});

test("a short streak ends quietly", () => {
  const s = session();
  s.start();
  for (let i = 0; i < 4; i++) s.rep(1500);
  assert.deepEqual(s.tick(COMBO_GAP_MS + 500), []);
  assert.equal(s.director.combo, 0);
});

test("a long pause noticed only by the next rep still breaks the streak first", () => {
  const s = session();
  s.start();
  for (let i = 0; i < 6; i++) s.rep(1500);
  const out = s.rep(6000);
  assert.deepEqual(types(out), ["combo-break", "rep"]);
  assert.equal(out[0].combo, 6);
  assert.equal(out[1].combo, 1);
});

test("a break already announced by a tick is not announced again by the rep", () => {
  const s = session();
  s.start();
  for (let i = 0; i < 6; i++) s.rep(1500);
  s.tick(4000);
  assert.deepEqual(types(s.rep(3000)), ["rep"]);
});

test("isMilestone is 10, 25, 50, 75, 100 and then every 50", () => {
  for (const n of [10, 25, 50, 75, 100, 150, 200, 1000]) {
    assert.ok(isMilestone(n), String(n));
  }
  for (const n of [0, 1, 9, 11, 20, 60, 80, 99, 101, 125, 175, 199]) {
    assert.ok(!isMilestone(n), String(n));
  }
});

test("milestones fire on session reps, exactly once each", () => {
  const s = session({ left: 1000 });
  s.start();
  const out = [];
  for (let i = 0; i < 260; i++) out.push(...s.rep(1500));
  assert.deepEqual(
    only(out, "milestone").map((e) => e.n),
    [10, 25, 50, 75, 100, 150, 200, 250],
  );
});

test("milestones are not repeated when subscribers bounce the count", () => {
  const s = session({ left: 30 });
  s.start();
  const out = [];
  for (let i = 0; i < 9; i++) out.push(...s.rep());
  s.count({ owed: s.state.owed + 5, left: s.state.left + 5 });
  out.push(...s.rep());
  out.push(...s.count({ left: s.state.left + 1 }));
  out.push(...s.count({ left: s.state.left - 1 }));
  for (let i = 0; i < 5; i++) out.push(...s.rep());
  assert.deepEqual(
    only(out, "milestone").map((e) => e.n),
    [10],
  );
});

test("the countdown calls 10, 5, 3, 2, 1 as the number comes down", () => {
  const s = session({ left: 14 });
  s.start();
  const out = s.repsTo(0);
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [10, 5, 3, 2, 1],
  );
});

test("a set that starts inside the countdown does not announce numbers above it", () => {
  const s = session({ left: 7 });
  s.start();
  const out = s.repsTo(0);
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [5, 3, 2, 1],
  );
});

test("subscribers arriving mid-countdown do not replay numbers already called", () => {
  const s = session({ left: 12 });
  s.start();
  const out = s.repsTo(5);
  out.push(...s.count({ owed: s.state.owed + 3, left: s.state.left + 3 }));
  out.push(...s.repsTo(2));
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [10, 5, 3, 2],
    "5 is called once even though left passed through it twice",
  );
});

test("left wobbling upward while reps settle does not replay a number", () => {
  const s = session({ left: 6 });
  s.start();
  const out = s.rep();
  out.push(...s.count({ left: 6 }));
  out.push(...s.rep());
  out.push(...s.count({ left: 5 }));
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [5],
  );
});

test("a big jump back above ten starts a fresh countdown", () => {
  const s = session({ left: 4 });
  s.start();
  s.repsTo(2);
  s.count({ owed: s.state.owed + 20, left: s.state.left + 20 });
  const out = s.repsTo(1);
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [10, 5, 3, 2, 1],
  );
});

test("a number jumped over is skipped silently, not announced late", () => {
  const s = session({ left: 12 });
  s.start();
  const out = s.count({ left: 4, done: 8 });
  assert.deepEqual(only(out, "countdown"), []);
  const next = s.repsTo(2);
  assert.deepEqual(
    only(next, "countdown").map((e) => e.left),
    [3, 2],
  );
});

test("a display-only page hears the countdown through count() alone", () => {
  const s = session({ left: 11 });
  s.start();
  const out = [];
  for (let left = 10; left >= 0; left--) {
    out.push(...s.count({ left, done: 11 - left }));
  }
  assert.deepEqual(
    only(out, "countdown").map((e) => e.left),
    [10, 5, 3, 2, 1],
  );
  assert.equal(only(out, "finished").length, 1);
});

test("finished fires when left crosses to zero, and carries the done count", () => {
  const s = session({ left: 3 });
  s.start();
  const out = s.repsTo(0);
  const finished = only(out, "finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].done, 3);
  assert.equal(finished[0].left, 0);
  assert.equal(types(out).at(-1), "finished");
});

test("finished fires only on the transition", () => {
  const s = session({ left: 2 });
  s.start();
  s.repsTo(0);
  const after = [];
  for (let i = 0; i < 4; i++) after.push(...s.rep());
  assert.equal(only(after, "finished").length, 0);
  assert.equal(s.director.combo > 0, true);
});

test("starting with nothing left is not finishing", () => {
  const s = session({ left: 0, owed: 0 });
  assert.deepEqual(types(s.start()), ["start"]);
  assert.deepEqual(s.count({ left: 0 }), []);
  assert.equal(only(s.tick(5000), "finished").length, 0);
});

test("finished is not repeated by left wobbling back over zero", () => {
  const s = session({ left: 1 });
  s.start();
  const out = s.rep();
  out.push(...s.count({ left: 1 }));
  out.push(...s.count({ left: 0 }));
  assert.equal(only(out, "finished").length, 1);
});

test("finishing again after more subscribers arrive is a new finish", () => {
  const s = session({ left: 1 });
  s.start();
  s.rep();
  s.count({ owed: s.state.owed + 2, left: 2 });
  const out = s.repsTo(0);
  assert.equal(only(out, "finished").length, 1);
});

test("ahead fires every five reps past zero", () => {
  const s = session({ left: 1 });
  s.start();
  const out = [];
  for (let i = 0; i < 13; i++) out.push(...s.rep());
  assert.deepEqual(
    only(out, "ahead").map((e) => e.ahead),
    [5, 10],
  );
  assert.equal(s.state.left, -12);
});

test("ahead is not repeated when unconfirmed reps make left wobble", () => {
  const s = session({ left: 0, owed: 0 });
  s.start();
  const out = [];
  for (let i = 0; i < 5; i++) out.push(...s.rep());
  out.push(...s.count({ left: -4 }));
  out.push(...s.count({ left: -5 }));
  assert.deepEqual(
    only(out, "ahead").map((e) => e.ahead),
    [5],
  );
});

test("subscribers cutting into a lead only re-announce new ground", () => {
  const s = session({ left: 0, owed: 0 });
  s.start();
  for (let i = 0; i < 10; i++) s.rep();
  s.count({ owed: 4, left: -6 });
  const out = [];
  for (let i = 0; i < 4; i++) out.push(...s.rep());
  assert.deepEqual(only(out, "ahead"), [], "back to ten ahead is not news");
  out.push(...s.rep());
  out.push(...s.rep());
  out.push(...s.rep());
  out.push(...s.rep());
  out.push(...s.rep());
  assert.deepEqual(
    only(out, "ahead").map((e) => e.ahead),
    [15],
  );
});

test("falling behind and getting ahead again is worth announcing again", () => {
  const s = session({ left: 0, owed: 0 });
  s.start();
  for (let i = 0; i < 5; i++) s.rep();
  s.count({ owed: 20, left: 15 });
  const out = [];
  for (let i = 0; i < 20; i++) out.push(...s.rep());
  assert.deepEqual(
    only(out, "ahead").map((e) => e.ahead),
    [5],
  );
});

test("subs are spotted by owed rising, with the amount", () => {
  const s = session({ left: 20 });
  s.start();
  const out = s.count({ owed: 23, left: 23 });
  assert.deepEqual(types(out), ["subs"]);
  assert.equal(out[0].added, 3);
  assert.equal(out[0].left, 23);
});

test("left rising on its own is not a subscriber", () => {
  const s = session({ left: 20 });
  s.start();
  assert.deepEqual(s.count({ left: 22 }), []);
  assert.deepEqual(s.count({ left: 20 }), []);
});

test("subs still count when the owner is ahead and left does not move", () => {
  const s = session({ left: 0, owed: 0 });
  s.start();
  for (let i = 0; i < 3; i++) s.rep();
  const out = s.count({ owed: 2, left: -1 });
  assert.equal(only(out, "subs")[0].added, 2);
});

test("owed falling is not a subscriber", () => {
  const s = session({ left: 20 });
  s.start();
  assert.deepEqual(s.count({ owed: 15, left: 15 }), []);
});

test("subs reported alongside a rep are not lost, or doubled", () => {
  const s = session({ left: 20 });
  s.start();
  s.state.owed += 4;
  const out = s.rep();
  assert.equal(only(out, "subs")[0].added, 4);
  assert.deepEqual(s.count({}), []);
});

test("idle taunts arrive at 20, 45 and 90 seconds, once each", () => {
  const s = session({ left: 30 });
  s.start();
  assert.deepEqual(s.tick(19_999), []);
  assert.deepEqual(
    s.tick(1).map((e) => [e.type, e.seconds]),
    [["idle", 20]],
  );
  assert.deepEqual(s.tick(5000), []);
  assert.deepEqual(
    s.tick(20_000).map((e) => [e.type, e.seconds]),
    [["idle", 45]],
  );
  assert.deepEqual(s.tick(44_999), []);
  assert.deepEqual(
    s.tick(1).map((e) => [e.type, e.seconds]),
    [["idle", 90]],
  );
  assert.deepEqual(s.tick(600_000), [], "and then it lets you be");
});

test("a tick that sleeps through two thresholds speaks only the latest", () => {
  const s = session({ left: 30 });
  s.start();
  const out = s.tick(100_000);
  assert.deepEqual(
    out.map((e) => e.seconds),
    [90],
  );
});

test("a rep restarts the idle clock", () => {
  const s = session({ left: 30 });
  s.start();
  s.tick(19_000);
  s.rep(500);
  assert.deepEqual(s.tick(19_000), []);
  assert.equal(s.tick(1_000)[0]?.seconds, 20);
});

test("nobody is taunted for idling when nothing is left to do", () => {
  const s = session({ left: 1 });
  s.start();
  s.repsTo(0);
  assert.deepEqual(s.tick(120_000), []);
});

test("subscribers arriving after a finished set restart the idle clock", () => {
  const s = session({ left: 1 });
  s.start();
  s.repsTo(0);
  s.tick(300_000);
  s.count({ owed: s.state.owed + 5, left: 5 });
  assert.deepEqual(s.tick(10_000), []);
  assert.equal(s.tick(10_000)[0]?.seconds, 20);
});

test("three sloppy reps in a row earn a form warning", () => {
  const s = session();
  s.start();
  const out = [];
  for (let i = 0; i < 3; i++)
    out.push(...s.rep(2000, { grade: "sloppy", score: 20 }));
  const form = only(out, "form");
  assert.equal(form.length, 1);
  assert.equal(form[0].grade, "sloppy");
  assert.equal(types(out).at(-1), "form");
});

test("one good rep resets the sloppy run", () => {
  const s = session();
  s.start();
  const out = [];
  for (const grade of ["sloppy", "sloppy", "good", "sloppy", "sloppy"]) {
    out.push(...s.rep(2000, { grade, score: 40 }));
  }
  assert.equal(only(out, "form").length, 0);
});

test("a long run of sloppy reps warns every third, not every rep", () => {
  const s = session();
  s.start();
  const out = [];
  for (let i = 0; i < 7; i++)
    out.push(...s.rep(2000, { grade: "sloppy", score: 10 }));
  assert.equal(only(out, "form").length, 2);
});

test("heat starts cold and rises with a fast streak", () => {
  const s = session({ left: 200 });
  s.start();
  assert.equal(s.director.heat, 0);
  let previous = 0;
  for (let i = 0; i < 6; i++) {
    s.rep(900);
    assert.ok(s.director.heat > previous, `rep ${i + 1} added heat`);
    previous = s.director.heat;
  }
  for (let i = 0; i < 30; i++) s.rep(900);
  assert.ok(
    s.director.heat > 0.8,
    `fast streak only reached ${s.director.heat}`,
  );
  assert.ok(s.director.heat <= 1);
});

test("a fast pace runs hotter than a slow one", () => {
  const heatAfter = (gap) => {
    const s = session({ left: 200 });
    s.start();
    for (let i = 0; i < 20; i++) s.rep(gap);
    return s.director.heat;
  };
  const fast = heatAfter(900);
  const steady = heatAfter(2000);
  const slow = heatAfter(3200);
  assert.ok(fast > steady, `fast ${fast} vs steady ${steady}`);
  assert.ok(steady > slow, `steady ${steady} vs slow ${slow}`);
  assert.ok(slow > 0, "even slow reps warm it a little");
});

test("a longer streak is hotter than a short one at the same pace", () => {
  const heatAfter = (reps) => {
    const s = session({ left: 200 });
    s.start();
    for (let i = 0; i < reps; i++) s.rep(1800);
    return s.director.heat;
  };
  assert.ok(heatAfter(25) > heatAfter(3));
});

test("heat cools smoothly while idle and reaches zero", () => {
  const s = session({ left: 200 });
  s.start();
  for (let i = 0; i < 30; i++) s.rep(900);
  let previous = s.director.heat;
  assert.ok(previous > 0.8);
  let reachedZero = false;
  for (let i = 0; i < 90; i++) {
    s.tick(1000);
    const now = s.director.heat;
    assert.ok(now <= previous, `tick ${i} heated up`);
    assert.ok(now >= 0);
    assert.ok(previous - now < 0.2, "no cliff");
    previous = now;
    if (now === 0) reachedZero = true;
  }
  assert.ok(reachedZero, "it goes fully cold");
});

test("heat never leaves 0..1 whatever it is fed", () => {
  const s = session({ left: 1000 });
  s.start();
  for (let i = 0; i < 300; i++) {
    s.rep(300, { grade: "perfect", score: 100 });
    assert.ok(s.director.heat >= 0 && s.director.heat <= 1);
  }
  assert.equal(s.director.heat, 1);
});

test("a tick before anything has happened is harmless", () => {
  const director = new HypeDirector({ now: () => 5 });
  assert.deepEqual(director.tick(1000), []);
  assert.equal(director.combo, 0);
  assert.equal(director.heat, 0);
});

test("a rep before start still works and announces nothing it cannot know", () => {
  const director = new HypeDirector({ now: () => 0 });
  const out = director.rep({ at: 1000, left: 9, done: 1, owed: 10, rep: null });
  assert.deepEqual(types(out), ["rep"]);
  const next = director.rep({
    at: 3000,
    left: 8,
    done: 2,
    owed: 10,
    rep: null,
  });
  assert.deepEqual(types(next), ["rep"]);
});

test("every event carries the current left and done", () => {
  const s = session({ left: 14 });
  s.start();
  s.repsTo(0);
  for (let i = 0; i < 12; i++) s.rep(1000, { grade: "sloppy", score: 5 });
  s.count({ owed: s.state.owed + 3, left: s.state.left + 3 });
  s.tick(200_000);
  assert.ok(s.all.length > 30);
  for (const event of s.all) {
    assert.equal(typeof event.type, "string");
    assert.ok(Number.isFinite(event.left), `${event.type} has no left`);
    assert.ok(Number.isFinite(event.done), `${event.type} has no done`);
  }
});

test("the same inputs always give the same events", () => {
  const run = () => {
    const s = session({ left: 40 });
    s.start();
    for (let i = 0; i < 45; i++) {
      s.rep(i % 7 === 0 ? 3900 : 1200 + (i % 5) * 300, {
        grade: i % 4 === 0 ? "sloppy" : "great",
        score: 60 + (i % 30),
      });
      if (i % 9 === 0)
        s.count({ owed: s.state.owed + 2, left: s.state.left + 2 });
      if (i % 11 === 0) s.tick(6000);
    }
    return s.all;
  };
  assert.deepEqual(run(), run());
});
