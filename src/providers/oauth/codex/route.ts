import type { CanonicalEvent } from "../../../core/canonical-event.js";
import type { CanonicalRequest } from "../../../core/canonical-request.js";
import { decideRoute, type RouteRecord } from "../../../core/router.js";
import type { CredentialBroker } from "../../../credentials/broker.js";
import type { CredentialService } from "../../../credentials/service.js";
import { conservativeTokenCount } from "../../../core/token-counting.js";
import type { CanonicalUpstream } from "../../../protocols/anthropic/fake-upstream.js";
import { CodexOAuthAdapter, CODEX_OAUTH_ADAPTER_ID } from "./adapter.js";

const CODEX_CAPABILITIES = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate" as const,
});

export type ResolvedOauthRoute = Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }>;

export function createCodexOauthRouteResolver(
  credentials: CredentialService,
  broker: CredentialBroker,
  configFingerprint: string,
  request: typeof fetch = fetch,
  endpoint?: string,
): (canonical: CanonicalRequest) => Promise<ResolvedOauthRoute | undefined> {
  return async (canonical) => {
    const account = await credentials.resolveSelected();
    if (!account) return undefined;
    const route: RouteRecord = {
      role: "primary",
      providerId: "codex",
      modelId: canonical.requestedModel,
      adapterId: CODEX_OAUTH_ADAPTER_ID,
      credentialRef: { kind: "handle", handle: account.credentialHandle },
      capabilities: CODEX_CAPABILITIES,
    };
    const decision = decideRoute({
      requestId: canonical.id,
      route,
      required: [],
      configFingerprint,
      accountPseudonym: account.pseudonym,
      credentialGeneration: account.credentialGeneration,
    });
    return {
      route,
      upstream: {
        invoke: async function* (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
          const scoped = await broker.resolve(account.credentialHandle);
          try {
            const adapter = new CodexOAuthAdapter(request, scoped.accessToken, endpoint, scoped.accountId);
            yield* adapter.invoke(canonical, decision, signal);
          } finally {
            scoped.dispose();
          }
        },
        countTokens: () => Promise.resolve(conservativeTokenCount(canonical)),
      },
    };
  };
}
