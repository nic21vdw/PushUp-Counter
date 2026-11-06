import { RepCounter } from "../../public/js/rep-counter.js";
import { anglesFromLandmarks } from "../../public/js/pose-math.js";
import { ASPECT } from "./pose-synth.mjs";
import { SCENARIOS, SEEDS, buildScenario } from "./scenarios.mjs";

const LATE_MS = 1500;

export function replay(samples, options = {}, Counter = RepCounter) {
  const counter = new Counter(options);
  const detections = [];
  for (const s of samples) {
    const angles = anglesFromLandmarks(
      s.landmarks,
      s.worldLandmarks,
      counter.options.minVisibility,
      ASPECT,
    );
    const result = counter.update({ ...angles, timestamp: s.t });
    if (result.repCompleted) detections.push({ t: s.t, rep: result.rep });
  }
  return detections;
}

export function score({ reps, decoys }, detections) {
  const windows = reps.map((rep, i) => ({
    from: rep.bottomAt,
    to: Math.min(reps[i + 1]?.bottomAt ?? Infinity, rep.endAt + LATE_MS),
  }));
  const matched = new Array(reps.length).fill(false);
  const decoyHit = new Array(decoys.length).fill(false);
  let fp = 0;
  for (const d of detections) {
    const i = windows.findIndex(
      (w, j) => !matched[j] && d.t >= w.from && d.t < w.to,
    );
    if (i >= 0) {
      matched[i] = true;
      continue;
    }
    fp += 1;
    const k = decoys.findIndex(
      (w) => d.t >= w.startAt && d.t < w.endAt + LATE_MS,
    );
    if (k >= 0) decoyHit[k] = true;
  }
  const tp = matched.filter(Boolean).length;
  return {
    reps: reps.length,
    decoys: decoys.length,
    detected: detections.length,
    tp,
    fn: reps.length - tp,
    fp,
    tn: decoyHit.filter((hit) => !hit).length,
    missed: reps
      .filter((_, i) => !matched[i])
      .map((r) => Math.round(r.bottomAt)),
  };
}

const sum = (rows, key) => rows.reduce((total, r) => total + r[key], 0);

export function rates(row) {
  return {
    precision: row.tp + row.fp ? row.tp / (row.tp + row.fp) : 1,
    recall: row.tp + row.fn ? row.tp / (row.tp + row.fn) : 1,
  };
}

export function evaluate({
  options = {},
  seeds = SEEDS,
  names,
  Counter = RepCounter,
} = {}) {
  const rows = [];
  for (const name of names ?? Object.keys(SCENARIOS)) {
    const runs = seeds.map((seed) => {
      const scenario = buildScenario(name, seed);
      return {
        seed,
        ...score(scenario, replay(scenario.samples, options, Counter)),
      };
    });
    const row = { name };
    for (const key of ["reps", "decoys", "detected", "tp", "fn", "fp", "tn"])
      row[key] = sum(runs, key);
    row.runs = runs;
    rows.push({ ...row, ...rates(row) });
  }
  const total = { name: "total" };
  for (const key of ["reps", "decoys", "detected", "tp", "fn", "fp", "tn"])
    total[key] = sum(rows, key);
  return { rows, total: { ...total, ...rates(total) } };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

export function formatTable({ rows, total }) {
  const head = [
    "scenario",
    "true reps",
    "decoys",
    "counted",
    "TP",
    "FN",
    "FP",
    "TN",
    "precision",
    "recall",
  ];
  const line = (r) => [
    r.name,
    r.reps,
    r.decoys,
    r.detected,
    r.tp,
    r.fn,
    r.fp,
    r.tn,
    pct(r.precision),
    pct(r.recall),
  ];
  const body = [...rows.map(line), line(total)].map((cells) =>
    cells.map(String),
  );
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((c) => c[i].length)),
  );
  const fmt = (cells) =>
    `| ${cells.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(" | ")} |`;
  const rule = `|${widths.map((w, i) => (i ? "-".repeat(w + 1) + ":" : "-".repeat(w + 2))).join("|")}|`;
  return [
    fmt(head),
    rule,
    ...body.slice(0, -1).map(fmt),
    fmt(body.at(-1)),
  ].join("\n");
}
