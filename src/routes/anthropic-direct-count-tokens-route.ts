import type { FastifyInstance } from "fastify";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import type { RouteRecord } from "../core/router.js";
import { ProfileActivationError } from "../profiles/errors.js";
import type { RouteResolverHeaders } from "./anthropic-messages-route.js";

export function registerAnthropicDirectCountTokensRoute(
  app: FastifyInstance,
  resolveRoute: (
    request: ReturnType<typeof decodeAnthropicRequest>["request"],
    headers?: RouteResolverHeaders,
    required?: ReturnType<typeof decodeAnthropicRequest>["required"],
  ) => Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }> | undefined | Promise<Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }> | undefined>,
): void {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      const resolved = await resolveRoute(decoded.request, request.headers, decoded.required);
      if (!resolved) return await reply.code(404).send({ type: "error", error: { type: "not_found_error", message: "Configured route was not found" } });
      const unavailable = { type: "error", error: { type: "unsupported_feature", message: "Token counting is unavailable" } } as const;
      if (resolved.route.capabilities.tokenCounting === "unsupported") return await reply.code(501).send(unavailable);
      const result = await resolved.upstream.countTokens?.(decoded.request);
      if (!result) return await reply.code(501).send(unavailable);
      return await reply.header("x-rly-gateway-token-count-quality", result.quality).send({ input_tokens: result.inputTokens });
    } catch (error) {
      if (error instanceof AnthropicProtocolError) return await reply.code(error.statusCode).send({ type: "error", error: { type: error.code, message: "Gateway rejected the protocol event" } });
      if (error instanceof ProfileActivationError) return await reply.code(400).send({ type: "error", error: { type: error.code, message: "Profile is not ready for this request", ...(error.modelFailure === undefined && error.tierFailure === undefined && error.intentFailure === undefined ? {} : { reason: error.tierFailure ?? error.intentFailure ?? error.modelFailure }) } });
      return await reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "Invalid token-count request" } });
    }
  });
}
