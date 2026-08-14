import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { CanonicalEvent } from "../core/canonical-event.js";
import { decideRoute, UnsupportedRouteError } from "../core/router.js";
import { ProfileActivationError } from "../profiles/errors.js";
import { collectWithSafeRetry } from "../protocols/anthropic/fake-upstream.js";
import type { ResponseContinuationStore } from "../protocols/openai-responses/continuation.js";
import { decodeResponsesRequest, ResponsesProtocolError } from "../protocols/openai-responses/decoder.js";
import { aggregateResponsesEvents, encodeResponsesEvents } from "../protocols/openai-responses/encoder.js";
import { ProviderAdapterError } from "../providers/provider-adapter.js";
import { NoEligibleAccountError } from "../routing/errors.js";
import {
  bindClientAbort,
  type AnthropicRouteDependencies,
} from "./anthropic-messages-route.js";

function errorPayload(error: unknown): { type: "error"; error: { type: string; message: string } } {
  if (error instanceof ResponsesProtocolError) return { type: "error", error: { type: error.code, message: error.message } };
  if (error instanceof UnsupportedRouteError) return { type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } };
  if (error instanceof ProfileActivationError) return { type: "error", error: { type: error.code, message: "Profile is not ready for this request", ...(error.modelFailure === undefined ? {} : { reason: error.modelFailure }) } };
  if (error instanceof NoEligibleAccountError) return { type: "error", error: { type: "no_eligible_account", message: "No eligible account is available" } };
  if (error instanceof ProviderAdapterError) return { type: "error", error: { type: error.code, message: "Gateway upstream failed" } };
  return { type: "error", error: { type: "api_error", message: "Gateway upstream failed" } };
}

function statusFor(error: unknown): number {
  if (error instanceof ResponsesProtocolError) return error.statusCode;
  if (error instanceof UnsupportedRouteError || error instanceof ProfileActivationError) return 400;
  if (error instanceof NoEligibleAccountError) return 503;
  if (error instanceof ProviderAdapterError && error.code === "authentication_error") return 401;
  if (error instanceof ProviderAdapterError && error.code === "rate_limit_error") return 429;
  return 502;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
      try {
        if (continued.stream) {
          const source = upstream.invoke(continued, controller.signal);
          async function* sse(): AsyncIterable<string> {
            const seen: CanonicalEvent[] = [];
            let emitted = 0;
            try {
              for await (const event of source) {
                seen.push(event);
                const encoded = encodeResponsesEvents(seen, false);
                for (const wire of encoded.slice(emitted)) yield sseFrame(wire.event, wire.data);
                emitted = encoded.length;
              }
              await continuation?.remember(continued, seen);
            } catch (error) {
              if (!controller.signal.aborted) yield sseFrame("error", errorPayload(error));
            }
          }
          return await reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(Readable.from(sse()));
        }
        const events = await collectWithSafeRetry(upstream, continued, controller.signal);
        await continuation?.remember(continued, events);
        return await reply.send(aggregateResponsesEvents(events));
      } finally {
        unbindAbort();
      }
    } catch (error) {
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
      return await reply.code(statusFor(error)).send(errorPayload(error));
    }
  });
}
