/**
 * Talks to the push-up server on behalf of the overlay.
 *
 * The server owns the count -- this only reports reps the camera saw and listens
 * for state. Reps go up as they happen so the number ticks down live, but they
 * are queued and retried rather than fired and forgotten: dropping a rep because
 * the server blipped would quietly let you off a push-up you actually did.
 *
 * Every rep carries an id, and the ids still waiting are kept in localStorage,
 * so a report retried after a lost answer, or replayed after a reload, is
 * banked once. Corrections by hand go through `control()`, which only the
 * control panel calls.
 */

const PENDING_KEY = "pushup.pendingReps";

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class CounterClient {
  /**
   * @param {{clientId?: string|null,
   *          onState?: (state: object) => void,
   *          onError?: (message: string) => void,
   *          onPending?: (count: number) => void}} [config]
   */
  constructor({
    clientId = null,
    onState = () => {},
    onError = () => {},
    onPending = () => {},
    onConnection = () => {},
    onRefused = () => {},
  } = {}) {
    // Lets the server tell counting pages apart, so two of them counting the
    // same push-ups is visible instead of silently doubling the total.
    this.clientId = clientId;
    this.onState = onState;
    this.onError = onError;
    this.onPending = onPending;
    // Fires with false when the event stream drops and true when it is back, so
    // a page can dim rather than sit there showing a number that stopped being
    // true several minutes ago.
    this.onConnection = onConnection;
    /** Why the server turned reps away, e.g. no set running. */
    this.onRefused = onRefused;
    /** Ids of reps counted but not yet accepted by the server. */
    this.queue = this.#restore();
    this.pending = this.queue.length;
    this.flushing = false;
    this.retryTimer = null;
    this.source = null;
    this.stopped = false;
  }

  /** Subscribe to server state over SSE, reconnecting on drop. */
  connect() {
    if (this.stopped) return;
    this.source = new EventSource("/api/events");
    this.source.onmessage = (event) => {
      this.onConnection(true);
      try {
        this.onState(JSON.parse(event.data));
      } catch {
        /* ignore a malformed frame */
      }
    };
    this.source.onerror = () => {
      this.source.close();
      this.onConnection(false);
      if (this.stopped) return;
      setTimeout(() => this.connect(), 2000);
    };
  }

  /**
   * Report `reps` detected push-ups. Returns immediately; delivery is retried
   * in the background. Anything that isn't a positive whole number is ignored
   * rather than sent — the server would reject it, and there is no legitimate
   * caller for it.
   */
  reportReps(reps = 1, { bridged = false } = {}) {
    if (!Number.isInteger(reps) || reps < 1) return;
    for (let i = 0; i < reps; i += 1) this.queue.push(newId());
    if (bridged) this.bridged = (this.bridged ?? 0) + reps;
    this.#changed();
    this.#flush();
  }

  /** Send whatever a previous load of this page left queued. */
  resume() {
    if (this.queue.length) this.#flush();
  }

  #changed() {
    this.pending = this.queue.length;
    try {
      storage()?.setItem(PENDING_KEY, JSON.stringify(this.queue.slice(-50)));
    } catch {
      /* private mode or full: the in-memory queue still works */
    }
    this.onPending(this.pending);
  }

  #restore() {
    try {
      const ids = JSON.parse(storage()?.getItem(PENDING_KEY) ?? "[]");
      return Array.isArray(ids)
        ? ids.filter((v) => typeof v === "string").slice(-50)
        : [];
    } catch {
      return [];
    }
  }

  /**
   * A control-panel action. Resolves to the new state, or throws with the
   * server's sentence.
   */
  async control(action, body = {}) {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pushup-Control": "1",
      },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Server error (${res.status})`);
    this.onState(data);
    return data;
  }

  /** Tell the control panel what the camera can see. Best effort. */
  telemetry(body) {
    fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  async #flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    // Snapshot what we're sending so reps detected mid-request aren't lost.
    const ids = this.queue.slice(0, 50);
    const reps = ids.length;
    const bridged = Math.min(this.bridged ?? 0, reps);
    const sent = () => {
      this.queue = this.queue.filter((id) => !ids.includes(id));
      this.bridged = Math.max(0, (this.bridged ?? 0) - bridged);
      this.#changed();
    };
    try {
      const res = await fetch("/api/rep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reps, ids, bridged, clientId: this.clientId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A rejected report will never succeed on retry, so drop it and say so.
        if (res.status === 400) {
          sent();
          if (data.notArmed) this.onRefused(data.error ?? "No set is running.");
          else this.onError(data.error ?? "Server rejected the rep count.");
        } else {
          this.onError(
            data.error ?? `Server error (${res.status}) — retrying.`,
          );
          this.#scheduleRetry();
        }
        return;
      }

      sent();
      this.onError("");
      this.onState(data);
    } catch {
      this.onError(
        "Lost the server — reps are being held and will be sent when it is back.",
      );
      this.#scheduleRetry();
    } finally {
      this.flushing = false;
      // Anything counted while that request was in flight goes out now.
      if (this.queue.length !== 0 && this.retryTimer === null) this.#flush();
    }
  }

  #scheduleRetry() {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#flush();
    }, 2000);
  }

  /**
   * Stop talking to the server: close the event stream and abandon retries.
   *
   * Without this a client that can't reach the server retries forever, which
   * keeps a closed page alive and hangs anything embedding it.
   */
  stop() {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.source?.close();
    this.source = null;
  }
}
