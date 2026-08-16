import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import { createAnthropicIncrementalEncoder } from "../../src/protocols/anthropic/encoder.js";
import { createStreamLifecycle } from "../../src/routes/stream-lifecycle.js";
import { pumpStream, type IncrementalEncoder } from "../../src/routes/stream-pump.js";

const base = { requestId: "req_pump", timestamp: "2026-08-15T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };

function textEvents(count: number): CanonicalEvent[] {
  const out: CanonicalEvent[] = [
    { ...base, sequence: 0, type: "response-started", responseId: "msg_pump" },
    { ...base, sequence: 1, type: "content-started", index: 0, contentType: "text" },
  ];
  for (let i = 0; i < count; i += 1) out.push({ ...base, sequence: 2 + i, type: "text-delta", index: 0, text: `chunk${i}` });
  out.push({ ...base, sequence: 2 + count, type: "content-completed", index: 0 });
  out.push({ ...base, sequence: 3 + count, type: "response-completed", stopReason: "end_turn" });
  return out;
}

const frame = (wire: { event: string; data: Record<string, unknown> }): string => `event: ${wire.event}\ndata: ${JSON.stringify(wire.data)}\n\n`;

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function pumpOptions(overrides: {
  lifecycle: ReturnType<typeof createStreamLifecycle>;
  encoder?: IncrementalEncoder<{ event: string; data: Record<string, unknown> }>;
  source?: AsyncIterable<CanonicalEvent>;
  errorFrame?: (error: unknown) => string;
  onComplete?: () => void | Promise<void>;
  onFinished?: (metrics: ReturnType<typeof createStreamLifecycle>["metrics"] extends (...args: never) => infer R ? R : never) => void;
}) {
  return {
    lifecycle: overrides.lifecycle,
    encoder: overrides.encoder ?? createAnthropicIncrementalEncoder(),
    frame,
    errorFrame: (error: unknown) => `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : "upstream failed" } })}\n\n`,
    timeoutFrame: (category: "setup" | "idle") => `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "timeout_error", message: `timeout:${category}` } })}\n\n`,
    ...(overrides.errorFrame === undefined ? {} : { errorFrame: overrides.errorFrame }),
    ...(overrides.onComplete === undefined ? {} : { onComplete: overrides.onComplete }),
    ...(overrides.onFinished === undefined ? {} : { onFinished: overrides.onFinished }),
  };
}

describe("single-pass stream pump (#120)", () => {
  it("emits only new frames in order and finishes exactly once on normal completion", async () => {
    const lifecycle = createStreamLifecycle({ clientSignal: new AbortController().signal });
    let onCompleteCalls = 0;
    let onFinishedCalls = 0;
    let finishedMetrics: unknown;
    const chunks = await collect(pumpStream(textEvents(50), {
      ...pumpOptions({ lifecycle, onComplete: async () => { onCompleteCalls += 1; }, onFinished: (m) => { onFinishedCalls += 1; finishedMetrics = m; } }),
    }));
    expect(onCompleteCalls).toBe(1);
    expect(onFinishedCalls).toBe(1);
    expect(lifecycle.metrics().terminalKind).toBe("completed");
    // onFinished receives the finished snapshot (durationMs is a live value).
    expect(finishedMetrics).toMatchObject({ terminalKind: "completed", eventCount: lifecycle.metrics().eventCount, frameCount: lifecycle.metrics().frameCount });
    expect(chunks.join("")).toContain('"type":"message_start"');
    expect(chunks.join("")).toContain('"type":"message_stop"');
    expect(chunks).toHaveLength(5 + 50); // start + block start + 50 deltas + block stop + (delta + stop)
  });

  it("emits frames up to the failure then a single error frame", async () => {
    const lifecycle = createStreamLifecycle({ clientSignal: new AbortController().signal });
    // Malformed stream: content-completed without content-started throws mid-push.
    const malformed: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "msg_pump" },
      { ...base, sequence: 1, type: "content-completed", index: 0 },
    ];
    const chunks = await collect(pumpStream(malformed, pumpOptions({ lifecycle })));
    // message_start emitted before the failing event, then exactly one error frame.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"type":"message_start"');
    expect(chunks[1]).toContain("Content completed before start");
    expect(lifecycle.metrics().terminalKind).toBe("error");
  });

  it("an onComplete failure terminates the stream with an error frame", async () => {
    const lifecycle = createStreamLifecycle({ clientSignal: new AbortController().signal });
    const chunks = await collect(pumpStream(textEvents(2), pumpOptions({
      lifecycle,
      onComplete: async () => { throw new Error("continuation store failed"); },
    })));
    const last = chunks[chunks.length - 1];
    expect(last).toContain("continuation store failed");
    expect(lifecycle.metrics().terminalKind).toBe("error");
  });

  it("client disconnect emits no frames after cancellation and records cancelled", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    const aborting: AsyncIterable<CanonicalEvent> = {
      async *[Symbol.asyncIterator]() {
        for (const item of textEvents(100)) {
          yield item;
          if (client.signal.aborted) throw client.signal.reason instanceof Error ? client.signal.reason : new Error("aborted");
        }
      },
    };
    const pump = pumpStream(aborting, pumpOptions({ lifecycle }));
    const iterator = pump[Symbol.asyncIterator]();
    // Consume a few frames, then disconnect mid-stream.
    let received = 0;
    for (let i = 0; i < 3; i += 1) { const next = await iterator.next(); if (next.done) break; received += 1; }
    client.abort();
    const rest: string[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value as string);
    // No error frames after cancellation and no partial frames.
    expect(rest.every((chunk) => !chunk.includes('"error"'))).toBe(true);
    expect(lifecycle.metrics().terminalKind).toBe("cancelled");
    expect(received + rest.length).toBeLessThan(100);
  });

  it("an upstream that ignores abort is stopped by the terminal check (no frames after cancel)", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal });
    const ignoresAbort: AsyncIterable<CanonicalEvent> = {
      async *[Symbol.asyncIterator]() {
        for (const item of textEvents(1_000)) yield item; // never checks the signal
      },
    };
    const pump = pumpStream(ignoresAbort, pumpOptions({ lifecycle }));
    const iterator = pump[Symbol.asyncIterator]();
    let received = 0;
    for (let i = 0; i < 3; i += 1) { const next = await iterator.next(); if (next.done) break; received += 1; }
    client.abort();
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) received += 1;
    // The pump stopped pulling once the client disconnected, even though the
    // upstream never observes the signal.
    expect(received).toBeLessThan(1_000);
    expect(lifecycle.metrics().terminalKind).toBe("cancelled");
  });

  it("timeout emits exactly one in-band error frame and terminates", async () => {
    const lifecycle = createStreamLifecycle({ clientSignal: new AbortController().signal, policy: { setupTimeoutMs: 10, idleTimeoutMs: 60_000 } });
    // Upstream that never yields: setup timeout fires while the pump waits.
    const hanging: AsyncIterable<CanonicalEvent> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          lifecycle.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
      },
    };
    const chunks = await collect(pumpStream(hanging, pumpOptions({ lifecycle })));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("timeout:setup");
    expect(lifecycle.metrics().terminalKind).toBe("timeout");
    expect(lifecycle.metrics().timeoutCategory).toBe("setup");
  });

  it("idle timeout fires on upstream stall and reports the idle category", async () => {
    const lifecycle = createStreamLifecycle({ clientSignal: new AbortController().signal, policy: { setupTimeoutMs: 60_000, idleTimeoutMs: 10 } });
    const events = textEvents(2);
    const stalling: AsyncIterable<CanonicalEvent> = {
      async *[Symbol.asyncIterator]() {
        yield events[0];
        yield events[1];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          lifecycle.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
      },
    };
    const chunks = await collect(pumpStream(stalling, pumpOptions({ lifecycle })));
    expect(chunks[chunks.length - 1]).toContain("timeout:idle");
    expect(lifecycle.metrics().terminalKind).toBe("timeout");
    expect(lifecycle.metrics().timeoutCategory).toBe("idle");
  });

  it("exactly-once termination: timers cleared and listeners removed after finish", async () => {
    const client = new AbortController();
    const lifecycle = createStreamLifecycle({ clientSignal: client.signal, policy: { setupTimeoutMs: 5, idleTimeoutMs: 5 } });
    const chunks = await collect(pumpStream(textEvents(3), pumpOptions({ lifecycle })));
    expect(chunks.length).toBeGreaterThan(0);
    const finished = lifecycle.metrics();
    expect(finished.terminalKind).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No new terminal recorded and no timer fired after finish.
    expect(lifecycle.metrics().terminalKind).toBe("completed");
    expect(lifecycle.metrics().eventCount).toBe(finished.eventCount);
    expect(lifecycle.metrics().frameCount).toBe(finished.frameCount);
  });
});
