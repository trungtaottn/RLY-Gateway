import type { CanonicalEvent } from "../core/canonical-event.js";
import type { StreamLifecycle, StreamMetrics } from "./stream-lifecycle.js";

/**
 * Minimal incremental encoder contract shared by both protocol routes (#120).
 * A per-stream encoder consumes one canonical event at a time and returns only
 * the new wire frames that event produces; `finish()` validates terminal
 * protocol state on a clean stream end.
 */
export interface IncrementalEncoder<Wire> {
  push(event: CanonicalEvent): readonly Wire[];
  finish(): void;
}

export type StreamPumpOptions<Wire> = Readonly<{
  lifecycle: StreamLifecycle;
  encoder: IncrementalEncoder<Wire>;
  /** Formats one wire frame as a downstream chunk (e.g. SSE framing). */
  frame(wire: Wire): string;
  /** Formats an upstream/protocol error as a downstream frame. */
  errorFrame(error: unknown): string;
  /** Formats the policy timeout as a downstream frame (client still connected). */
  timeoutFrame(timeoutCategory: "setup" | "idle"): string;
  /**
   * Runs after a clean, complete stream (before it ends) — e.g. continuation
   * persistence. An error here terminates the stream with an error frame.
   */
  onComplete?: () => void | Promise<void>;
  /** Runs exactly once when the stream terminates (any path). */
  onFinished?: (metrics: StreamMetrics) => void;
}>;

/**
 * Single-pass stream pump (#120): consumes upstream canonical events, feeds
 * each to the incremental encoder, and yields ONLY the new frames — never a
 * re-encode of prior output. Backpressure is expressed by suspending at
 * `yield` (the downstream readable stops pulling while it is backed up, so the
 * upstream is paused and buffering stays bounded by the readable high-water
 * mark). Client disconnect and policy timeouts surface through the lifecycle
 * signal: no frames are emitted after cancellation, a timeout emits exactly
 * one in-band error frame while the client is still connected, and every
 * terminal path (completion, error, timeout, disconnect, teardown) cleans up
 * exactly once in `finally`.
 */
export async function* pumpStream<Wire>(source: Iterable<CanonicalEvent> | AsyncIterable<CanonicalEvent>, options: StreamPumpOptions<Wire>): AsyncIterable<string> {
  const { lifecycle, encoder } = options;
  let cleanEnd = false;
  try {
    for await (const event of source) {
      if (lifecycle.isTerminated()) break;
      lifecycle.noteEvent();
      const frames = encoder.push(event);
      if (lifecycle.isTerminated()) break;
      for (const wire of frames) {
        const chunk = options.frame(wire);
        if (lifecycle.isTerminated()) break;
        yield chunk;
        lifecycle.noteFrame();
      }
      lifecycle.noteEventDone();
    }
    // The upstream exhausted naturally only when no terminal condition
    // interrupted the loop (break on cancel/timeout must not count).
    cleanEnd = lifecycle.terminal === undefined;
    if (lifecycle.terminal === undefined) {
      encoder.finish();
      await options.onComplete?.();
    }
  } catch (error) {
    cleanEnd = false;
    const terminal = lifecycle.terminal;
    if (terminal?.kind === "cancelled") return;
    if (terminal?.kind === "timeout") {
      yield options.timeoutFrame(terminal.timeoutCategory);
      return;
    }
    yield options.errorFrame(error);
  } finally {
    lifecycle.finish(cleanEnd ? "completed" : "error", cleanEnd);
    options.onFinished?.(lifecycle.metrics());
  }
}
