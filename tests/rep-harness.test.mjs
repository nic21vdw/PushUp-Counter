import test from "node:test";
import assert from "node:assert/strict";

import { evaluate, formatTable } from "./harness/evaluate.mjs";

test("the rep counter keeps precision and recall at 98% or better on the replay harness", () => {
  const result = evaluate();
  const table = formatTable(result);
  assert.ok(result.total.precision >= 0.98, table);
  assert.ok(result.total.recall >= 0.98, table);
  for (const row of result.rows)
    assert.ok(row.precision >= 0.95 && row.recall >= 0.95, table);
});

test("the harness labels decoys, so a counter that counts everything fails it", () => {
  const result = evaluate({
    options: { requirePlank: false, maxTorsoTiltDeg: null, downAngle: 140 },
  });
  assert.ok(result.total.precision < 0.98, formatTable(result));
});
