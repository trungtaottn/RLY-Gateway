import type { TokenCountingQuality } from "./capabilities.js";
import type { CanonicalRequest } from "./canonical-request.js";

export type TokenCountResult = Readonly<{ inputTokens: number; quality: TokenCountingQuality }>;

/** A deliberately high estimate: it is safe to expose, but never claims tokenizer parity. */
export function conservativeTokenCount(request: CanonicalRequest): TokenCountResult {
  const text = JSON.stringify({ system: request.system, input: request.input, tools: request.tools });
  return { inputTokens: Math.ceil(text.length / 3) + 16, quality: "conservative-estimate" };
}
