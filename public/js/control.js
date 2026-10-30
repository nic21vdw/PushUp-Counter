/**
 * Nic's control panel. Never shown on stream: sets, rest, corrections, goal,
 * milestones, thresholds and the event log. Every change goes through
 * `/api/control`; the server decides what it means for the count.
 */

import { CounterClient } from "./counter-client.js";
import { DEFAULT_OPTIONS } from "./rep-counter.js";
import { clock } from "./scene-hud.js";

const $ = (id) => document.getElementById(id);
const format = (n) => Number(n).toLocaleString("en-US");
const deg = (v) => (v === null || v === undefined ? "—" : `${Math.round(v)}°`);

let state = null;
let editingMilestones = false;
let formsFilled = false;

function say(text, tone = "ok") {
  $("message").textContent = text;
  $("message").dataset.tone = tone;
}

const client = new CounterClient({
  onState: (next) => {
    state = next;
    render();
  },
  onConnection: (up) => {
    $("offline").hidden = up;
  },
});

async function act(action, body = {}, done = null) {
  try {
    await client.control(action, body);
    if (done) say(done);
  } catch (err) {
    say(err.message, "error");
  }
}

const KIND = {
  camera: "Camera",
  "chat-correction": "Chat says it counted",
  "manual-plus": "+1 by hand",
  "manual-minus": "−1 by hand",
  undo: "Undo",
  "set-start": "Set started",
  "set-finish": "Set finished",
  rest: "Rest",
  "scene-away": "Paused: scene off",
  resume: "Resumed",
  goal: "Goal",
  "reset-set": "Set reset",
  "reset-stream": "Stream reset",
  "undo-reset": "Reset undone",
};
const MANUAL = new Set([
  "chat-correction",
  "manual-plus",
  "manual-minus",
  "undo",
  "undo-reset",
  "reset-set",
]);

function render() {
  if (!state) return;
  const s = state.session;
  $("done").textContent = format(state.done);
  $("target").textContent = s.target !== null ? `/ ${format(s.target)}` : "";

  let phase = s.phase;
  let text = "READY";
  if (phase === "active") text = `SET ${s.setNumber} LIVE`;
  if (phase === "rest")
    text =
      s.pausedBy === "scene"
        ? "PAUSED (SCENE OFF)"
        : `RESTING ${clock(Date.now() - Date.parse(s.restStartedAt ?? s.serverNow))}`;
  if (phase === "ready" && s.complete) {
    phase = "done";
    text = "GOAL COMPLETE";
  }
  $("phase").textContent = text;
  $("phase").dataset.phase = phase;
  $("set-reps").textContent = format(s.setReps);
  $("streak").textContent = format(s.streak);
  $("set-best").textContent = format(s.setBest);
  $("session-best").textContent = format(s.sessionBest);

  $("b-start").hidden = s.phase !== "ready";
  $("b-rest").hidden = s.phase !== "active";
  $("b-resume").hidden = s.phase !== "rest";
  $("b-finish").disabled = s.phase === "ready";
  $("set-note").textContent = !s.requireArm
    ? "Counting is not tied to sets: the camera counts whenever it sees a rep."
    : s.phase === "ready"
      ? "Nothing counts until you start a set. Cutting to the scene never starts one."
      : s.phase === "rest"
        ? "Resting: movement is ignored and the streak is frozen. Resume when you are ready."
        : "Counting. Rest freezes the set; Finish ends it.";

  renderTracker(state.tracker, s);
  renderLog(s.events);
  $("b-undo-reset").hidden = !s.canUndoReset;
  $("b-undo-reset").textContent =
    s.lastResetKind === "stream" ? "Undo stream reset" : "Undo set reset";

  if (!formsFilled) fillForms(s);
  if (!editingMilestones) renderMilestones(s.milestones);
}

function renderTracker(t, s) {
  const quality = $("quality");
  if (!t) {
    quality.textContent = "NO TRACKER";
    quality.dataset.level = "none";
    $("quality-text").textContent =
      "The counting window is not open, or has not reported in the last few seconds.";
    for (const id of [
      "t-rate",
      "t-infer",
      "t-angle",
      "t-tilt",
      "t-last",
      "t-near",
    ])
      $(id).textContent = "—";
    $("t-suggest").textContent = "";
    $("b-suggest").hidden = true;
    return;
  }
  quality.textContent = (t.quality ?? "none").toUpperCase();
  quality.dataset.level = t.quality ?? "none";
  $("quality-text").textContent = t.qualityText ?? "";
  $("t-rate").textContent = t.sampleRate ? `${Math.round(t.sampleRate)}` : "—";
  $("t-infer").textContent = t.inferMs ? `${Math.round(t.inferMs)} ms` : "—";
  $("t-angle").textContent = deg(t.angle);
  $("t-tilt").textContent = deg(t.torsoTilt);
  $("t-last").textContent =
    t.lastDepth !== null ? `${deg(t.lastDepth)} → ${deg(t.lastTop)}` : "—";
  $("t-near").textContent = t.nearMisses ?? "—";

  const down = s.detection.downAngle ?? DEFAULT_OPTIONS.downAngle;
  const suggest = $("b-suggest");
  if (t.lastNearMiss !== null && t.nearMisses > 0) {
    const proposed = Math.min(150, Math.ceil(t.lastNearMiss + 3));
    $("t-suggest").textContent =
      `${t.nearMisses} dip${t.nearMisses === 1 ? "" : "s"} stopped short of ${down}°; the last reached ${deg(t.lastNearMiss)}. ` +
      "If those were real reps, this camera reads your depth shallow.";
    suggest.textContent = `Count reps down to ${proposed}°`;
    suggest.dataset.value = String(proposed);
    suggest.hidden = proposed <= down;
  } else {
    $("t-suggest").textContent =
      t.lastDepth !== null
        ? `Your last counted rep went down to ${deg(t.lastDepth)} (needs ${down}°).`
        : "";
    suggest.hidden = true;
  }
}

function renderLog(events) {
  const rows = [...events].reverse().map((e) => {
    const time = new Date(e.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const delta = e.delta > 0 ? `+${e.delta}` : e.delta < 0 ? `${e.delta}` : "";
    const tr = document.createElement("tr");
    tr.dataset.manual = MANUAL.has(e.kind) ? "1" : "0";
    tr.dataset.undone = e.undone ? "1" : "0";
    for (const [cls, text] of [
      ["", time],
      ["kind", KIND[e.kind] ?? e.kind],
      ["", delta],
      ["", e.set ? `set ${e.set}` : ""],
      ["", e.note ?? ""],
    ]) {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  });
  $("log").replaceChildren(...rows);
}

function fillForms(s) {
  formsFilled = true;
  $("goal").value = s.goal ?? "";
  for (const r of document.querySelectorAll('input[name="display"]'))
    r.checked = r.value === s.display;
  $("boss-name").value = s.bossName ?? "";
  $("require-arm").checked = s.requireArm;
  $("streak-gap").value = Math.round(s.streakGapMs / 1000);
  for (const input of document.querySelectorAll("[data-k]")) {
    const k = input.dataset.k;
    input.value = s.detection[k] ?? "";
    input.placeholder = String(DEFAULT_OPTIONS[k]);
  }
}

function renderMilestones(list) {
  const rows = list.map((m) => milestoneRow(m.at, m.label));
  $("milestones").replaceChildren(...rows);
}

function milestoneRow(at = "", label = "") {
  const row = document.createElement("div");
  row.className = "ms-row";
  const n = document.createElement("input");
  n.type = "number";
  n.min = "1";
  n.value = at;
  n.setAttribute("aria-label", "Reps");
  const t = document.createElement("input");
  t.type = "text";
  t.maxLength = 60;
  t.value = label;
  t.placeholder = "Reward, e.g. chat picks the next map";
  t.setAttribute("aria-label", "Reward");
  const x = document.createElement("button");
  x.textContent = "✕";
  x.setAttribute("aria-label", "Remove milestone");
  x.addEventListener("click", () => {
    editingMilestones = true;
    row.remove();
  });
  for (const el of [n, t])
    el.addEventListener("input", () => (editingMilestones = true));
  row.append(n, t, x);
  return row;
}

$("b-start").addEventListener("click", () => act("start", {}, "Set started."));
$("b-rest").addEventListener("click", () => act("rest", {}, "Resting."));
$("b-resume").addEventListener("click", () => act("resume", {}, "Resumed."));
$("b-finish").addEventListener("click", () =>
  act("finish", {}, "Set finished."),
);
$("b-chat").addEventListener("click", () =>
  act("chat", {}, "+1 logged as a chat correction."),
);
$("b-undo").addEventListener("click", () =>
  act("undo", {}, "Last rep undone."),
);
$("b-plus").addEventListener("click", () => act("plus", {}, "+1 by hand."));
$("b-minus").addEventListener("click", () => act("minus", {}, "−1 by hand."));
$("b-goal").addEventListener("click", () =>
  act(
    "goal",
    { goal: $("goal").value === "" ? null : Number($("goal").value) },
    "Goal saved.",
  ),
);
$("b-boss").addEventListener("click", async () => {
  const display =
    document.querySelector('input[name="display"]:checked')?.value ?? "boss";
  await act("display", { display });
  await act("boss", { name: $("boss-name").value }, "Display saved.");
});
$("b-ms-add").addEventListener("click", () => {
  editingMilestones = true;
  $("milestones").append(milestoneRow());
});
$("b-ms-save").addEventListener("click", async () => {
  const milestones = [...document.querySelectorAll(".ms-row")]
    .map((row) => {
      const [n, t] = row.querySelectorAll("input");
      return { at: Number(n.value), label: t.value };
    })
    .filter((m) => m.at > 0);
  editingMilestones = false;
  await act("milestones", { milestones }, "Milestones saved.");
});
$("b-settings").addEventListener("click", () =>
  act(
    "settings",
    {
      requireArm: $("require-arm").checked,
      streakGapMs: Number($("streak-gap").value) * 1000,
    },
    "Saved.",
  ),
);
$("b-detect").addEventListener("click", () => {
  const detection = {};
  for (const input of document.querySelectorAll("[data-k]"))
    if (input.value !== "") detection[input.dataset.k] = Number(input.value);
  act(
    "settings",
    { detection },
    "Thresholds saved. The tracker uses them now.",
  );
});
$("b-detect-clear").addEventListener("click", async () => {
  for (const input of document.querySelectorAll("[data-k]")) input.value = "";
  await act("settings", { detection: {} }, "Back to the default thresholds.");
});
$("b-suggest").addEventListener("click", () => {
  const value = Number($("b-suggest").dataset.value);
  const detection = { ...(state?.session?.detection ?? {}), downAngle: value };
  formsFilled = false;
  act("settings", { detection }, `Reps now count from ${value}°.`);
});
$("b-reset-set").addEventListener("click", () => {
  const typed = prompt(
    "This takes this set's reps off the total. Type RESET SET to confirm.",
  );
  if (typed !== null)
    act(
      "reset-set",
      { confirm: typed.trim() },
      "Set reset. Undo is available for 15 minutes.",
    );
});
$("b-reset-stream").addEventListener("click", () => {
  const typed = prompt(
    "This starts a new stream: totals go to zero. Type RESET STREAM to confirm.",
  );
  if (typed !== null)
    act("reset-stream", { confirm: typed.trim() }, "New stream started.");
});
$("b-undo-reset").addEventListener("click", () =>
  act("undo-reset", {}, "Reset undone."),
);

// Shortcuts work only while this page has focus and no field is being typed
// in, so they can never fire into OBS or a game.
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input, select, textarea")) return;
  const s = state?.session;
  if (!s) return;
  const key = event.key.toLowerCase();
  const press = (id) => {
    const b = $(id);
    if (!b.hidden && !b.disabled) b.click();
  };
  if (key === "s") press("b-start");
  else if (key === "r") press(s.phase === "rest" ? "b-resume" : "b-rest");
  else if (key === "f") press("b-finish");
  else if (key === "u") press("b-undo");
  else if (key === "c") press("b-chat");
  else if (key === "+" || key === "=") press("b-plus");
  else if (key === "-") press("b-minus");
  else return;
  event.preventDefault();
});

setInterval(() => {
  if (state?.session?.phase === "rest") render();
}, 1000);

client.connect();
