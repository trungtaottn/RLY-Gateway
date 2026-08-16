import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../core/router.js";
import { ProfileActivationError } from "../profiles/errors.js";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, createAnthropicIncrementalEncoder } from "../protocols/anthropic/encoder.js";
import { collectWithSafeRetry, type CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { NoEligibleAccountError } from "../routing/errors.js";
import { providerErrorPayload, providerErrorStatus, providerRetryAfterOf } from "./provider-error-mapping.js";
import { createStreamLifecycle, type StreamTimeoutPolicy } from "./stream-lifecycle.js";
import { pumpStream } from "./stream-pump.js";

export type ResolvedAnthropicRoute = Readonly<{ upstream: CanonicalUpstream; route: RouteRecord }>;
export type RouteResolverHeaders = Readonly<{
  authorization?: string | undefined;
  "x-api-key"?: string | string[] | undefined;
}>;
export type AnthropicRouteDependencies = Readonly<{
  upstream?: CanonicalUpstream;
  route?: RouteRecord;
  resolveRoute?: (
    request: ReturnType<typeof decodeAnthropicRequest>["request"],
    headers?: RouteResolverHeaders,
    required?: ReturnType<typeof decodeAnthropicRequest>["required"],
  ) => ResolvedAnthropicRoute | undefined | Promise<ResolvedAnthropicRoute | undefined>;
  configFingerprint: string;
  /**
   * #120 stream timeout policy. Defaults to `DEFAULT_STREAM_TIMEOUT_POLICY`:
   * a bounded connection/setup window before the first frame and an idle/
   * progress window between frames — no generic whole-request timer, so
   * healthy long-lived agent streams are never killed.
   */
  streamTimeouts?: Partial<StreamTimeoutPolicy>;
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

function errorPayload(error: unknown): { type: "error"; error: { type: string; message: string; param?: string; code?: string; cause?: string } } {
  if (error instanceof AnthropicProtocolError) return { type: "error", error: { type: error.code, message: error.message } };
  if (error instanceof UnsupportedRouteError) return { type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } };
  if (error instanceof ProfileActivationError) return { type: "error", error: { type: error.code, message: "Profile is not ready for this request", ...(error.modelFailure === undefined && error.tierFailure === undefined && error.intentFailure === undefined ? {} : { reason: error.tierFailure ?? error.intentFailure ?? error.modelFailure }), ...(error.tierCause === undefined ? {} : { cause: error.tierCause }) } };
  if (error instanceof NoEligibleAccountError) return { type: "error", error: { type: "no_eligible_account", message: "No eligible account is available" } };
  // #121: ProviderAdapterError / RouteFailure carry safe structured provider
  // error metadata; it survives (cross-protocol translated) instead of
  // generic normalization.
  return { type: "error", error: providerErrorPayload(error, "anthropic-messages") };
}

function statusFor(error: unknown): number {
  if (error instanceof AnthropicProtocolError) return error.statusCode;
  if (error instanceof UnsupportedRouteError || error instanceof ProfileActivationError) return 400;
  if (error instanceof NoEligibleAccountError) return 503;
  return providerErrorStatus(error, "anthropic-messages");
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** #120 in-band timeout frame: the client is still connected, so it gets a structured error. */
function timeoutError(category: "setup" | "idle"): AnthropicProtocolError {
  return new AnthropicProtocolError("api_error", category === "setup" ? "Gateway stream did not start within the setup window" : "Gateway stream made no progress within the idle window", 504);
}

export function registerAnthropicMessagesRoute(app: FastifyInstance, dependencies: AnthropicRouteDependencies): void {
  app.post("/v1/messages", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      const resolved = await dependencies.resolveRoute?.(decoded.request, request.headers, decoded.required);
      const route = resolved?.route ?? dependencies.route;
      const upstream = resolved?.upstream ?? dependencies.upstream;
      if (!route || !upstream) throw new UnsupportedRouteError(["streaming"]);
      decideRoute({ requestId: decoded.request.id, route, required: decoded.required, configFingerprint: dependencies.configFingerprint });
      const controller = new AbortController();
      const unbindAbort = bindClientAbort(request.raw, reply.raw, controller);
      if (decoded.request.stream) {
        // #120 incremental transport: the upstream signal is the merged
        // client-disconnect + policy-timeout signal; the pump encodes each
        // event once, respects downstream backpressure by suspending at yield,
        // and cleans up exactly once when the stream terminates. The client
        // abort binding is released by the pump's onFinished (the handler
        // returns before the stream ends), not by the handler's finally.
        const lifecycle = createStreamLifecycle({
          clientSignal: controller.signal,
          ...(dependencies.streamTimeouts === undefined ? {} : { policy: dependencies.streamTimeouts }),
        });
        const source = upstream.invoke(decoded.request, lifecycle.signal);
        const encoder = createAnthropicIncrementalEncoder();
        const onDrain = (): void => lifecycle.noteBackpressure();
        reply.raw.on("drain", onDrain);
        const readable = Readable.from(pumpStream(source, {
          lifecycle,
          encoder,
          frame: (wire) => sseFrame(wire.event, wire.data),
          errorFrame: (error) => sseFrame("error", errorPayload(error)),
          timeoutFrame: (category) => sseFrame("error", errorPayload(timeoutError(category))),
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
        const events = await collectWithSafeRetry(upstream, decoded.request, controller.signal);
        return await reply.send(aggregateAnthropicEvents(events));
      } finally {
        unbindAbort();
      }
    } catch (error) {
      const retryAfter = providerRetryAfterOf(error);
      if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
      return await reply.code(statusFor(error)).send(errorPayload(error));
    }
  });
}
