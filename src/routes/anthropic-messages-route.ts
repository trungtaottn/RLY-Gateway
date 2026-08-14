import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../core/router.js";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, encodeAnthropicEvents } from "../protocols/anthropic/encoder.js";
import { collectWithSafeRetry, type CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { ProviderAdapterError } from "../providers/provider-adapter.js";

export type ResolvedAnthropicRoute = Readonly<{ upstream: CanonicalUpstream; route: RouteRecord }>;
export type AnthropicRouteDependencies = Readonly<{
  upstream?: CanonicalUpstream;
  route?: RouteRecord;
  resolveRoute?: (request: ReturnType<typeof decodeAnthropicRequest>["request"]) => ResolvedAnthropicRoute | undefined | Promise<ResolvedAnthropicRoute | undefined>;
  configFingerprint: string;
}>;
type Closeable = Readonly<{
  once: (event: "aborted" | "close", listener: () => void) => unknown;
  removeListener: (event: "aborted" | "close", listener: () => void) => unknown;
}>;

/** Links incomplete request bodies and response-side disconnects to outbound provider work. */
export function bindClientAbort(request: Closeable, response: Closeable, controller: AbortController): () => void {
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error("client disconnected"));
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return (): void => {
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
  };
}

function errorPayload(error: unknown): { type: "error"; error: { type: string; message: string } } {
  if (error instanceof AnthropicProtocolError) return { type: "error", error: { type: error.code, message: error.message } };
  if (error instanceof UnsupportedRouteError) return { type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } };
  if (error instanceof ProviderAdapterError) return { type: "error", error: { type: error.code, message: "Gateway upstream failed" } };
  return { type: "error", error: { type: "api_error", message: "Gateway upstream failed" } };
}

export function registerAnthropicMessagesRoute(app: FastifyInstance, dependencies: AnthropicRouteDependencies): void {
  app.post("/v1/messages", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      const resolved = await dependencies.resolveRoute?.(decoded.request);
      const route = resolved?.route ?? dependencies.route;
      const upstream = resolved?.upstream ?? dependencies.upstream;
      if (!route || !upstream) throw new UnsupportedRouteError(["streaming"]);
      decideRoute({ requestId: decoded.request.id, route, required: decoded.required, configFingerprint: dependencies.configFingerprint });
      const controller = new AbortController();
      const unbindAbort = bindClientAbort(request.raw, reply.raw, controller);
      try {
        if (decoded.request.stream) {
          const source = upstream.invoke(decoded.request, controller.signal);
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
            } catch (error) {
              if (!controller.signal.aborted) yield `event: error\ndata: ${JSON.stringify(errorPayload(error))}\n\n`;
            }
          }
          return await reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(Readable.from(sse()));
        }
        const events = await collectWithSafeRetry(upstream, decoded.request, controller.signal);
        return await reply.send(aggregateAnthropicEvents(events));
      } finally {
        unbindAbort();
      }
    } catch (error) {
      const status = error instanceof AnthropicProtocolError ? error.statusCode : error instanceof UnsupportedRouteError ? 400 : error instanceof ProviderAdapterError && error.code === "authentication_error" ? 401 : error instanceof ProviderAdapterError && error.code === "rate_limit_error" ? 429 : 502;
      return await reply.code(status).send(errorPayload(error));
    }
  });
}
