/**
 * Per-stream lifecycle for incremental streaming transport (#120).
 *
 * Owns: the merged upstream abort signal (client disconnect + policy
 * timeouts), the setup/idle/progress timeout policy, secret-free stream
 * metrics, and exactly-once termination of timers, abort listeners, and the
 * terminal record. It never sees prompts, responses, reasoning text, tool
 * payloads, or credentials — only event/frame counts, timing, and terminal
 * category.
 */
export type StreamTimeoutPolicy = Readonly<{
  /**
   * Connection/setup timeout: maximum time from stream start until the first
   * upstream event is consumed. A stream that produces nothing in this window
   * aborts as a setup timeout (the upstream never crossed the protocol
   * boundary).
   */
  setupTimeoutMs: number;
  /**
   * Idle/progress timeout: maximum time between upstream events while the
   * downstream is writable. The clock runs only while the stream is actively
   * consuming upstream work (never while suspended on downstream backpressure),
   * so a healthy long-lived agent stream with ongoing deltas is never killed by
   * a generic whole-request timer.
   */
  idleTimeoutMs: number;
}>;

export const DEFAULT_STREAM_TIMEOUT_POLICY: StreamTimeoutPolicy = {
  setupTimeoutMs: 30_000,
  idleTimeoutMs: 300_000,
};

export type StreamTerminal =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timeout"; timeoutCategory: "setup" | "idle" }>;

export type StreamMetrics = Readonly<{
  /** Canonical events consumed from the upstream. */
  eventCount: number;
  /** Wire frames emitted to the downstream. */
  frameCount: number;
  /** Number of times the downstream writable signalled backpressure (drain). */
  backpressureCount: number;
  /** Wall-clock stream duration in milliseconds. */
  durationMs: number;
  /** Terminal category; "none" before finish() runs. */
  terminalKind: StreamTerminal["kind"] | "none";
  /** "setup" | "idle" when terminalKind is "timeout". */
  timeoutCategory?: "setup" | "idle";
}>;

export type StreamLifecycle = Readonly<{
  /** Merged signal: client disconnect + policy timeouts. Pass to the upstream. */
  readonly signal: AbortSignal;
  /** Terminal condition recorded so far (cancelled/timeout from the lifecycle, completed/error from finish). */
  readonly terminal: StreamTerminal | undefined;
  /** True once a lifecycle terminal condition (cancellation or policy timeout) was recorded. */
  isTerminated(): boolean;
  /**
   * Called right after one upstream event is consumed. Counts the event,
   * clears the setup timer (first event) and disarms the idle timer while the
   * event's frames are being written.
   */
  noteEvent(): void;
  /** Called after one wire frame is yielded to the downstream. Counts frames. */
  noteFrame(): void;
  /** Called when the downstream writable reports backpressure (drain). */
  noteBackpressure(): void;
  /**
   * Called after all frames for one event have been written. Re-arms the idle
   * timer so an upstream that stalls mid-stream (while the downstream is
   * writable) is detected.
   */
  noteEventDone(): void;
  /**
   * Exactly-once terminal record and cleanup: clears timers, removes the
   * client abort listener, records the terminal kind (the pump's own
   * completed/error determination wins over a spurious close-after-end
   * cancellation), and aborts the merged signal.
   */
  finish(outcome: "completed" | "error", cleanEnd: boolean): StreamMetrics;
  /** Current secret-free metrics (valid before and after finish()). */
  metrics(): StreamMetrics;
}>;

export function createStreamLifecycle(options: Readonly<{
  clientSignal: AbortSignal;
  policy?: Partial<StreamTimeoutPolicy>;
}>): StreamLifecycle {
  const policy = { ...DEFAULT_STREAM_TIMEOUT_POLICY, ...options.policy };
  const startedAt = Date.now();
  const controller = new AbortController();
  let terminal: StreamTerminal | undefined = undefined;
  let eventCount = 0;
  let frameCount = 0;
  let backpressureCount = 0;
  let finished = false;
  let setupTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let unbindClient: (() => void) | undefined;

  const clearTimers = (): void => {
    if (setupTimer !== undefined) { clearTimeout(setupTimer); setupTimer = undefined; }
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
  };

  const terminate = (kind: "cancelled" | "timeout", timeoutCategory?: "setup" | "idle"): void => {
    if (terminal !== undefined) return;
    terminal = kind === "timeout" ? { kind, timeoutCategory: timeoutCategory ?? "idle" } : { kind };
    clearTimers();
    if (!controller.signal.aborted) controller.abort(new Error(kind === "timeout" ? "stream timeout" : "client disconnected"));
  };

  const onClientAbort = (): void => terminate("cancelled");

  if (options.clientSignal.aborted) {
    terminate("cancelled");
  } else {
    unbindClient = () => options.clientSignal.removeEventListener("abort", onClientAbort);
    options.clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  setupTimer = setTimeout(() => terminate("timeout", "setup"), policy.setupTimeoutMs);

  const armIdle = (): void => {
    if (terminal !== undefined || idleTimer !== undefined) return;
    idleTimer = setTimeout(() => terminate("timeout", "idle"), policy.idleTimeoutMs);
  };

  return {
    get signal(): AbortSignal { return controller.signal; },
    get terminal() { return terminal; },
    isTerminated(): boolean { return terminal !== undefined; },
    noteEvent(): void {
      eventCount += 1;
      if (setupTimer !== undefined) { clearTimeout(setupTimer); setupTimer = undefined; }
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    },
    noteFrame(): void { frameCount += 1; },
    noteBackpressure(): void { backpressureCount += 1; },
    noteEventDone(): void { armIdle(); },
    finish(outcome: "completed" | "error", cleanEnd: boolean): StreamMetrics {
      if (finished) return this.metrics();
      finished = true;
      clearTimers();
      if (unbindClient !== undefined) { unbindClient(); unbindClient = undefined; }
      if (terminal === undefined) {
        terminal = cleanEnd ? { kind: "completed" } : outcome === "error" ? { kind: "error" } : { kind: "cancelled" };
      } else if (cleanEnd && terminal.kind === "cancelled") {
        // The upstream exhausted naturally; a response-close abort that raced
        // the normal end is not a cancellation.
        terminal = { kind: "completed" };
      }
      if (!controller.signal.aborted) controller.abort();
      return this.metrics();
    },
    metrics(): StreamMetrics {
      return {
        eventCount,
        frameCount,
        backpressureCount,
        durationMs: Date.now() - startedAt,
        terminalKind: terminal?.kind ?? "none",
        ...(terminal?.kind === "timeout" ? { timeoutCategory: terminal.timeoutCategory } : {}),
      };
    },
  };
}
