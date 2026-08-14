import type { ProviderRecord } from "../control-plane/types.js";
import type { SecretHandle } from "../credentials/env-resolver.js";
import { AlibabaAdapter } from "./direct/alibaba-adapter.js";
import { DeepSeekAdapter } from "./direct/deepseek-adapter.js";
import { OpenCodeGoAdapter } from "./direct/opencode-go-adapter.js";
import { OpenRouterAdapter } from "./direct/openrouter-adapter.js";
import { AntigravityBridgeAdapter, ANTIGRAVITY_IDENTITY } from "./bridge/antigravity.js";
import { adapterIdForProvider } from "./catalog.js";
import { ClineInteropAdapter } from "./interop/cline-adapter.js";
import { ClaudeOAuthAdapter } from "./oauth/claude/adapter.js";
import { CodexOAuthAdapter } from "./oauth/codex/adapter.js";
import { GeminiOAuthAdapter } from "./oauth/gemini/adapter.js";
import { ProviderAdapterError, type ProviderAdapter } from "./provider-adapter.js";

export function adapterIdFor(provider: ProviderRecord): string {
  return adapterIdForProvider(provider.name, provider.integrationMode);
}

export function createProviderAdapter(input: Readonly<{
  provider: ProviderRecord;
  request: typeof fetch;
  environment: NodeJS.ProcessEnv;
  accessToken?: SecretHandle;
  accountId?: SecretHandle;
}>): ProviderAdapter {
  const endpoint = input.provider.endpointPolicy;
  const adapterId = adapterIdFor(input.provider);
  if (adapterId === "gemini-oauth") return new GeminiOAuthAdapter(input.request, requireToken(adapterId, input.accessToken), endpoint);
  if (adapterId === "claude-oauth") return new ClaudeOAuthAdapter(input.request, requireToken(adapterId, input.accessToken), endpoint ?? "https://api.anthropic.com");
  if (adapterId === "codex-oauth") return new CodexOAuthAdapter(input.request, requireToken(adapterId, input.accessToken), endpoint, input.accountId);
  if (adapterId === "cline-interop") return new ClineInteropAdapter(input.request, requireToken(adapterId, input.accessToken), endpoint);
  if (adapterId === "antigravity-bridge") {
    return new AntigravityBridgeAdapter(input.request, {
      baseUrl: endpoint ?? "http://127.0.0.1:17874",
      expectedIdentity: ANTIGRAVITY_IDENTITY,
      expectedProtocolVersion: 1,
    }, input.accessToken);
  }
  if (adapterId === "opencode-go-direct") return new OpenCodeGoAdapter(input.request, endpoint, input.environment);
  if (adapterId === "alibaba-direct") return new AlibabaAdapter(input.request, endpoint, input.environment);
  if (adapterId === "deepseek-direct") return new DeepSeekAdapter(input.request, endpoint, input.environment);
  if (adapterId === "openrouter-direct") return new OpenRouterAdapter(input.request, endpoint, input.environment);
  throw new ProviderAdapterError("unavailable", `unknown adapter ${adapterId}`);
}

function requireToken(adapterId: string, token: SecretHandle | undefined): SecretHandle {
  if (!token) throw new ProviderAdapterError("unauthenticated", `${adapterId} requires a request-scoped credential`);
  return token;
}
