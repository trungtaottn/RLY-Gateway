import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";
import type { RouteRecord } from "../../../src/core/router.js";
import type { CanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import { encodeAnthropicSse } from "../../../src/protocols/anthropic/encoder.js";
import { encodeResponsesSse } from "../../../src/protocols/openai-responses/encoder.js";
import { registerAnthropicMessagesRoute } from "../../../src/routes/anthropic-messages-route.js";
import { registerOpenAiResponsesRoute } from "../../../src/routes/openai-responses-route.js";
import { ResponseContinuationStore } from "../../../src/protocols/openai-responses/continuation.js";

let app: FastifyInstance | undefined;
const directories: string[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const route: RouteRecord = {
  role: "primary",
  providerId: "fake",
  modelId: "fixture-model",
  adapterId: "fake",
  credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" },
  capabilities: { streaming: true, tools: true, parallelTools: false, images: true, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "exact-local" },
};

const base = { requestId: "req_route", timestamp: "2026-08-15T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };

/** Synthetic large stream: response + K text blocks with many deltas each. */
function largeStream(blocks: number, deltasPerBlock: number): CanonicalEvent[] {
  const out: CanonicalEvent[] = [{ ...base, sequence: 0, type: "response-started", responseId: "msg_large" }];
  let sequence = 1;
  for (let block = 0; block < blocks; block += 1) {
    out.push({ ...base, sequence: sequence++, type: "content-started", index: block, contentType: "text" });
    for (let delta = 0; delta < deltasPerBlock; delta += 1) out.push({ ...base, sequence: sequence++, type: "text-delta", index: block, text: `b${String(block)}d${String(delta)} ` });
    out.push({ ...base, sequence: sequence++, type: "content-completed", index: block });
  }
  out.push({ ...base, sequence: sequence++, type: "usage-updated", inputTokens: 100, outputTokens: sequence });
  out.push({ ...base, sequence: sequence, type: "response-completed", stopReason: "end_turn" });
  return out;
}

function upstreamFrom(eventsList: CanonicalEvent[]): CanonicalUpstream {
  return {
    async *invoke() {
      await Promise.resolve();
      for (const item of eventsList) yield item;
    },
  };
}

async function listen(appInstance: FastifyInstance): Promise<{ port: number; url: string }> {
  await appInstance.listen({ host: "127.0.0.1", port: 0 });
  const address = appInstance.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  return { port: address.port, url: `http://127.0.0.1:${String(address.port)}` };
}

async function consumeSlowly(res: IncomingMessage, options: { chunkDelayMs: number; pauseAfterChunks?: number; pauseMs?: number }): Promise<string> {
  let body = "";
  let count = 0;
  for await (const chunk of res) {
    body += String(chunk);
    count += 1;
    if (options.pauseAfterChunks !== undefined && count === options.pauseAfterChunks) {
      res.pause();
      await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 250));
      res.resume();
    } else {
      await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
    }
  }
  return body;
}

describe("incremental streaming routes: byte-equivalence and O(N) soak (#120)", () => {
  it("Anthropic streamed body is byte-identical to the batch encoder output", async () => {
    const eventsList = largeStream(8, 40);
    app = Fastify();
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: upstreamFrom(eventsList) });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: "fixture" }], stream: true } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(encodeAnthropicSse(eventsList));
  });

  it("Responses streamed body is byte-identical to the batch encoder output and persists continuation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-incremental-responses-"));
    directories.push(directory);
    const eventsList = largeStream(4, 20);
    app = Fastify();
    registerOpenAiResponsesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: upstreamFrom(eventsList), continuation: new ResponseContinuationStore(directory) });
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(encodeResponsesSse(eventsList));
    const stored = await app.inject({ method: "GET", url: "/v1/responses/msg_large" });
    expect(stored.statusCode).toBe(200);
  });

  it("soak: thousands of events stream linearly to a byte-identical body", async () => {
    const eventsList = largeStream(50, 60); // 3100+ events
    app = Fastify();
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: upstreamFrom(eventsList) });
    const start = Date.now();
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "fixture-model", max_tokens: 100_000, messages: [{ role: "user", content: "fixture" }], stream: true } });
    expect(response.body).toBe(encodeAnthropicSse(eventsList));
    // Linear work: a 3000+ event stream completes in bounded time (generous
    // bound to keep CI stable; the point is it does not blow up superlinearly).
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("incremental streaming routes: timeout policies (#120)", () => {
  it("setup timeout emits one in-band error frame when the upstream never starts", async () => {
    app = Fastify();
    const hanging: CanonicalUpstream = {
      async *invoke(_request, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
        yield { ...base, sequence: 0, type: "response-started", responseId: "msg_hang" };
      },
    };
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: hanging, streamTimeouts: { setupTimeoutMs: 30, idleTimeoutMs: 60_000 } });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "fixture-model", max_tokens: 10, messages: [{ role: "user", content: "fixture" }], stream: true } });
    expect(response.body).toContain("setup window");
    expect(response.body).toContain('"type":"error"');
    // Exactly one frame (the timeout error) and nothing after it.
    expect(response.body.split("\n\n")).toHaveLength(2);
  });

  it("idle timeout emits one in-band error frame when the upstream stalls mid-stream", async () => {
    const eventsList = largeStream(2, 3);
    app = Fastify();
    const stalling: CanonicalUpstream = {
      async *invoke(_request, signal) {
        for (const item of eventsList) {
          yield item;
          if (item.type === "text-delta" && item.text.startsWith("b1")) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 5_000);
              signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
            });
          }
        }
      },
    };
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: stalling, streamTimeouts: { setupTimeoutMs: 60_000, idleTimeoutMs: 30 } });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "fixture-model", max_tokens: 10, messages: [{ role: "user", content: "fixture" }], stream: true } });
    expect(response.body).toContain("idle window");
    const frames = response.body.split("\n\n").filter((frame) => frame.length > 0);
    // Frames up to the stall, then exactly one timeout error frame.
    expect(frames[frames.length - 1]).toContain('"type":"error"');
    expect(response.body.indexOf("idle window")).toBeGreaterThan(response.body.indexOf("message_start"));
  });

  it("healthy long streams with continuous progress are never killed by a small idle window", async () => {
    const eventsList = largeStream(5, 4);
    app = Fastify();
    const paced: CanonicalUpstream = {
      async *invoke() {
        for (const item of eventsList) {
          yield item;
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
      },
    };
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: paced, streamTimeouts: { setupTimeoutMs: 60_000, idleTimeoutMs: 25 } });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "fixture-model", max_tokens: 10, messages: [{ role: "user", content: "fixture" }], stream: true } });
    // Progress resets the idle clock; the stream completes with no error frame.
    expect(response.body).toBe(encodeAnthropicSse(eventsList));
  });

  it("Responses routes the timeout error through the Responses error vocabulary", async () => {
    app = Fastify();
    const hanging: CanonicalUpstream = {
      async *invoke(_request, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
        yield { ...base, sequence: 0, type: "response-started", responseId: "resp_hang" };
      },
    };
    registerOpenAiResponsesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: hanging, streamTimeouts: { setupTimeoutMs: 30, idleTimeoutMs: 60_000 } });
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true } });
    expect(response.body).toContain('"type":"timeout_error"');
  });
});

describe("incremental streaming routes: backpressure and slow consumers (#120)", () => {
  it("a slow consumer with a paused read sees no spurious idle timeout and receives the full stream", async () => {
    const eventsList = largeStream(200, 30); // ~6200 frames, multi-MB body
    const logLines: string[] = [];
    const writable = { write: (line: string) => { logLines.push(line); return true; } };
    app = Fastify({ logger: { level: "info", stream: writable } as never });
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: upstreamFrom(eventsList), streamTimeouts: { setupTimeoutMs: 60_000, idleTimeoutMs: 40 } });
    const { port } = await listen(app);
    const expected = encodeAnthropicSse(eventsList);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture-token", "anthropic-version": "2023-06-01" } },
        (res) => { void consumeSlowly(res, { chunkDelayMs: 5, pauseAfterChunks: 3, pauseMs: 200 }).then(resolve, reject); },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "fixture-model", max_tokens: 100_000, messages: [{ role: "user", content: "fixture" }], stream: true }));
    });
    expect(body).toBe(expected);
    // The streamed response reported backpressure and completed, not timed out.
    const finished = logLines.map((line) => JSON.parse(line) as { streamMetrics?: { terminalKind?: string; backpressureCount?: number; eventCount?: number } }).find((line) => line.streamMetrics?.terminalKind === "completed");
    expect(finished?.streamMetrics?.terminalKind).toBe("completed");
    expect(finished?.streamMetrics?.backpressureCount).toBeGreaterThan(0);
    expect(finished?.streamMetrics?.eventCount).toBe(eventsList.length);
  });
});

describe("incremental streaming routes: disconnect/cancellation (#120)", () => {
  it("client disconnect aborts upstream work promptly and emits no error frame after close", async () => {
    const eventsList = largeStream(500, 20);
    let abortObserved: Promise<void> | undefined;
    const aborting: CanonicalUpstream = {
      async *invoke(_request, signal) {
        abortObserved = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        for (const item of eventsList) {
          yield item;
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        }
        // Stall to keep the stream alive until the client disconnects.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
      },
    };
    app = Fastify();
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: aborting, streamTimeouts: { setupTimeoutMs: 60_000, idleTimeoutMs: 60_000 } });
    const { port } = await listen(app);
    const received = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture-token", "anthropic-version": "2023-06-01" } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += String(chunk);
            // Disconnect after the first few frames arrive; destroying the
            // response closes the socket, which the server sees as a client
            // disconnect.
            if (body.includes("message_start") && body.split("\n\n").length >= 3) {
              res.destroy();
              resolve(body);
            }
          });
          res.on("error", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: "fixture" }], stream: true }));
    });
    await abortObserved;
    // Only frames that were fully received before the disconnect count;
    // the last segment may be a chunk cut mid-frame at destroy.
    const segments = received.split("\n\n");
    const completeFrames = (received.endsWith("\n\n") ? segments : segments.slice(0, -1)).filter((frame) => frame.length > 0);
    expect(completeFrames.length).toBeGreaterThanOrEqual(2);
    expect(completeFrames.every((frame) => frame.startsWith("event: "))).toBe(true);
    expect(received.includes('"type":"error"')).toBe(false);
    expect(received.includes("message_start")).toBe(true);
  });
});
