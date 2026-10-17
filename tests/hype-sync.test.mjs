import test from "node:test";
import assert from "node:assert/strict";

import {
  hypeState,
  repsToReplay,
  observeServer,
  within,
} from "../public/js/hype-sync.js";
import { HypeDirector } from "../public/js/hype-director.js";

test("pending reps come off what is left and onto what is done", () => {
  assert.deepEqual(hypeState({ rawLeft: 12, left: 12, done: 8, owed: 20 }, 2), {
    left: 10,
    done: 10,
    owed: 20,
  });
  assert.equal(
    hypeState({ rawLeft: -3, left: 0, done: 23, owed: 20 }).left,
    -3,
  );
  assert.equal(hypeState({ left: 5, done: 1, owed: 6 }).left, 5);
});

test("with no server state the director is told nothing, not zeros", () => {
  assert.deepEqual(hypeState(null, 3), {});
  const director = new HypeDirector({ now: () => 0 });
  director.start(hypeState(null));
  const events = director.count(hypeState({ rawLeft: 57, done: 0, owed: 57 }));
  assert.deepEqual(
    events.filter((event) => event.type === "subs"),
    [],
    "the first real figures are not 57 new subscribers",
  );
});

test("a display-only page replays a few reps, never a flood", () => {
  assert.equal(repsToReplay({ done: 4 }, { done: 5 }), 1);
  assert.equal(repsToReplay({ done: 4 }, { done: 400 }), 5);
  assert.equal(repsToReplay({ done: 4 }, { done: 400 }, 2), 2);
  assert.equal(repsToReplay({ done: 9 }, { done: 9 }), 0);
  assert.equal(
    repsToReplay({ done: 9 }, { done: 0 }),
    0,
    "a reset replays nothing",
  );
  assert.equal(repsToReplay(null, { done: 9 }), 0);
  assert.equal(repsToReplay({ done: 9 }, null), 0);
  assert.equal(repsToReplay({ done: "x" }, { done: 9 }), 0);
});

test("a push with a rep still in flight does not call the countdown early", () => {
  const director = new HypeDirector({ now: () => 0 });
  director.start({ left: 5, done: 15, owed: 20 });
  director.rep({ at: 0, left: 4, done: 16, owed: 20 });

  const afterBanking = { rawLeft: 4, left: 4, done: 16, owed: 20 };
  assert.deepEqual(observeServer(director, afterBanking, 1), []);

  const doubled = director.count(hypeState(afterBanking, 1));
  assert.ok(
    doubled.some((event) => event.type === "countdown" && event.left === 3),
    "counting the rep twice is what the skip avoids",
  );
});

test("once the request is answered the same figures are observed", () => {
  const director = new HypeDirector({ now: () => 0 });
  director.start({ left: 5, done: 15, owed: 20 });
  director.rep({ at: 0, left: 4, done: 16, owed: 20 });
  const answered = { rawLeft: 4, left: 4, done: 16, owed: 20 };
  assert.deepEqual(observeServer(director, answered, 0), []);
  const subs = observeServer(
    director,
    { rawLeft: 7, left: 7, done: 16, owed: 23 },
    0,
  );
  assert.deepEqual(
    subs.map((event) => [event.type, event.added]),
    [["subs", 3]],
  );
});

test("within gives the answer when it comes in time", async () => {
  assert.equal(await within(Promise.resolve("stage"), 50, "late"), "stage");
});

test("within gives the fallback when the answer hangs", async () => {
  const never = new Promise(() => {});
  assert.equal(await within(never, 10, "late"), "late");
  assert.equal(await within(never, 10), null);
});

test("within passes a rejection through", async () => {
  await assert.rejects(within(Promise.reject(new Error("cdn")), 50), /cdn/);
});
