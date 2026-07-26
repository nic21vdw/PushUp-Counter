/**
 * One status line, several things with something to say.
 *
 * The tracker source and the camera page both have a single banner and three or
 * four independent writers: the camera lifecycle, the server connection, the
 * server's own error field, and the check for a second page counting the same
 * push-ups. Handing them one shared string meant whoever spoke last won, and a
 * writer had no way to take back its own message without wiping everyone
 * else's — so the double-count warning, which had no "it stopped" branch at
 * all, stayed burnt into the OBS source for the rest of the stream.
 *
 * Each writer gets a named slot it owns. The most urgent occupied slot is the
 * one that shows.
 *
 * Kept pure and DOM-free so the precedence rules can be tested.
 */

export class StatusSlots {
  /**
   * @param {string[]} priority slot names, most urgent first
   */
  constructor(priority) {
    this.priority = [...priority];
    /** @type {Map<string, {message: string, tone: string}>} */
    this.slots = new Map();
  }

  /**
   * Set or clear one slot. A falsy message clears it — that is the whole point
   * of the exercise, so it is not treated as a no-op.
   *
   * @param {string} slot
   * @param {string} message
   * @param {string} [tone] free-form; 'error' and 'info' are what the pages use
   * @returns {{message: string, tone: string}|null} what should now be shown
   */
  set(slot, message, tone = 'error') {
    if (!this.priority.includes(slot)) {
      throw new Error(`unknown status slot: ${slot}`);
    }
    if (message) this.slots.set(slot, { message, tone });
    else this.slots.delete(slot);
    return this.current();
  }

  /** @returns {{message: string, tone: string}|null} */
  current() {
    for (const slot of this.priority) {
      const entry = this.slots.get(slot);
      if (entry) return entry;
    }
    return null;
  }
}
