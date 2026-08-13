import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../core/router.js";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, encodeAnthropicEvents } from "../protocols/anthropic/encoder.js";
import { collectWithSafeRetry, type CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";

export type AnthropicRouteDependencies = Readonly<{ upstream: CanonicalUpstream; route: RouteRecord; configFingerprint: string }>;

function errorPayload(error: unknown): { type: "error"; error: { type: string; message: string } } {
  if (error instanceof AnthropicProtocolError) return { type: "error", error: { type: error.code, message: "Gateway rejected the protocol event" } };
  if (error instanceof UnsupportedRouteError) return { type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } };
  return { type: "error", error: { type: "api_error", message: "Gateway upstream failed" } };
}

export function registerAnthropicMessagesRoute(app: FastifyInstance, dependencies: AnthropicRouteDependencies): void {
  app.post("/v1/messages", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      decideRoute({ requestId: decoded.request.id, route: dependencies.route, required: decoded.required, configFingerprint: dependencies.configFingerprint });
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort(new Error("client disconnected")));
      if (decoded.request.stream) {
        const source = dependencies.upstream.invoke(decoded.request, controller.signal);
        async function* sse(): AsyncIterable<string> {
          const seen = [];
          let emitted = 0;
          try {
            for await (const event of source) {
              seen.push(event);
              const encoded = encodeAnthropicEvents(seen, false);
              for (const wire of encoded.slice(emitted)) yield `event: ${wire.event}\ndata: ${JSON.stringify(wire.data)}\n\n`;
              emitted = encoded.length;
            }
          } catch {
            yield "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Gateway upstream failed\"}}\n\n";
          }
        }
        return await reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(Readable.from(sse()));
      }
      const events = await collectWithSafeRetry(dependencies.upstream, decoded.request, controller.signal);
      return await reply.send(aggregateAnthropicEvents(events));
    } catch (error) {
      const status = error instanceof AnthropicProtocolError ? error.statusCode : error instanceof UnsupportedRouteError ? 400 : 502;
      return await reply.code(status).send(errorPayload(error));
    }
  });
}
