import type { ProviderCapabilities } from "../core/capabilities.js";
import { ValidationError } from "../control-plane/errors.js";
import type { IntegrationMode } from "../control-plane/types.js";
import { ProviderAdapterError } from "./provider-adapter.js";

export const CREDENTIAL_PROVIDERS = ["codex", "gemini", "claude", "cline"] as const;
export type CredentialProviderName = (typeof CREDENTIAL_PROVIDERS)[number];

export type ProviderOwnership = "direct-api" | "project-oauth" | "attested-bridge" | "explicit-interop";
export type ProviderImportMode = "none" | "explicit-readonly" | "opt-in-interoperability";

export type ProviderContract = Readonly<{
  id: string;
  name: string;
  adapterId: string;
  integrationMode: IntegrationMode;
  ownership: ProviderOwnership;
  importMode: ProviderImportMode;
  credentialProvider?: CredentialProviderName;
  termsGated: boolean;
  defaultTermsRevision?: string;
  localOnly: boolean;
  defaultEndpoint: string;
  capabilities: ProviderCapabilities;
  liveEvidence: "opt-in";
}>;

const conservative: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
});

function entry(spec: Readonly<{
  id: string;
  adapterId: string;
  integrationMode: IntegrationMode;
  ownership: ProviderOwnership;
  importMode?: ProviderImportMode;
  credentialProvider?: CredentialProviderName;
  termsGated?: boolean;
  defaultTermsRevision?: string;
  localOnly?: boolean;
  defaultEndpoint: string;
  capabilities?: ProviderCapabilities;
}>): ProviderContract {
  return Object.freeze({
    id: spec.id,
    name: spec.id,
    adapterId: spec.adapterId,
    integrationMode: spec.integrationMode,
    ownership: spec.ownership,
    importMode: spec.importMode ?? "none",
    ...(spec.credentialProvider === undefined ? {} : { credentialProvider: spec.credentialProvider }),
    termsGated: spec.termsGated ?? false,
    ...(spec.defaultTermsRevision === undefined ? {} : { defaultTermsRevision: spec.defaultTermsRevision }),
    localOnly: spec.localOnly ?? false,
    defaultEndpoint: spec.defaultEndpoint,
    capabilities: spec.capabilities ?? conservative,
    liveEvidence: "opt-in",
  });
}

export const PROVIDER_CATALOG: readonly ProviderContract[] = Object.freeze([
  entry({
    id: "openrouter", adapterId: "openrouter-direct", integrationMode: "direct",
    ownership: "direct-api", defaultEndpoint: "https://openrouter.ai/api/v1",
  }),
  entry({
    id: "deepseek", adapterId: "deepseek-direct", integrationMode: "direct",
    ownership: "direct-api", defaultEndpoint: "https://api.deepseek.com",
  }),
  entry({
    id: "codex", adapterId: "codex-oauth", integrationMode: "oauth",
    ownership: "project-oauth", importMode: "explicit-readonly", credentialProvider: "codex",
    defaultEndpoint: "https://chatgpt.com/backend-api/codex",
  }),
  entry({
    id: "gemini", adapterId: "gemini-oauth", integrationMode: "oauth",
    ownership: "project-oauth", importMode: "explicit-readonly", credentialProvider: "gemini",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
  }),
  entry({
    id: "antigravity", adapterId: "antigravity-bridge", integrationMode: "bridge",
    ownership: "attested-bridge", localOnly: true, defaultEndpoint: "http://127.0.0.1:17874",
  }),
  entry({
    id: "cline", adapterId: "cline-interop", integrationMode: "oauth",
    ownership: "explicit-interop", importMode: "opt-in-interoperability", credentialProvider: "cline",
    localOnly: true, defaultEndpoint: "",
  }),
  entry({
    id: "claude", adapterId: "claude-oauth", integrationMode: "oauth",
    ownership: "project-oauth", importMode: "explicit-readonly", credentialProvider: "claude",
    defaultEndpoint: "https://api.anthropic.com",
    capabilities: Object.freeze({
      streaming: false, tools: false, parallelTools: false, images: false, reasoning: false,
      redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const,
    }),
  }),
  entry({
    id: "opencode-go", adapterId: "opencode-go-direct", integrationMode: "direct",
    ownership: "direct-api", defaultEndpoint: "https://opencode.ai/zen/go/v1",
  }),
  entry({
    id: "alibaba", adapterId: "alibaba-direct", integrationMode: "direct",
    ownership: "direct-api", termsGated: true, localOnly: true,
    defaultTermsRevision: "alibaba-terms-1",
    defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
]);

export function providerContract(name: string): ProviderContract | undefined {
  return PROVIDER_CATALOG.find((item) => item.name === name || item.id === name);
}

const PROTECTED_PORTS = new Set([10100, 8317, 17870]);

export function assertSafeEndpointPolicy(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError("endpoint policy must be a URL");
  }
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : Number.NaN);
  if (PROTECTED_PORTS.has(port)) throw new ValidationError("endpoint policy cannot use a protected port");
  const loopback = url.hostname === "127.0.0.1";
  if (!loopback && url.protocol !== "https:") {
    throw new ValidationError("endpoint policy must be loopback or https");
  }
}

export function applyCatalogDefaults(input: Readonly<{
  name: string;
  integrationMode: IntegrationMode;
  endpointPolicy?: string | undefined;
  requiredTermsRevision?: string | undefined;
}>): Readonly<{
  endpointPolicy: string | undefined;
  requiredTermsRevision: string | undefined;
}> {
  const contract = providerContract(input.name);
  if (!contract) throw new ValidationError(`unknown provider ${input.name}`);
  if (contract.integrationMode !== input.integrationMode) {
    throw new ValidationError(`provider ${input.name} requires integration mode ${contract.integrationMode}`);
  }
  const endpointPolicy = input.endpointPolicy || contract.defaultEndpoint || undefined;
  if (!endpointPolicy) throw new ValidationError(`provider ${input.name} requires an endpoint policy`);
  assertSafeEndpointPolicy(endpointPolicy);
  return {
    endpointPolicy,
    requiredTermsRevision: input.requiredTermsRevision ?? contract.defaultTermsRevision,
  };
}

export function adapterIdForProvider(name: string, integrationMode: IntegrationMode): string {
  const contract = providerContract(name);
  if (!contract || contract.integrationMode !== integrationMode) {
    throw new ProviderAdapterError("unavailable", `unknown provider ${name}/${integrationMode}`);
  }
  return contract.adapterId;
}
