/**
 * The hype announcer speaks director events. Speech is a browser feature that
 * cannot run here, so these tests drive it through a fake and check what it was
 * asked to say, in what voice, and what it refused to cut off.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HypeAnnouncer,
  PRIORITY,
  PROFILES,
  COMBO_PROFILES,
  HISTORY,
  MAX_QUIET_REPS,
  rankVoice,
  pickVoice,
} from "../public/js/hype-announcer.js";
import { LINES } from "../public/js/hype-lines.js";
import { HypeDirector } from "../public/js/hype-director.js";

const voice = (name, lang = "en-US") => ({ name, lang });

function fakeSpeech({ voices = [] } = {}) {
  const speech = {
    spoken: [],
    cancels: 0,
    resumes: 0,
    pauses: 0,
    speaking: false,
    pending: false,
    voices,
    listeners: {},
    order: [],
    speak(utterance) {
      speech.spoken.push(utterance);
      speech.order.push("speak");
      speech.speaking = true;
      for (const hook of ["onend", "onerror"]) {
        const inner = utterance[hook];
        utterance[hook] = (event) => {
          speech.speaking = false;
          inner?.(event);
        };
      }
    },
    cancel() {
      speech.cancels += 1;
      speech.order.push("cancel");
      speech.speaking = false;
    },
    resume() {
      speech.resumes += 1;
      speech.order.push("resume");
    },
    pause() {
      speech.pauses += 1;
    },
    getVoices: () => speech.voices,
    addEventListener(type, fn) {
      speech.listeners[type] = fn;
    },
    removeEventListener(type) {
      delete speech.listeners[type];
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  return { speech, Utterance };
}

const FIXTURE = {
  start: ["START"],
  rep: {
    perfect: ["PERFECT"],
    great: ["GREAT"],
    good: ["GOOD"],
    sloppy: ["SLOPPY"],
  },
  fast: ["FAST"],
  slow: ["SLOW"],
  combo: {
    1: ["COMBO1"],
    2: ["COMBO2"],
    3: ["COMBO3"],
    4: ["COMBO4"],
    5: ["COMBO5"],
  },
  comboBreak: ["BREAK"],
  milestone: ["MILESTONE {n}"],
  countdown: {
    10: ["TEN"],
    5: ["FIVE"],
    3: ["THREE"],
    2: ["TWO"],
    1: ["ONE"],
  },
  finished: ["FINISHED {done}"],
  ahead: ["AHEAD {ahead}"],
  subs: ["SUBS {added}"],
  idle: ["IDLE {seconds}"],
  form: ["FORM"],
};

function rig({
  lines = FIXTURE,
  voices = [],
  random = () => 0.5,
  volume,
} = {}) {
  const { speech, Utterance } = fakeSpeech({ voices });
  const clock = { t: 0 };
  const timers = [];
  const announcer = new HypeAnnouncer({
    speech,
    Utterance,
    lines,
    random,
    now: () => clock.t,
    volume,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  return { announcer, speech, clock, timers, Utterance };
}

const ev = {
  start: () => ({ type: "start", left: 20, done: 0 }),
  rep: (extra = {}) => ({
    type: "rep",
    combo: 1,
    heat: 0.2,
    grade: "good",
    score: 70,
    speed: "steady",
    left: 20,
    done: 0,
    ...extra,
  }),
  combo: (tier = 1, combo = 5) => ({
    type: "combo",
    tier,
    combo,
    left: 20,
    done: 5,
  }),
  comboBreak: () => ({ type: "combo-break", combo: 8, left: 20, done: 8 }),
  milestone: (n = 10) => ({ type: "milestone", n, left: 20, done: n }),
  countdown: (left) => ({ type: "countdown", left, done: 30 }),
  finished: () => ({ type: "finished", left: 0, done: 30 }),
  ahead: (ahead = 5) => ({
    type: "ahead",
    ahead,
    left: -ahead,
    done: 30 + ahead,
  }),
  subs: (added = 3) => ({ type: "subs", added, left: 23, done: 3 }),
  idle: (seconds = 20) => ({ type: "idle", seconds, left: 20, done: 0 }),
  form: () => ({ type: "form", grade: "sloppy", left: 20, done: 3 }),
};

/* ------------------------------------------------------------------ voices */

test("natural and neural voices beat everything else", () => {
  const voices = [
    voice("Microsoft David - English (United States)"),
    voice("Google US English"),
    voice("Microsoft Aria Online (Natural) - English (United States)"),
    voice("Google UK English Male", "en-GB"),
  ];
  assert.equal(
    pickVoice(voices).name,
    "Microsoft Aria Online (Natural) - English (United States)",
  );
  assert.equal(
    pickVoice([voice("Neural Fred"), voice("Google US English")]).name,
    "Neural Fred",
  );
});

test("the preference ladder runs natural, online, Google, then the Microsoft three", () => {
  const ladder = [
    "Microsoft Guy Online (Natural) - English (United States)",
    "Microsoft Jenny Online - English (United States)",
    "Google UK English Male",
    "Google US English",
    "Microsoft David - English (United States)",
    "Microsoft Mark - English (United States)",
    "Microsoft Zira - English (United States)",
    "Some Other English Voice",
  ];
  for (let i = 0; i < ladder.length - 1; i++) {
    const better = rankVoice(
      voice(ladder[i], ladder[i].includes("UK") ? "en-GB" : "en-US"),
    );
    const worse = rankVoice(voice(ladder[i + 1], "en-US"));
    assert.ok(better > worse, `${ladder[i]} should outrank ${ladder[i + 1]}`);
  }
});

test("voices that do not speak English are never chosen", () => {
  assert.equal(
    pickVoice([voice("Microsoft Hedda", "de-DE"), voice("Amelie", "fr-CA")]),
    null,
  );
  assert.equal(rankVoice(voice("Natural Voice", "ja-JP")), -1);
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice(undefined), null);
});

test("any English voice beats none at all", () => {
  assert.equal(
    pickVoice([voice("Dave"), voice("Hedda", "de-DE")]).name,
    "Dave",
  );
});

test("the chosen voice is the one on the utterance", () => {
  const best = voice(
    "Microsoft Guy Online (Natural) - English (United States)",
  );
  const { announcer, speech } = rig({
    voices: [voice("Microsoft David"), best],
  });
  announcer.handle([ev.start()]);
  assert.equal(speech.spoken[0].voice, best);
  assert.equal(speech.spoken[0].lang, "en-US");
  assert.equal(announcer.voiceName, best.name);
});

test("voices that load late are picked up when they arrive", () => {
  const { announcer, speech } = rig({ voices: [] });
  assert.equal(announcer.voiceName, null);
  const natural = voice("Microsoft Davis Online (Natural)");
  speech.voices = [voice("Microsoft Zira"), natural];
  speech.listeners.voiceschanged();
  assert.equal(announcer.voiceName, natural.name);
  announcer.handle([ev.start()]);
  assert.equal(speech.spoken[0].voice, natural);
});

test("a voice list that was empty at construction is asked for again on speaking", () => {
  const { announcer, speech } = rig({ voices: [] });
  speech.voices = [voice("Microsoft Mark")];
  announcer.handle([ev.start()]);
  assert.equal(speech.spoken[0].voice.name, "Microsoft Mark");
});

test("a browser that reports voices by property still gets them", () => {
  const { speech, Utterance } = fakeSpeech();
  delete speech.addEventListener;
  speech.onvoiceschanged = null;
  const announcer = new HypeAnnouncer({ speech, Utterance, lines: FIXTURE });
  assert.equal(typeof speech.onvoiceschanged, "function");
  speech.voices = [voice("Google US English")];
  speech.onvoiceschanged();
  assert.equal(announcer.voiceName, "Google US English");
});

test("disposing stops listening for voices", () => {
  const { announcer, speech } = rig();
  assert.ok(speech.listeners.voiceschanged);
  announcer.dispose();
  assert.equal(speech.listeners.voiceschanged, undefined);
});

/* ---------------------------------------------------------------- priority */

test("one line is spoken per batch, and it is the most important event", () => {
  const order = [
    ["finished", ev.finished(), "FINISHED 30"],
    ["milestone", ev.milestone(25), "MILESTONE 25"],
    ["countdown", ev.countdown(5), "FIVE"],
    ["combo", ev.combo(2, 10), "COMBO2"],
    ["subs", ev.subs(3), "SUBS 3"],
    ["combo-break", ev.comboBreak(), "BREAK"],
    ["form", ev.form(), "FORM"],
    ["idle", ev.idle(45), "IDLE 45"],
    ["rep", ev.rep({ grade: "perfect" }), "PERFECT"],
  ];
  assert.deepEqual(
    order.map(([type]) => type),
    Object.keys(PRIORITY)
      .filter((type) => order.some(([name]) => name === type))
      .sort((a, b) => PRIORITY[b] - PRIORITY[a]),
    "the table matches the documented priority",
  );
  for (let i = 0; i < order.length; i++) {
    const { announcer, speech } = rig({ random: () => 0 });
    const batch = order
      .slice(i)
      .map(([, event]) => event)
      .reverse();
    const said = announcer.handle(batch);
    assert.equal(said, order[i][2], `${order[i][0]} should win its batch`);
    assert.equal(speech.spoken.length, 1);
  }
});

test("start and ahead sit between combo and combo-break", () => {
  assert.ok(PRIORITY.combo > PRIORITY.start);
  assert.ok(PRIORITY.start > PRIORITY.subs);
  assert.ok(PRIORITY.subs > PRIORITY.ahead);
  assert.ok(PRIORITY.ahead > PRIORITY["combo-break"]);
});

test("a rep alongside a combo gets the combo line", () => {
  const { announcer } = rig({ random: () => 0 });
  assert.equal(announcer.handle([ev.rep(), ev.combo(3, 20)]), "COMBO3");
});

test("an event with no lines falls through to the next best", () => {
  const lines = { ...FIXTURE, milestone: [] };
  const { announcer } = rig({ lines });
  assert.equal(announcer.handle([ev.milestone(), ev.combo(1)]), "COMBO1");
});

test("unknown events and junk are ignored without a sound", () => {
  const { announcer, speech } = rig();
  assert.equal(announcer.handle([{ type: "mystery" }, null, undefined]), null);
  assert.equal(announcer.handle([]), null);
  assert.equal(announcer.handle(undefined), null);
  assert.equal(announcer.handle("combo"), null);
  assert.equal(speech.spoken.length, 0);
});

/* ------------------------------------------------------------- interruption */

test("a more important line cuts off a less important one that is still speaking", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.idle()]);
  assert.equal(speech.cancels, 0, "nothing to cancel the first time");
  const said = announcer.handle([ev.combo(1)]);
  assert.equal(said, "COMBO1");
  assert.equal(speech.cancels, 1);
  assert.deepEqual(speech.order.slice(-3), ["cancel", "resume", "speak"]);
  assert.equal(speech.spoken.length, 2);
});

test("a less important line never cuts off a more important one", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.finished()]);
  assert.equal(announcer.handle([ev.milestone()]), null);
  assert.equal(announcer.handle([ev.combo(1)]), null);
  assert.equal(announcer.handle([ev.idle()]), null);
  assert.equal(announcer.handle([ev.rep({ grade: "perfect" })]), null);
  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.cancels, 0);
  assert.equal(announcer.speaking, true);
});

test("lines of equal importance replace each other, except plain reps", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.countdown(3)]);
  assert.equal(announcer.handle([ev.countdown(2)]), "TWO");
  assert.equal(speech.spoken.length, 2);

  const quiet = rig({ random: () => 0 });
  quiet.announcer.handle([ev.rep()]);
  assert.equal(quiet.announcer.handle([ev.rep()]), null, "never talked over");
  assert.equal(quiet.speech.spoken.length, 1);
});

test("a plain rep line never cuts off anything", () => {
  const { announcer, speech } = rig({ random: () => 0 });
  announcer.handle([ev.idle()]);
  assert.equal(announcer.handle([ev.rep()]), null);
  assert.equal(speech.cancels, 0);
});

test("a line that has finished no longer protects itself", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.finished()]);
  speech.spoken[0].onend();
  assert.equal(announcer.speaking, false);
  assert.equal(announcer.handle([ev.idle()]), "IDLE 20");
});

test("an error ends a line the same way", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.finished()]);
  speech.spoken[0].onerror({ error: "synthesis-failed" });
  assert.equal(announcer.handle([ev.idle()]), "IDLE 20");
  assert.equal(announcer.lastError, "synthesis-failed");
});

test("an interruption is not recorded as a failure", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.idle()]);
  announcer.handle([ev.combo(1)]);
  speech.spoken[0].onerror({ error: "interrupted" });
  assert.equal(announcer.lastError, null);
});

test("a line whose end never arrives stops protecting itself after a while", () => {
  const { announcer, clock } = rig();
  announcer.handle([ev.finished()]);
  clock.t += 500;
  assert.equal(announcer.handle([ev.idle()]), null, "still plausibly speaking");
  clock.t += 20_000;
  assert.equal(announcer.speaking, false);
  assert.equal(announcer.handle([ev.idle()]), "IDLE 20");
});

test("the end of a cut-off line does not unprotect the line that replaced it", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.idle()]);
  announcer.handle([ev.countdown(3)]);
  speech.spoken[0].onerror({ error: "interrupted" });
  speech.spoken[0].onend?.();
  assert.equal(announcer.speaking, true);
  assert.equal(announcer.handle([ev.idle()]), null);
});

test("nothing is ever queued: every speak is preceded by a cancel when one is playing", () => {
  const { announcer, speech } = rig();
  for (const event of [
    ev.idle(),
    ev.form(),
    ev.subs(),
    ev.combo(1),
    ev.countdown(5),
  ]) {
    announcer.handle([event]);
  }
  assert.equal(speech.spoken.length, 5);
  assert.equal(speech.cancels, 4);
});

/* ------------------------------------------------------------- rep chatter */

function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test("plain reps are spoken on about one in three", () => {
  const { announcer, speech } = rig({ random: lcg(7) });
  let spoken = 0;
  const reps = 600;
  for (let i = 0; i < reps; i++) {
    if (announcer.handle([ev.rep({ grade: "good" })])) {
      spoken += 1;
      speech.spoken.at(-1).onend();
    }
  }
  const share = spoken / reps;
  assert.ok(
    share > 0.28 && share < 0.45,
    `spoke on ${Math.round(share * 100)}% of reps`,
  );
});

test("a run of silent reps is broken before it gets long", () => {
  const { announcer, speech } = rig({ random: () => 0.99 });
  const said = [];
  for (let i = 0; i < 40; i++) {
    const line = announcer.handle([ev.rep({ grade: "good" })]);
    said.push(Boolean(line));
    if (line) speech.spoken.at(-1).onend();
  }
  let longest = 0;
  let run = 0;
  for (const spoke of said) {
    run = spoke ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  assert.ok(longest < MAX_QUIET_REPS, `${longest} silent reps in a row`);
  assert.ok(said.some(Boolean));
});

test("perfect reps are always spoken every few", () => {
  const { announcer, speech } = rig({ random: () => 0.99 });
  const said = [];
  for (let i = 0; i < 12; i++) {
    const line = announcer.handle([ev.rep({ grade: "perfect" })]);
    said.push(Boolean(line));
    if (line) speech.spoken.at(-1).onend();
  }
  assert.deepEqual(said.filter(Boolean).length, 4);
  assert.deepEqual(said.slice(0, 3), [false, false, true]);
});

test("a spoken line of any kind resets the quiet count", () => {
  const { announcer, speech } = rig({ random: () => 0.99 });
  for (let i = 0; i < 4; i++) announcer.handle([ev.rep({ grade: "perfect" })]);
  announcer.handle([ev.milestone()]);
  speech.spoken.at(-1).onend();
  const said = [
    announcer.handle([ev.rep({ grade: "perfect" })]),
    announcer.handle([ev.rep({ grade: "perfect" })]),
  ];
  assert.deepEqual(said, [null, null]);
});

test("a fast rep can draw from the fast lines and a slow one from the slow lines", () => {
  const fast = rig({ random: () => 0 });
  assert.equal(fast.announcer.handle([ev.rep({ speed: "fast" })]), "FAST");
  const slow = rig({ random: () => 0 });
  assert.equal(slow.announcer.handle([ev.rep({ speed: "slow" })]), "SLOW");
  const grade = rig({ random: () => 0.3 });
  assert.equal(
    grade.announcer.handle([ev.rep({ speed: "steady", grade: "great" })]),
    "GREAT",
  );
});

test("an ungraded rep is spoken from the good lines", () => {
  const { announcer } = rig({ random: () => 0 });
  assert.equal(
    announcer.handle([ev.rep({ grade: null, score: null })]),
    "GOOD",
  );
});

/* --------------------------------------------------------------- no repeats */

test("a line is not repeated within the last twelve of its category", () => {
  const bank = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const lines = { ...FIXTURE, idle: bank };
  const { announcer, speech } = rig({ lines, random: lcg(3) });
  const said = [];
  for (let i = 0; i < 400; i++) {
    said.push(announcer.handle([ev.idle()]));
    speech.spoken.at(-1).onend();
  }
  for (let i = 0; i < said.length; i++) {
    const recent = said.slice(Math.max(0, i - HISTORY), i);
    assert.ok(
      !recent.includes(said[i]),
      `"${said[i]}" came back after ${recent.indexOf(said[i])}`,
    );
  }
  assert.equal(new Set(said).size, 30, "and the whole bank gets used");
});

test("a small bank is never repeated back to back", () => {
  const lines = { ...FIXTURE, form: ["a", "b", "c"] };
  const { announcer, speech } = rig({ lines, random: lcg(11) });
  let previous = null;
  for (let i = 0; i < 100; i++) {
    const line = announcer.handle([ev.form()]);
    speech.spoken.at(-1).onend();
    assert.notEqual(line, previous);
    previous = line;
  }
});

test("a bank of one still speaks", () => {
  const { announcer, speech } = rig();
  for (let i = 0; i < 3; i++) {
    assert.equal(announcer.handle([ev.start()]), "START");
    speech.spoken.at(-1).onend();
  }
});

test("categories keep separate memories", () => {
  const lines = {
    ...FIXTURE,
    rep: { ...FIXTURE.rep, perfect: ["p1", "p2"], good: ["g1", "g2"] },
  };
  const { announcer, speech } = rig({ lines, random: () => 0 });
  const first = announcer.handle([ev.rep({ grade: "perfect" }), ev.combo(1)]);
  assert.equal(first, "COMBO1");
  speech.spoken.at(-1).onend();
  const p = [];
  const g = [];
  for (let i = 0; i < 6; i++) {
    for (const [grade, into] of [
      ["perfect", p],
      ["good", g],
    ]) {
      for (let k = 0; k < MAX_QUIET_REPS; k++) {
        const line = announcer.handle([ev.rep({ grade })]);
        if (line) {
          into.push(line);
          speech.spoken.at(-1).onend();
          break;
        }
      }
    }
  }
  for (let i = 1; i < p.length; i++) assert.notEqual(p[i], p[i - 1]);
  for (let i = 1; i < g.length; i++) assert.notEqual(g[i], g[i - 1]);
  assert.ok(p.every((line) => line.startsWith("p")));
  assert.ok(g.every((line) => line.startsWith("g")));
});

/* ---------------------------------------------------------------- templates */

test("templates are filled from the event", () => {
  const lines = {
    ...FIXTURE,
    milestone: ["{n} reps, {left} to go, combo {combo}, done {done}"],
    subs: ["{added} new, {n} total"],
    idle: ["{seconds} seconds, {n}"],
    ahead: ["{ahead} ahead, {n}, {done}"],
    countdown: { ...FIXTURE.countdown, 3: ["{left} left"] },
  };
  const { announcer } = rig({ lines });
  announcer.handle([
    ev.rep({ combo: 12, left: 15, done: 40 }),
    { type: "milestone", n: 50, left: 15, done: 50 },
  ]);
  assert.equal(announcer.lastLine, "50 reps, 15 to go, combo 12, done 50");
  const say = (event) => {
    announcer.cancel();
    return announcer.handle([event]);
  };
  assert.equal(say(ev.subs(4)), "4 new, 4 total");
  assert.equal(say(ev.idle(45)), "45 seconds, 45");
  assert.equal(say(ev.ahead(10)), "10 ahead, 10, 40");
  assert.equal(say(ev.countdown(3)), "3 left");
});

test("a line that needs a number the event lacks is never spoken with a hole in it", () => {
  const lines = {
    ...FIXTURE,
    subs: ["{added} more, {mystery} too", "plain subs"],
  };
  const { announcer } = rig({ lines });
  for (let i = 0; i < 5; i++) {
    assert.equal(announcer.handle([ev.subs()]), "plain subs");
    announcer.cancel();
  }
});

test("when no line in a category can be filled, the next event gets its turn", () => {
  const lines = { ...FIXTURE, milestone: ["{mystery} reps"] };
  const { announcer } = rig({ lines });
  assert.equal(announcer.handle([ev.milestone(), ev.idle()]), "IDLE 20");
});

test("left is not spoken once there is none, because it would be a lie", () => {
  const lines = {
    ...FIXTURE,
    rep: { ...FIXTURE.rep, perfect: ["{left} to go", "no number needed"] },
  };
  const { announcer, speech } = rig({ lines, random: () => 0 });
  const said = new Set();
  for (const left of [-3, 0]) {
    for (let i = 0; i < 6; i++) {
      announcer.handle([ev.rep({ grade: "perfect", left })]);
      if (speech.spoken.at(-1)) speech.spoken.at(-1).onend();
      said.add(announcer.lastLine);
    }
  }
  assert.deepEqual([...said], ["no number needed"]);
});

function everyScenario() {
  const scenarios = [];
  for (const left of [25, 10, 3, 1, 0, -4]) {
    for (const grade of ["perfect", "great", "good", "sloppy", null]) {
      for (const speed of ["fast", "steady", "slow"]) {
        scenarios.push([ev.rep({ left, grade, speed, combo: 3 })]);
      }
    }
    scenarios.push([{ ...ev.start(), left }]);
    scenarios.push([{ ...ev.comboBreak(), left }]);
    scenarios.push([{ ...ev.milestone(50), left }]);
    scenarios.push([{ ...ev.finished(), left }]);
    scenarios.push([{ ...ev.ahead(5), left }]);
    scenarios.push([{ ...ev.subs(5), left }]);
    scenarios.push([{ ...ev.form(), left }]);
    for (const seconds of [20, 45, 90])
      scenarios.push([{ ...ev.idle(seconds), left }]);
    for (const tier of [1, 2, 3, 4, 5])
      scenarios.push([{ ...ev.combo(tier, tier * 10), left }]);
  }
  for (const left of [10, 5, 3, 2, 1]) scenarios.push([ev.countdown(left)]);
  return scenarios;
}

test("no spoken line ever contains a raw placeholder or a hole", () => {
  const { announcer, speech } = rig({ lines: LINES, random: lcg(21) });
  let spoken = 0;
  for (let round = 0; round < 40; round++) {
    for (const batch of everyScenario()) {
      const line = announcer.handle(batch);
      if (speech.spoken.at(-1)) speech.spoken.at(-1).onend();
      announcer.cancel();
      if (line === null) continue;
      spoken += 1;
      assert.ok(!/[{}]/.test(line), `"${line}" has a brace`);
      assert.ok(
        !/undefined|NaN|null|\bInfinity\b/.test(line),
        `"${line}" has a hole`,
      );
      assert.ok(line.trim().length > 0);
      assert.ok(!/ {2}/.test(line), `"${line}" has a gap where a number was`);
    }
  }
  assert.ok(spoken > 500, `only ${spoken} lines spoken`);
});

test("a real director's events can all be spoken from the real lines", () => {
  const clock = { t: 0 };
  const director = new HypeDirector({ now: () => clock.t });
  const { announcer, speech } = rig({ lines: LINES, random: lcg(5) });
  const state = { left: 26, owed: 26, done: 0 };
  const heard = new Set();
  const feed = (events) => {
    const line = announcer.handle(events);
    if (speech.spoken.at(-1)) speech.spoken.at(-1).onend();
    announcer.cancel();
    for (const e of events) heard.add(e.type);
    if (line) assert.ok(!/[{}]/.test(line), line);
  };
  feed(director.start({ ...state }));
  for (let i = 0; i < 70; i++) {
    clock.t += i % 9 === 0 ? 4000 : 900 + (i % 4) * 500;
    state.left -= 1;
    state.done += 1;
    if (i === 20) {
      state.owed += 4;
      state.left += 4;
    }
    feed(
      director.rep({
        at: clock.t,
        ...state,
        rep: {
          grade: ["perfect", "good", "sloppy", "great"][i % 4],
          score: 50 + (i % 40),
        },
      }),
    );
    if (i === 12) {
      clock.t += 25_000;
      feed(director.tick(clock.t));
    }
  }
  for (const type of [
    "start",
    "rep",
    "combo",
    "milestone",
    "countdown",
    "finished",
    "ahead",
    "subs",
    "idle",
  ]) {
    assert.ok(heard.has(type), `the scripted set never produced ${type}`);
  }
});

/* ------------------------------------------------------------------ persona */

test("each kind of line has its own delivery", () => {
  const rate = (event) => {
    const { announcer, speech } = rig({ random: () => 0.5 });
    announcer.handle([event]);
    const u = speech.spoken[0];
    return { rate: u.rate, pitch: u.pitch, volume: u.volume };
  };
  const countdown = rate(ev.countdown(5));
  const close = rate(ev.countdown(2));
  const tier1 = rate(ev.combo(1));
  const tier5 = rate(ev.combo(5, 50));
  const finished = rate(ev.finished());
  const idle = rate(ev.idle());

  assert.ok(countdown.pitch < tier1.pitch, "countdown is deeper than a combo");
  assert.ok(countdown.rate < tier1.rate, "and slower");
  assert.ok(
    close.pitch < countdown.pitch && close.rate < countdown.rate,
    "and gets more ominous",
  );
  assert.ok(
    tier5.rate > tier1.rate && tier5.pitch > tier1.pitch,
    "tier five is faster and higher",
  );
  assert.ok(finished.pitch > tier5.pitch - 0.05, "finished is huge");
  assert.ok(finished.volume > tier1.volume, "and loud");
  assert.ok(idle.pitch < 1 && idle.rate < 1, "idle taunts are sleepy");
});

test("the announcer is energetic by default", () => {
  const { announcer, speech } = rig({ random: () => 0.5 });
  announcer.handle([ev.start()]);
  const { rate, pitch } = speech.spoken[0];
  assert.ok(rate >= 1.05 && rate <= 1.15, `rate ${rate}`);
  assert.ok(pitch >= 1, `pitch ${pitch}`);
});

test("every profile stays inside what a browser will accept", () => {
  const all = [...Object.values(PROFILES), ...Object.values(COMBO_PROFILES)];
  for (const profile of all) {
    assert.ok(profile.rate >= 0.5 && profile.rate <= 2);
    assert.ok(profile.pitch >= 0 && profile.pitch <= 2);
    assert.ok(profile.boost > 0);
  }
});

test("delivery varies a little from line to line", () => {
  const { announcer, speech } = rig({ random: lcg(2) });
  const rates = new Set();
  for (let i = 0; i < 12; i++) {
    announcer.handle([ev.start()]);
    rates.add(speech.spoken.at(-1).rate);
    speech.spoken.at(-1).onend();
  }
  assert.ok(rates.size > 3);
  for (const r of rates) assert.ok(Math.abs(r - PROFILES.start.rate) <= 0.031);
});

/* ------------------------------------------------------------ volume, on/off */

test("volume scales every line and is clamped", () => {
  const { announcer, speech } = rig({ volume: 0.5 });
  announcer.handle([ev.start()]);
  assert.equal(speech.spoken[0].volume, 0.5 * PROFILES.start.boost);
  announcer.setVolume(3);
  announcer.handle([ev.finished()]);
  assert.equal(speech.spoken[1].volume, 1);
  announcer.setVolume(0);
  announcer.handle([ev.finished()]);
  assert.equal(speech.spoken[2].volume, 0);
  announcer.setVolume("junk");
  announcer.handle([ev.finished()]);
  assert.equal(speech.spoken[3].volume, 0, "junk leaves it alone");
});

test("finished is as loud as the browser goes at the default volume", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.finished()]);
  assert.equal(speech.spoken[0].volume, 1);
});

test("disabled means silent, and silences the line in progress", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.finished()]);
  announcer.setEnabled(false);
  assert.equal(speech.cancels, 1);
  assert.equal(announcer.speaking, false);
  assert.equal(announcer.handle([ev.finished()]), null);
  assert.equal(speech.spoken.length, 1);
  announcer.setEnabled(true);
  assert.equal(announcer.handle([ev.finished()]), "FINISHED 30");
});

test("lastLine is the last thing actually said", () => {
  const { announcer } = rig();
  assert.equal(announcer.lastLine, null);
  announcer.handle([ev.start()]);
  assert.equal(announcer.lastLine, "START");
  announcer.handle([ev.rep()]);
  assert.equal(
    announcer.lastLine,
    "START",
    "a rep that stayed quiet changes nothing",
  );
});

/* -------------------------------------------------------- browser workarounds */

test("speech is resumed before every line, for a backgrounded tab", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.start()]);
  speech.spoken[0].onend();
  announcer.handle([ev.idle()]);
  assert.equal(speech.resumes, 2);
  assert.deepEqual(speech.order, ["resume", "speak", "resume", "speak"]);
});

test("the utterance is kept alive until it ends", () => {
  const { announcer, speech } = rig();
  announcer.handle([ev.start()]);
  assert.equal(announcer.current.utterance, speech.spoken[0]);
  speech.spoken[0].onend();
  assert.equal(announcer.current, null);
});

test("a line long enough to hit the fifteen second cut-off is nudged along", () => {
  const long = "word ".repeat(40).trim();
  const lines = { ...FIXTURE, start: [long] };
  const { announcer, speech, timers, clock } = rig({ lines });
  announcer.handle([ev.start()]);
  assert.equal(timers.length, 1, "a keep-alive is scheduled");
  clock.t += 8000;
  timers[0].fn();
  assert.equal(speech.pauses, 1);
  assert.equal(speech.resumes, 2, "once before speaking, once as the nudge");
  assert.equal(timers.length, 2, "and it keeps nudging");
  speech.spoken[0].onend();
  assert.ok(timers.at(-1).cleared, "until the line ends");
});

test("short lines do not start a timer", () => {
  const { announcer, timers } = rig();
  announcer.handle([ev.start()]);
  assert.equal(timers.length, 0);
});

test("a keep-alive for a line that never ended gives up", () => {
  const long = "word ".repeat(40).trim();
  const { announcer, timers, clock } = rig({
    lines: { ...FIXTURE, start: [long] },
  });
  announcer.handle([ev.start()]);
  clock.t += 60_000;
  timers[0].fn();
  assert.equal(announcer.current, null);
  assert.equal(timers.length, 1);
});

/* ------------------------------------------------------------ broken browsers */

test("a browser without speech is silent, not broken", () => {
  const announcer = new HypeAnnouncer({
    speech: undefined,
    Utterance: undefined,
    lines: FIXTURE,
  });
  assert.equal(announcer.handle([ev.finished()]), null);
  announcer.setEnabled(false);
  announcer.setVolume(0.2);
  announcer.dispose();
});

test("a speech engine that throws costs the line, not the page", () => {
  const { speech, Utterance } = fakeSpeech();
  speech.speak = () => {
    throw new Error("not-allowed");
  };
  const announcer = new HypeAnnouncer({
    speech,
    Utterance,
    lines: FIXTURE,
    now: () => 0,
  });
  assert.equal(announcer.handle([ev.finished()]), null);
  assert.equal(announcer.speaking, false);
  assert.equal(announcer.lastLine, null);
});

test("a getVoices that throws is survivable", () => {
  const { speech, Utterance } = fakeSpeech();
  speech.getVoices = () => {
    throw new Error("nope");
  };
  const announcer = new HypeAnnouncer({
    speech,
    Utterance,
    lines: FIXTURE,
    now: () => 0,
  });
  assert.equal(announcer.handle([ev.start()]), "START");
  assert.equal(speech.spoken[0].voice, undefined);
});

test("missing banks in a partial lines file are tolerated", () => {
  const { announcer } = rig({ lines: { start: ["hi"] } });
  assert.equal(
    announcer.handle([ev.combo(3), ev.countdown(5), ev.rep()]),
    null,
  );
  assert.equal(announcer.handle([ev.start()]), "hi");
});
