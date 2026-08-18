import { z } from "zod";
import type { CredentialRef } from "../credentials/credential-ref.js";
import { resolveEnvironmentCredential } from "../credentials/env-resolver.js";
import { discoverySnapshotSchema } from "../registry/catalog-proposal.js";
import type { DiscoveryCandidate, DiscoverySnapshot } from "../registry/model-registry.js";

/**
 * Provider-owned catalogue discovery (#23 / BL-042).
 *
 * A `ProviderCatalogSource` returns a normalized `DiscoverySnapshot` without
 * any access to registry mutation functions. Discovery results are
 * proposed/unverified until a reviewed promotion; they never write to the
 * trusted #67 registry.
 */

export type CatalogSourceKind = "api" | "static";

export interface ProviderCatalogSource {
  /** Stable catalog source identifier (e.g. `openrouter-api-v1`). */
  readonly sourceId: string;
  readonly providerId: string;
  discover(signal: AbortSignal): Promise<DiscoverySnapshot>;
}

export class CatalogDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message = "Catalog discovery failed",
  ) {
    super(message);
    this.name = "CatalogDiscoveryError";
  }
}

/**
 * Privacy-redacts upstream error material before it reaches output or
 * persistence. Strips bearer tokens, credential-shaped key=value pairs, and
 * email addresses. The caller must never persist the raw upstream body.
 */
export function redactUpstreamError(text: string): string {
  return text
    .replace(/(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, (_match: string, prefix: string) => `${prefix} [REDACTED]`)
    .replace(/(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;"']+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED-EMAIL]");
}

const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
const ERROR_BODY_LIMIT = 200;

const openRouterCatalogSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    context_length: z.number().int().positive().optional(),
    supported_parameters: z.array(z.string()).optional(),
  })).readonly(),
});

function parseCatalogStatus(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

/**
 * Explicit OpenRouter normalization rule: the upstream model id is preserved
 * as-is (no casing or alias guessing); when the id has a vendor path segment
 * (`vendor/model[:suffix]`) that segment becomes the model family, matching
 * the reviewed registry convention (`nvidia/nemotron-3.5-lightning:free` →
 * family `nvidia`). Declared metadata (context window, tools/reasoning) is
 * labeled `declared` — discovered only, never trusted capability evidence.
 */
export function normalizeOpenRouterModel(entry: Readonly<{ id?: unknown; context_length?: unknown; supported_parameters?: unknown }>): DiscoveryCandidate {
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new CatalogDiscoveryError("invalid-response", "catalog entry missing model id");
  }
  const id = entry.id;
  const family = openRouterFamily(id);
  const contextWindow = typeof entry.context_length === "number" && Number.isInteger(entry.context_length) && entry.context_length > 0
    ? entry.context_length
    : undefined;
  const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters.filter((item): item is string => typeof item === "string") : [];
  const declared: DiscoveryCandidate["declared"] = Object.freeze({
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(parameters.includes("tools") ? { tools: true } : {}),
    ...(parameters.includes("reasoning") ? { reasoning: true } : {}),
  });
  return Object.freeze({
    accessProviderId: "openrouter",
    upstreamModelId: id,
    ...(family === undefined ? {} : { modelFamily: family }),
    ...(Object.keys(declared).length === 0 ? {} : { declared }),
  });
}

function openRouterFamily(id: string): string | undefined {
  const separator = id.indexOf("/");
  if (separator < 1) return undefined;
  return id.slice(0, separator);
}

/** API-discovered catalog path. Reads `GET {endpoint}/models`; optional auth via an approved env credential ref. */
export class OpenRouterCatalogSource implements ProviderCatalogSource {
  readonly sourceId = "openrouter-api-v1";
  readonly providerId = "openrouter";
  private readonly request: typeof fetch;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly credentialRef: CredentialRef | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: Readonly<{
    request?: typeof fetch;
    environment?: NodeJS.ProcessEnv;
    credentialRef?: CredentialRef;
    endpoint?: string;
    timeoutMs?: number;
  }> = {}) {
    this.request = options.request ?? fetch;
    this.environment = options.environment ?? process.env;
    this.credentialRef = options.credentialRef;
    this.endpoint = (options.endpoint ?? OPENROUTER_DEFAULT_ENDPOINT).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  async discover(signal: AbortSignal): Promise<DiscoverySnapshot> {
    const headers: Record<string, string> = { accept: "application/json" };
    const secret = this.credentialRef === undefined ? undefined : resolveEnvironmentCredential(this.credentialRef, this.environment);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      if (secret) headers.authorization = `Bearer ${secret.reveal()}`;
      const response = await this.request(`${this.endpoint}/models`, { signal: AbortSignal.any([signal, timeout]), headers });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = redactUpstreamError(body.slice(0, ERROR_BODY_LIMIT));
        throw new CatalogDiscoveryError(
          parseCatalogStatus(response.status),
          `catalog request failed (${String(response.status)})${detail === "" ? "" : `: ${detail}`}`,
        );
      }
      const payload: unknown = await response.json().catch(() => {
        throw new CatalogDiscoveryError("invalid-response", "catalog response was not JSON");
      });
      const parsed = openRouterCatalogSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CatalogDiscoveryError("invalid-response", "catalog response did not match the OpenRouter /models shape");
      }
      return Object.freeze({
        source: this.sourceId,
        discoveredAt: new Date().toISOString(),
        models: Object.freeze(parsed.data.data.map((entry) => normalizeOpenRouterModel(entry))),
      });
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new CatalogDiscoveryError("api_error", "catalog discovery timed out");
      }
      throw error;
    } finally {
      secret?.dispose();
    }
  }
}

/** Static/reviewed catalog path: serves a validated snapshot (fixture file in the CLI, object in tests). */
export class StaticCatalogSource implements ProviderCatalogSource {
  readonly sourceId: string;
  constructor(
    public readonly providerId: string,
    private readonly snapshot: DiscoverySnapshot,
    sourceId = "static",
  ) {
    this.sourceId = sourceId;
  }

  discover(_signal: AbortSignal): Promise<DiscoverySnapshot> {
    void _signal;
    const parsed = discoverySnapshotSchema.safeParse(this.snapshot);
    if (!parsed.success) {
      return Promise.reject(new CatalogDiscoveryError("invalid-snapshot", "static catalog snapshot failed schema validation"));
    }
    return Promise.resolve(parsed.data as unknown as DiscoverySnapshot);
  }
}

/** Builds the configured catalog source for a provider. `api` is available for OpenRouter; `static` needs a snapshot. */
export function createCatalogSource(
  providerId: string,
  options: Readonly<{
    source?: CatalogSourceKind;
    snapshot?: DiscoverySnapshot;
    credentialRef?: CredentialRef;
    environment?: NodeJS.ProcessEnv;
    request?: typeof fetch;
  }> = {},
): ProviderCatalogSource {
  const kind = options.source ?? (providerId === "openrouter" ? "api" : "static");
  if (kind === "api") {
    if (providerId !== "openrouter") {
      throw new CatalogDiscoveryError("unavailable", `no API catalog source for provider ${providerId}; use --source static with --snapshot`);
    }
    return new OpenRouterCatalogSource({
      ...(options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.request === undefined ? {} : { request: options.request }),
    });
  }
  if (!options.snapshot) {
    throw new CatalogDiscoveryError("invalid-input", "static catalog source requires a snapshot (--snapshot <file>)");
  }
  return new StaticCatalogSource(providerId, options.snapshot);
}
