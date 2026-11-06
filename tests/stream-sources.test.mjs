import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSources,
  sourceGained,
  applyReading,
  setSourceEnabled,
  resetSourceForNewStream,
  SOURCE_IDS,
} from "../public/js/stream-sources.js";

const now = Date.parse("2026-11-06T20:00:00Z");
const fresh = () => normalizeSources(null)["twitch-subs"];

test("every source starts switched off with nothing gained", () => {
  const all = normalizeSources(undefined);
  assert.deepEqual(Object.keys(all), SOURCE_IDS);
  for (const id of SOURCE_IDS) {
    assert.equal(all[id].enabled, false);
    assert.equal(sourceGained(all[id]), 0);
  }
});

test("the first live reading is the baseline and adds nothing", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  assert.equal(
    applyReading(s, { count: 50, live: true }, { active: true, now }),
    0,
  );
  assert.equal(
    applyReading(s, { count: 53, live: true }, { active: true, now }),
    3,
  );
  assert.equal(sourceGained(s), 3);
});

test("gains while offline add nothing, and what was gained live stays", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  applyReading(s, { count: 50, live: true }, { active: true, now });
  applyReading(s, { count: 52, live: true }, { active: true, now });
  applyReading(s, { count: 58, live: false }, { active: true, now });
  assert.equal(
    sourceGained(s),
    2,
    "the 6 that came after going offline are free",
  );
  applyReading(s, { count: 59, live: false }, { active: true, now });
  applyReading(s, { count: 60, live: true }, { active: true, now });
  applyReading(s, { count: 61, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 3);
});

test("the baseline follows the count down so the next one counts", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  applyReading(s, { count: 50, live: true }, { active: true, now });
  applyReading(s, { count: 47, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 0);
  applyReading(s, { count: 48, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 1);
});

test("switching off keeps the gain, switching on again rebases", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  applyReading(s, { count: 10, live: true }, { active: true, now });
  applyReading(s, { count: 12, live: true }, { active: true, now });
  setSourceEnabled(s, false);
  applyReading(s, { count: 20, live: true }, { active: false, now });
  assert.equal(sourceGained(s), 2);
  setSourceEnabled(s, true);
  applyReading(s, { count: 20, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 2, "turning it on adds nothing by itself");
  applyReading(s, { count: 21, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 3);
});

test("a new stream clears the gain and waits for a fresh baseline", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  applyReading(s, { count: 10, live: true }, { active: true, now });
  applyReading(s, { count: 14, live: true }, { active: true, now });
  resetSourceForNewStream(s);
  assert.equal(sourceGained(s), 0);
  applyReading(s, { count: 30, live: true }, { active: true, now });
  assert.equal(sourceGained(s), 0);
});

test("a junk reading is refused and changes nothing", () => {
  const s = fresh();
  setSourceEnabled(s, true);
  applyReading(s, { count: 10, live: true }, { active: true, now });
  assert.throws(() =>
    applyReading(s, { count: Number.NaN, live: true }, { active: true, now }),
  );
  assert.equal(s.count, 10);
  assert.equal(s.baseline, 10);
});

test("saved sources are cleaned up on load", () => {
  const all = normalizeSources({
    "kick-subs": { enabled: true, count: 5.7, baseline: -1, banked: "x" },
    bogus: { enabled: true },
  });
  assert.equal(all["kick-subs"].enabled, true);
  assert.equal(all["kick-subs"].count, 5);
  assert.equal(all["kick-subs"].baseline, null);
  assert.equal(all["kick-subs"].banked, 0);
  assert.equal("bogus" in all, false);
});
