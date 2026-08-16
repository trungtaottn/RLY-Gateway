import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { decideRoute, UnsupportedRouteError } from "../core/router.js";
import { ProfileActivationError } from "../profiles/errors.js";
import { collectWithSafeRetry } from "../protocols/anthropic/fake-upstream.js";
import type { ResponseContinuationStore } from "../protocols/openai-responses/continuation.js";
import { decodeResponsesRequest, ResponsesProtocolError } from "../protocols/openai-responses/decoder.js";
import { aggregateResponsesEvents, createResponsesIncrementalEncoder } from "../protocols/openai-responses/encoder.js";
import { NoEligibleAccountError } from "../routing/errors.js";
import { providerErrorPayload, providerErrorStatus, providerRetryAfterOf } from "./provider-error-mapping.js";
import {
  bindClientAbort,
  type AnthropicRouteDependencies,
} from "./anthropic-messages-route.js";
import { createStreamLifecycle } from "./stream-lifecycle.js";
import { pumpStream } from "./stream-pump.js";

function errorPayload(error: unknown): { type: "error"; error: { type: string; message: string; param?: string; code?: string } } {
  if (error instanceof ResponsesProtocolError) return { type: "error", error: { type: error.code, message: error.message } };
  if (error instanceof UnsupportedRouteError) return { type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } };
  if (error instanceof ProfileActivationError) return { type: "error", error: { type: error.code, message: "Profile is not ready for this request", ...(error.modelFailure === undefined && error.tierFailure === undefined && error.intentFailure === undefined ? {} : { reason: error.tierFailure ?? error.intentFailure ?? error.modelFailure }) } };
  if (error instanceof NoEligibleAccountError) return { type: "error", error: { type: "no_eligible_account", message: "No eligible account is available" } };
  // #121: ProviderAdapterError / RouteFailure carry safe structured provider
  // error metadata; it survives instead of generic normalization.
  return { type: "error", error: providerErrorPayload(error, "openai-responses") };
}

function statusFor(error: unknown): number {
  if (error instanceof ResponsesProtocolError) return error.statusCode;
  if (error instanceof UnsupportedRouteError || error instanceof ProfileActivationError) return 400;
  if (error instanceof NoEligibleAccountError) return 503;
  return providerErrorStatus(error, "openai-responses");
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** #120 in-band timeout frame: the client is still connected, so it gets a structured error. */
function timeoutError(category: "setup" | "idle"): ResponsesProtocolError {
  return new ResponsesProtocolError("timeout_error", category === "setup" ? "Gateway stream did not start within the setup window" : "Gateway stream made no progress within the idle window", 504);
}

function notStored(): ReturnType<typeof errorPayload> {
  return errorPayload(new ResponsesProtocolError("not_found", "Response is not stored", 404));
}

export type ResponsesRouteDependencies = AnthropicRouteDependencies & Readonly<{
  continuation?: ResponseContinuationStore;
}>;

export function registerOpenAiResponsesRoute(app: FastifyInstance, dependencies: ResponsesRouteDependencies): void {
  const continuation = dependencies.continuation;
  app.post("/v1/responses", async (request, reply) => {
    try {
      const decoded = decodeResponsesRequest(request.body, request.headers);
      const continued = continuation === undefined ? decoded.request : await continuation.apply(decoded.request);
      const resolved = await dependencies.resolveRoute?.(continued, request.headers, decoded.required);
      const route = resolved?.route ?? dependencies.route;
      const upstream = resolved?.upstream ?? dependencies.upstream;
      if (!route || !upstream) throw new UnsupportedRouteError(["streaming"]);
      decideRoute({ requestId: continued.id, route, required: decoded.required, configFingerprint: dependencies.configFingerprint });
      const controller = new AbortController();
      const unbindAbort = bindClientAbort(request.raw, reply.raw, controller);
      if (continued.stream) {
        // #120 incremental transport (see anthropic-messages-route.ts): each
        // event is encoded once, downstream backpressure pauses the upstream,
        // and the client abort binding is released by the pump's onFinished.
        // Continuation persistence runs on a clean, complete stream and reads
        // the encoder's bounded aggregate state (never the event history).
        const lifecycle = createStreamLifecycle({
          clientSignal: controller.signal,
          ...(dependencies.streamTimeouts === undefined ? {} : { policy: dependencies.streamTimeouts }),
        });
        const source = upstream.invoke(continued, lifecycle.signal);
        const encoder = createResponsesIncrementalEncoder();
        const onDrain = (): void => lifecycle.noteBackpressure();
        reply.raw.on("drain", onDrain);
        const readable = Readable.from(pumpStream(source, {
          lifecycle,
          encoder,
          frame: (wire) => sseFrame(wire.event, wire.data),
          errorFrame: (error) => sseFrame("error", errorPayload(error)),
          timeoutFrame: (category) => sseFrame("error", errorPayload(timeoutError(category))),
          onComplete: async () => {
            if (encoder.status() === "completed" && continuation !== undefined) {
              await continuation.rememberAggregated(continued, encoder.aggregate());
            }
          },
          onFinished: (metrics) => {
            reply.raw.removeListener("drain", onDrain);
            unbindAbort();
            request.log.info({ streamMetrics: metrics }, "stream finished");
          },
        }));
        try {
          return await reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(readable);
        } catch (error) {
          // Pre-stream send failure: release the drain listener and the client
          // abort binding; the outer catch converts the error into a
          // structured reply.
          reply.raw.removeListener("drain", onDrain);
          unbindAbort();
          throw error;
        }
      }
      try {
        const events = await collectWithSafeRetry(upstream, continued, controller.signal);
        await continuation?.remember(continued, events);
        return await reply.send(aggregateResponsesEvents(events));
      } finally {
        unbindAbort();
      }
    } catch (error) {
      const retryAfter = providerRetryAfterOf(error);
      if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
      return await reply.code(statusFor(error)).send(errorPayload(error));
    }
  });

  app.get("/v1/responses/:responseId", async (request, reply) => {
    const params = request.params as { responseId?: string };
    const id = params.responseId;
    if (!id || !continuation) return await reply.code(404).send(notStored());
    try {
      const stored = await continuation.get(id);
      if (!stored) return await reply.code(404).send(notStored());
      return continuation.toResponsesObject(stored);
    } catch (error) {
      const retryAfter = providerRetryAfterOf(error);
      if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
      return await reply.code(statusFor(error)).send(errorPayload(error));
    }
  });
}
