/**
 * Talks to the push-up server on behalf of the camera page.
 *
 * The server owns the count -- this only reports reps and listens for state.
 * Reps are reported as they happen so the OBS overlay ticks down live, but they
 * are queued and retried rather than fired and forgotten: dropping a rep
 * because the server blipped would silently cheat you.
 */

export class CounterClient {
  /**
   * @param {{token?: string|null, clientId?: string|null,
   *          onState?: (state: object) => void,
   *          onError?: (message: string) => void,
   *          onPending?: (count: number) => void}} [config]
   */
  constructor({
    token = null,
    clientId = null,
    onState = () => {},
    onError = () => {},
    onPending = () => {},
  } = {}) {
    this.token = token;
    // Lets the server tell counting pages apart, so two of them counting the
    // same push-ups is visible instead of silently doubling the total.
    this.clientId = clientId;
    this.onState = onState;
    this.onError = onError;
    this.onPending = onPending;
    /** Reps counted but not yet accepted by the server. */
    this.pending = 0;
    this.flushing = false;
    this.retryTimer = null;
    this.source = null;
    this.stopped = false;
  }

  /** Subscribe to server state over SSE, reconnecting on drop. */
  connect() {
    if (this.stopped) return;
    this.source = new EventSource('/api/events');
    this.source.onmessage = (event) => {
      try {
        this.onState(JSON.parse(event.data));
      } catch {
        /* ignore a malformed frame */
      }
    };
    this.source.onerror = () => {
      this.source.close();
      if (this.stopped) return;
      setTimeout(() => this.connect(), 2000);
    };
  }

  /**
   * Report `count` detected push-ups. Negative corrects an over-count.
   * Returns immediately; delivery is retried in the background.
   */
  reportReps(count = 1) {
    this.pending += count;
    this.onPending(this.pending);
    this.#flush();
  }

  async #flush() {
    if (this.flushing || this.pending === 0) return;
    this.flushing = true;

    // Snapshot what we're sending so reps detected mid-request aren't lost.
    const amount = this.pending;
    try {
      const res = await fetch('/api/done', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ amount, source: 'camera', clientId: this.clientId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A rejected amount will never succeed on retry, so drop it and say so.
        if (res.status === 400) {
          this.pending -= amount;
          this.onPending(this.pending);
          this.onError(data.error ?? 'Server rejected the rep count.');
        } else if (res.status === 401) {
          this.onError('Control token missing or wrong — open this page with ?token=YOUR_TOKEN.');
          this.#scheduleRetry();
        } else {
          this.onError(data.error ?? `Server error (${res.status}) — retrying.`);
          this.#scheduleRetry();
        }
        return;
      }

      this.pending -= amount;
      this.onPending(this.pending);
      this.onError('');
      this.onState(data);
    } catch {
      this.onError('Lost the server — reps are being held and will be sent when it is back.');
      this.#scheduleRetry();
    } finally {
      this.flushing = false;
      // Anything counted while that request was in flight goes out now.
      if (this.pending !== 0 && this.retryTimer === null) this.#flush();
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
