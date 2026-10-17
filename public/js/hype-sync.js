/**
 * The arithmetic between the server's numbers and the hype layer.
 *
 * Pure, so the rules the overlay depends on can be tested without a page.
 */

/**
 * The figures the director and the stage are fed: the server's state with the
 * reps still on their way to it already applied. Empty before the first state
 * arrives, so the director learns nothing instead of learning zeros.
 *
 * @param {object|null} serverState
 * @param {number} [pendingReps]
 */
export function hypeState(serverState, pendingReps = 0) {
  if (!serverState) return {};
  const rawLeft = (serverState.rawLeft ?? serverState.left ?? 0) - pendingReps;
  return {
    left: rawLeft,
    done: (serverState.done ?? 0) + pendingReps,
    owed: serverState.owed ?? 0,
  };
}

/**
 * How many reps a display-only page replays when the server's done figure
 * rises. A handful at most, so a reconnect is not a fireworks show for
 * push-ups done minutes ago.
 *
 * @param {object|null} before
 * @param {object|null} state
 * @param {number} [cap]
 */
export function repsToReplay(before, state, cap = 5) {
  if (!before || !state) return 0;
  const gained = Number(state.done ?? 0) - Number(before.done ?? 0);
  return Number.isFinite(gained) && gained > 0 ? Math.min(gained, cap) : 0;
}

/**
 * Feeds a server push to the director. The event stream can deliver a rep's
 * total before the request that reported it is answered, and until then that
 * rep is counted twice, so a push with reps in flight is skipped: the answer to
 * the request carries the same figures a moment later.
 *
 * @param {{count: (state: object) => object[]}} director
 * @param {object|null} serverState
 * @param {number} pendingReps
 */
export function observeServer(director, serverState, pendingReps) {
  if (pendingReps > 0) return [];
  return director.count(hypeState(serverState, pendingReps));
}

/**
 * Resolves to whatever `promise` does, or to `fallback` after `ms`. The promise
 * keeps running after a timeout; the caller decides what a late result means.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {*} [fallback]
 * @returns {Promise<T|*>}
 */
export function within(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
