import type { ProviderErrorInfo } from "../providers/provider-error.js";
import { translateProviderError } from "../providers/provider-error.js";
import { ProviderAdapterError } from "../providers/provider-adapter.js";

/**
 * Deterministic provider-error → protocol-correct client error mapping (#121).
 *
 * Provider-native status/code/type/retry-after/rate-limit metadata survives
 * the adapter boundary (`ProviderAdapterError.info`, already redacted) and is
 * translated onto the target protocol's error vocabulary. Generic
 * normalization is the fallback, never the only path.
 */

export type ErrorTarget = "openai-responses" | "anthropic-messages";

export function providerErrorInfoOf(error: unknown): ProviderErrorInfo | undefined {
  return error instanceof ProviderAdapterError ? error.info : undefined;
}

export function providerRetryAfterOf(error: unknown): number | undefined {
  return providerErrorInfoOf(error)?.retryAfterSeconds;
}

export function providerErrorStatus(error: unknown, target: ErrorTarget): number {
  const info = providerErrorInfoOf(error);
  if (info === undefined) return target === "openai-responses" ? 502 : 529;
  return translateProviderError(info, target).statusCode;
}

/**
 * Builds the protocol error payload for a provider failure. The translated
 * message is the adapter-safe allowlisted provider message (bounded), never a
 * raw body.
 */
export function providerErrorPayload(error: unknown, target: ErrorTarget): { type: string; message: string; param?: string; code?: string } {
  const info = providerErrorInfoOf(error);
  if (info === undefined) {
    const code = error instanceof ProviderAdapterError ? error.code : "api_error";
    return { type: code, message: "Gateway upstream failed" };
  }
  const translated = translateProviderError(info, target);
  if (target === "anthropic-messages") {
    return { type: translated.code, message: translated.message };
  }
  return {
    type: translated.code,
    code: translated.code,
    message: translated.message,
    ...(translated.param === undefined ? {} : { param: translated.param }),
  };
}
