import type { CommitmentState } from "./commitment.js";
import { ProviderAdapterError } from "./provider-adapter.js";

/**
 * Provider-native error fidelity (#121).
 *
 * Safe structured provider error metadata (status, code, type, retry-after,
 * rate-limit fields, protocol-required body fields) survives the adapter
 * boundary through `ProviderAdapterError.info`. Raw provider bodies are NEVER
 * propagated: only allowlisted fields extracted by `parseProviderError` reach
 * clients, routes, and logs. Deliberate redaction means we never replace every
 * upstream failure with one generic message when safe actionable metadata
 * exists.
 *
 * PRIVACY INVARIANT: `ProviderErrorInfo` carries only allowlisted, bounded
 * fields. No credentials, auth headers, secret-bearing body fragments,
 * prompts, responses, or reasoning text can appear in it by construction.
 */

export type ProviderStatusClass = "2xx" | "4xx" | "5xx" | "transport" | "protocol";

export type ProviderRateLimit = Readonly<{
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}>;

export type ProviderErrorInfo = Readonly<{
  /** HTTP status of the provider failure (or a synthesized class status). */
  statusCode: number;
  /** Machine-readable error code (e.g. `rate_limit_error`). */
  code: string;
  /** Provider error type when distinct from `code` (e.g. `invalid_request_error`). */
  type?: string;
  /** SAFE, bounded, allowlisted message extracted from the provider body. */
  message: string;
  /** Protocol-required body field (`param`), bounded, safe. */
  param?: string;
  /** Seconds the provider asked the client to wait before retrying. */
  retryAfterSeconds?: number;
  /** Allowlisted rate-limit metadata parsed from response headers. */
  rateLimit?: ProviderRateLimit;
}>;

const MAX_MESSAGE_LENGTH = 300;
const MAX_CODE_LENGTH = 64;

export function statusClassOf(statusCode: number): ProviderStatusClass {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "protocol";
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function retryAfterSecondsOf(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  // HTTP-date form: deterministically bounded to the standard retry-after window.
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
  return undefined;
}

function rateLimitOf(headers: Headers): ProviderRateLimit | undefined {
  const limit = boundedNumber(headers.get("x-ratelimit-limit"));
  const remaining = boundedNumber(headers.get("x-ratelimit-remaining"));
  const resetSeconds = retryAfterSecondsOf(headers);
  if (limit === undefined && remaining === undefined && resetSeconds === undefined) return undefined;
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetSeconds === undefined ? {} : { resetSeconds }),
  });
}

/** Bounded body read: never read unbounded provider error bodies into memory. */
async function readBoundedBodyText(response: Response, limit = 32 * 1024): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > limit) break;
    }
  } finally {
    reader.releaseLock();
  }
  return buffered.slice(0, limit);
}

/**
 * Extracts SAFE structured error metadata from a failed provider response.
 *
 * Only allowlisted fields (`code`, `type`, `message`, `param` and numeric
 * rate-limit metadata) survive. The raw body is never propagated; unparseable
 * or unexpected bodies produce a bounded generic message with the status, so
 * a generic message is the fallback, never the only path.
 */
export async function parseProviderError(response: Response, bodyText?: string): Promise<ProviderErrorInfo> {
  const statusCode = response.status;
  const retryAfterSeconds = retryAfterSecondsOf(response.headers);
  const rateLimit = rateLimitOf(response.headers);
  const raw = bodyText ?? (await readBoundedBodyText(response));
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = undefined;
  }
  const top = record(body);
  const errorField = top === undefined ? undefined : record(top.error);
  // Common shapes: {error:{...}}, {error:"string"}, flat {code,message}, {message}.
  const candidate = errorField ?? top;
  let code = boundedString(candidate?.code, MAX_CODE_LENGTH);
  let type = boundedString(candidate?.type, MAX_CODE_LENGTH);
  let message = boundedString(candidate?.message, MAX_MESSAGE_LENGTH);
  let param = boundedString(candidate?.param, MAX_CODE_LENGTH);
  if (code === undefined) code = boundedString(errorField === undefined ? top?.error : undefined, MAX_CODE_LENGTH);
  if (code === undefined && type !== undefined) code = type;
  if (message === undefined) message = boundedString(top?.message, MAX_MESSAGE_LENGTH);
  if (code === undefined) code = codeForStatus(statusCode);
  if (message === undefined) message = `Provider request failed (HTTP ${statusCode})`;
  return Object.freeze({
    statusCode,
    code,
    ...(type === undefined ? {} : { type }),
    message,
    ...(param === undefined ? {} : { param }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  });
}

/** Deterministic status → code mapping when the provider body has no code. */
export function codeForStatus(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) return "authentication_error";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode >= 400 && statusCode < 500) return "invalid_request_error";
  if (statusCode >= 500) return "api_error";
  return "api_error";
}

/**
 * Deterministic translation of a native provider error for cross-protocol
 * paths. Maps the native status/code onto the target protocol's error
 * vocabulary; unknown native codes keep a deterministic status-derived code.
 */
export function translateProviderError(info: ProviderErrorInfo, target: "openai-responses" | "anthropic-messages"): Readonly<{
  statusCode: number;
  code: string;
  type: string;
  message: string;
  param?: string;
  retryAfterSeconds?: number;
}> {
  const { statusCode } = info;
  const mapped = mapStatusForProtocol(statusCode, target);
  const code = codeForProtocol(info.code, statusCode, target);
  return Object.freeze({
    statusCode: mapped,
    code,
    type: code,
    message: info.message,
    ...(info.param === undefined ? {} : { param: info.param }),
    ...(info.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: info.retryAfterSeconds }),
  });
}

function mapStatusForProtocol(statusCode: number, target: "openai-responses" | "anthropic-messages"): number {
  if (statusCode === 401 || statusCode === 403) return target === "anthropic-messages" ? 401 : 401;
  if (statusCode === 429) return 429;
  if (statusCode === 408 || statusCode === 504) return target === "anthropic-messages" ? 529 : 504;
  if (statusCode === 503 || statusCode === 529) return target === "anthropic-messages" ? 529 : 503;
  if (statusCode >= 500) return target === "anthropic-messages" ? 529 : 502;
  if (statusCode >= 400 && statusCode < 500) return target === "anthropic-messages" ? 400 : 400;
  return target === "anthropic-messages" ? 529 : 502;
}

function codeForProtocol(code: string, statusCode: number, target: "openai-responses" | "anthropic-messages"): string {
  const known: Readonly<Record<string, string>> = {
    authentication_error: "authentication_error",
    permission_error: "permission_error",
    not_found_error: "not_found_error",
    rate_limit_error: "rate_limit_error",
    overloaded_error: "overloaded_error",
    invalid_request_error: "invalid_request_error",
    api_error: "api_error",
    timeout_error: "timeout_error",
    quota_exceeded: "rate_limit_error",
    insufficient_quota: "rate_limit_error",
  };
  const direct = known[code];
  if (direct !== undefined) return target === "anthropic-messages" && code === "overloaded_error" ? "overloaded_error" : direct;
  if (target === "anthropic-messages") {
    if (statusCode === 401 || statusCode === 403) return "authentication_error";
    if (statusCode === 429) return "rate_limit_error";
    if (statusCode === 503 || statusCode === 529) return "overloaded_error";
    if (statusCode >= 400 && statusCode < 500) return "invalid_request_error";
    return "api_error";
  }
  return codeForStatus(statusCode);
}

/**
 * Commitment classification for a failed HTTP response. A deterministic 4xx
 * rejection proves the provider did not commit billable work (safe rotation);
 * a 5xx/timeout is ambiguous — the provider may have accepted the request —
 * so it defaults to `unknown` (no replay) unless a response body proves
 * otherwise.
 */
export function commitmentForHttpFailure(response: Response): CommitmentState {
  const status = response.status;
  if (status >= 400 && status < 500 && status !== 408 && status !== 409) return "not-sent";
  return "unknown";
}

/**
 * Commitment classification for a transport failure. Failing before the
 * request body was written proves nothing committed; failing after the body
 * started flowing is an ambiguous/unknown outcome — conservative no-replay.
 */
export function commitmentForTransportFailure(bodyStarted: boolean): CommitmentState {
  return bodyStarted ? "unknown" : "not-sent";
}

/** Reads `ProviderAdapterError` commitment (or `unknown` for anything else). */
export function commitmentOf(error: unknown): CommitmentState {
  return error instanceof ProviderAdapterError ? error.commitment : "unknown";
}

/** Builds a `ProviderAdapterError` with safe structured metadata + commitment. */
export function providerFailure(
  code: string,
  info: ProviderErrorInfo | undefined,
  commitment: CommitmentState,
  message = "Provider request failed",
): ProviderAdapterError {
  return new ProviderAdapterError(code, message, info, commitment);
}
