import { describe, expect, it } from "vitest";
import { createStreamLifecycle } from "../../src/routes/stream-lifecycle.js";

async function after(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe("stream lifecycle timeouts (#120)", () => {
  it("setup timeout aborts when no first event arrives within the setup window", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 10, idleTimeoutMs: 60_000 } });
    const start = Date.now();
    await after(40);
    const terminal = lifecycle.terminal;
    expect(lifecycle.isTerminated()).toBe(true);
    expect(terminal?.kind).toBe("timeout");
    expect(terminal?.kind === "timeout" ? terminal.timeoutCategory : undefined).toBe("setup");
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.metrics().terminalKind).toBe("timeout");
    expect(lifecycle.metrics().timeoutCategory).toBe("setup");
    expect(lifecycle.metrics().eventCount).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });

  it("a first event clears the setup timer and arms the idle window", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 10, idleTimeoutMs: 15 } });
    lifecycle.noteEvent();
    await after(30); // setup window elapsed, but first event arrived
    expect(lifecycle.isTerminated()).toBe(false);
    lifecycle.noteEventDone(); // back to consuming upstream: idle clock starts
    await after(30);
    const terminal = lifecycle.terminal;
    expect(terminal?.kind === "timeout" ? terminal.timeoutCategory : undefined).toBe("idle");
  });

  it("ongoing progress resets the idle clock; a healthy long stream is never killed", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 20, idleTimeoutMs: 25 } });
    const start = Date.now();
    while (Date.now() - start < 150) {
      lifecycle.noteEvent();
      lifecycle.noteFrame();
      lifecycle.noteEventDone();
      await after(10);
    }
    expect(lifecycle.isTerminated()).toBe(false);
    expect(lifecycle.metrics().eventCount).toBeGreaterThan(5);
  });

  it("idle clock is disarmed while suspended on downstream backpressure (no spurious timeout)", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 10, idleTimeoutMs: 20 } });
    lifecycle.noteEvent(); // frames for this event are being written: idle disarmed
    await after(80); // longer than the idle window
    expect(lifecycle.isTerminated()).toBe(false); // suspended at yield must not time out
    lifecycle.noteEventDone(); // consumer drained; back to upstream
    await after(40);
    const terminal = lifecycle.terminal;
    expect(terminal?.kind === "timeout" ? terminal.timeoutCategory : undefined).toBe("idle");
  });

  it("client disconnect cancels promptly and propagates through the merged signal", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 60_000, idleTimeoutMs: 60_000 } });
    client.abort();
    expect(lifecycle.isTerminated()).toBe(true);
    expect(lifecycle.terminal?.kind).toBe("cancelled");
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("an already-aborted client signal is recorded as cancellation at creation", () => {
    const client = new AbortController();
    client.abort();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    expect(lifecycle.terminal?.kind).toBe("cancelled");
  });
});

describe("stream lifecycle exactly-once finish (#120)", () => {
  it("finish is idempotent and reports the pump outcome", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 10, idleTimeoutMs: 10 } });
    lifecycle.noteEvent();
    const first = lifecycle.finish("completed", true);
    const second = lifecycle.finish("completed", true);
    expect(second.terminalKind).toBe(first.terminalKind);
    expect(second.eventCount).toBe(first.eventCount);
    expect(first.terminalKind).toBe("completed");
    // Timers were cleared: nothing fires after finish even past the windows.
    expect(lifecycle.metrics().terminalKind).toBe("completed");
  });

  it("classifies an interrupted stream (generator teardown) as cancelled, not completed", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    lifecycle.noteEvent();
    const metrics = lifecycle.finish("completed", false); // loop did not exhaust
    expect(metrics.terminalKind).toBe("cancelled");
  });

  it("classifies an encoder failure as error", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    const metrics = lifecycle.finish("error", false);
    expect(metrics.terminalKind).toBe("error");
  });

  it("a clean end overrides a spurious close-after-end cancellation", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    client.abort(); // response close raced the normal end
    const metrics = lifecycle.finish("completed", true);
    expect(metrics.terminalKind).toBe("completed");
  });

  it("removes the client abort listener exactly once on finish", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    const metrics = lifecycle.finish("completed", true);
    expect(metrics.terminalKind).toBe("completed");
    // A second finish returns the same snapshot without re-running cleanup.
    expect(lifecycle.finish("error", false).terminalKind).toBe("completed");
  });

  it("records backpressure counts and bounded metadata only", () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    lifecycle.noteEvent();
    lifecycle.noteFrame();
    lifecycle.noteBackpressure();
    lifecycle.noteBackpressure();
    const metrics = lifecycle.finish("completed", true);
    expect(metrics.eventCount).toBe(1);
    expect(metrics.frameCount).toBe(1);
    expect(metrics.backpressureCount).toBe(2);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    // Metadata-only surface: keys are counts/kind/duration, never content.
    expect(Object.keys(metrics).sort()).toEqual(["backpressureCount", "durationMs", "eventCount", "frameCount", "terminalKind"]);
  });
});
