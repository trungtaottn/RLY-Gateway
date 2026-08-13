import type { FastifyInstance } from "fastify";
import { conservativeTokenCount } from "../core/token-counting.js";
import { type RouteRecord } from "../core/router.js";
import { decodeAnthropicRequest, AnthropicProtocolError } from "../protocols/anthropic/decoder.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";

export function registerAnthropicCountTokensRoute(app: FastifyInstance, upstream: CanonicalUpstream, route?: RouteRecord): void {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    try {
      const decoded = decodeAnthropicRequest(request.body, request.headers);
      const result = route?.capabilities.tokenCounting === "unsupported" ? { inputTokens: 0, quality: "unsupported" as const } : upstream.countTokens ? await upstream.countTokens(decoded.request) : conservativeTokenCount(decoded.request);
      if (result.quality === "unsupported") return await reply.code(501).send({ type: "error", error: { type: "unsupported_feature", message: "Token counting is unavailable" } });
      return await reply.header("x-agent-gateway-token-count-quality", result.quality).send({ input_tokens: result.inputTokens });
    } catch (error) {
      if (error instanceof AnthropicProtocolError) return await reply.code(error.statusCode).send({ type: "error", error: { type: error.code, message: error.message } });
      return await reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "Invalid token-count request" } });
    }
  });
}
