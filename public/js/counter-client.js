/**
 * Talks to the push-up server on behalf of the overlay.
 *
 * The server owns the count -- this only reports reps the camera saw and listens
 * for state. Reps go up as they happen so the number ticks down live, but they
 * are queued and retried rather than fired and forgotten: dropping a rep because
 * the server blipped would quietly let you off a push-up you actually did.
 *
 * It can only ever add. There is no path here for handing a rep back.
 */

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
  reportReps(reps = 1) {
    if (!Number.isInteger(reps) || reps < 1) return;
    this.pending += reps;
    this.onPending(this.pending);
    this.#flush();
  }

  async #flush() {
    if (this.flushing || this.pending === 0) return;
    this.flushing = true;

    // Snapshot what we're sending so reps detected mid-request aren't lost.
    const reps = this.pending;
    try {
      const res = await fetch('/api/rep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reps, clientId: this.clientId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A rejected report will never succeed on retry, so drop it and say so.
        if (res.status === 400) {
          this.pending -= reps;
          this.onPending(this.pending);
          this.onError(data.error ?? 'Server rejected the rep count.');
        } else {
          this.onError(data.error ?? `Server error (${res.status}) — retrying.`);
          this.#scheduleRetry();
        }
        return;
      }

      this.pending -= reps;
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
