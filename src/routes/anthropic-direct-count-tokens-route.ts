import type { FastifyInstance } from "fastify";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import type { RouteRecord } from "../core/router.js";

export function registerAnthropicDirectCountTokensRoute(app: FastifyInstance, resolveRoute: (request: ReturnType<typeof decodeAnthropicRequest>["request"]) => Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }> | undefined): void {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      const resolved = resolveRoute(decoded.request);
      if (!resolved) return await reply.code(404).send({ type: "error", error: { type: "not_found_error", message: "Configured route was not found" } });
      if (resolved.route.capabilities.tokenCounting === "unsupported") return await reply.code(501).send({ type: "error", error: { type: "unsupported_feature", message: "Token counting is unavailable" } });
      const result = resolved.upstream.countTokens ? await resolved.upstream.countTokens(decoded.request) : undefined;
      if (!result) return await reply.code(501).send({ type: "error", error: { type: "unsupported_feature", message: "Token counting is unavailable" } });
      return await reply.header("x-agent-gateway-token-count-quality", result.quality).send({ input_tokens: result.inputTokens });
    } catch (error) {
      if (error instanceof AnthropicProtocolError) return await reply.code(error.statusCode).send({ type: "error", error: { type: error.code, message: "Gateway rejected the protocol event" } });
      return await reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "Invalid token-count request" } });
    }
  });
}
