import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import type { RouteDecision } from "../../core/route-decision.js";
import { ProviderAdapterError, type ProviderAdapter, type ProviderProbe } from "../provider-adapter.js";
import { OpenAiChatAdapter } from "../direct/openai-chat-adapter.js";
import { SecretHandle } from "../../credentials/env-resolver.js";

export const ANTIGRAVITY_ADAPTER_ID = "antigravity-bridge";
export const ANTIGRAVITY_IDENTITY = "rly-gateway-antigravity-bridge";
const PROTECTED_PORTS = new Set([10100, 8317, 17870]);

export type AntigravityBridgeConfig = Readonly<{
  baseUrl: string;
  expectedIdentity: string;
  expectedProtocolVersion: number;
}>;

export function parseBridgeUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1") throw new ProviderAdapterError("invalid", "antigravity bridge must be loopback");
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  if (PROTECTED_PORTS.has(port)) throw new ProviderAdapterError("invalid", "antigravity bridge cannot use a protected port");
  return url;
}

export class AntigravityBridgeAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY_ADAPTER_ID;

  public constructor(
    private readonly request: typeof fetch,
    private readonly config: AntigravityBridgeConfig,
    private readonly accessToken?: SecretHandle,
  ) {
    parseBridgeUrl(config.baseUrl);
  }

  public async probe(decision: RouteDecision, signal: AbortSignal): Promise<ProviderProbe> {
    const response = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/identity`, { method: "GET", signal });
    if (!response.ok) return probeResult(decision, "unavailable");
    const body = await response.json() as { product?: unknown; protocolVersion?: unknown };
    if (body.product !== this.config.expectedIdentity || body.protocolVersion !== this.config.expectedProtocolVersion) {
      return probeResult(decision, "unavailable");
    }
    return probeResult(decision, "ready");
  }

  public async *invoke(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    const probe = await this.probe(decision, signal);
    if (probe.readiness !== "ready") throw new ProviderAdapterError("unavailable", "antigravity bridge identity mismatch");
    const token = this.accessToken ?? new SecretHandle("bridge");
    try {
      const adapter = new BridgeChatAdapter(this.request, token, this.config.baseUrl);
      yield* adapter.invoke(request, decision, signal);
    } finally {
      if (!this.accessToken) token.dispose();
    }
  }
}

function probeResult(decision: RouteDecision, readiness: ProviderProbe["readiness"]): ProviderProbe {
  return { providerId: decision.providerId, modelId: decision.modelId, readiness, checkedAt: new Date().toISOString() };
}

class BridgeChatAdapter extends OpenAiChatAdapter {
  readonly id = ANTIGRAVITY_ADAPTER_ID;
  protected readonly endpoint: string;
  protected override ownsSecret = false;
  public constructor(request: typeof fetch, private readonly token: SecretHandle, endpoint: string) {
    super(request, endpoint);
    this.endpoint = endpoint.replace(/\/$/, "");
  }
  protected override resolveSecret(): SecretHandle {
    return this.token;
  }
}
