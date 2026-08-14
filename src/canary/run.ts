import type { RegistryDocument } from "../registry/model-registry.js";
import { directProviderRegistry } from "../registry/model-registry.js";
import { CLAUDE_CODE_CONTRACT, CLIENT_CONTRACTS, CLAUDE_CODE_FIXTURE_BASELINE } from "./client-fixtures.js";
import { classifyVerdict, requiredGatesFor } from "./classify.js";
import { detectInstalledClients, testedBaselineFor } from "./installed.js";
import { runGateMatrix } from "./matrix.js";
import type { CanaryEvidence, CanaryRunSummary, ClientKind, InstalledClient } from "./types.js";

/**
 * Canary runner (#24). Executes the deterministic fake matrix over every
 * reviewed access path, classifies each path, probes the installed clients,
 * and returns a secret-free summary. Never mutates the trusted registry; when
 * a control-plane directory is supplied the summary is persisted by the caller
 * through `CanaryStore`.
 */

export type RunCanaryOptions = Readonly<{
  registry?: RegistryDocument;
  environment?: Readonly<NodeJS.ProcessEnv>;
  client?: ClientKind;
  /** Explicit opt-in live evidence for this exact run (skip ≠ pass). */
  liveEvidence?: boolean;
  /** Deterministic clock override for tests. */
  now?: () => string;
}>;

export const RLY_LIVE_CANARY_ENV = "RLY_LIVE_CANARY";

/** Adapter/integration mode for one access provider (evidence identity). */
export function adapterIdForProvider(providerId: string): string {
  switch (providerId) {
    case "openrouter": return "openrouter-direct";
    case "deepseek": return "deepseek-direct";
    case "codex": return "codex-oauth";
    case "cline": return "cline-interop";
    default: return `${providerId}-adapter`;
  }
}

/** Runs the deterministic fake matrix for one exact access path. */
export async function runCanary(options: RunCanaryOptions = {}): Promise<CanaryRunSummary> {
  const registry = options.registry ?? directProviderRegistry;
  const installed = await detectInstalledClients(options.environment ?? process.env);
  const client = options.client ?? "claude-code";
  const contract = CLIENT_CONTRACTS[client];
  const baseline = contract.baseline;
  const liveEvidence = options.liveEvidence ?? false;
  const now = options.now ?? (() => new Date().toISOString());
  const results: CanaryEvidence[] = [];
  for (const model of registry.models) {
    if (model.compatibility.state === "BROKEN") continue;
    const adapterId = adapterIdForProvider(model.identity.accessProviderId);
    const gateResults = runGateMatrix({
      clientBaseline: baseline,
      accessProviderId: model.identity.accessProviderId,
      adapterId,
      physicalModelId: model.identity.upstreamModelId,
      ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }),
      evidence: model,
      contract,
    });
    const required = requiredGatesFor({
      capabilities: {
        tools: model.capabilities.tools,
        parallelTools: model.capabilities.parallelTools,
        reasoning: model.capabilities.reasoning,
      },
      reasoning: { reasoningWithTools: model.reasoning.reasoningWithTools },
    });
    const classified = classifyVerdict({
      results: gateResults,
      requiredGates: required,
      adapterId,
      livePassed: liveEvidence,
      fakeMatrixRan: true,
    });
    results.push(Object.freeze({
      client,
      clientVersion: baseline,
      accessProviderId: model.identity.accessProviderId,
      adapterId,
      physicalModelId: model.identity.upstreamModelId,
      ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }),
      fixtureRevision: contract.fixtureRevision,
      testedGates: gateResults,
      checkedAt: now(),
      evidenceKind: liveEvidence ? "live" : "fake",
      verdict: classified.verdict,
      ...(classified.reason === undefined ? {} : { reason: classified.reason }),
    }));
  }
  const ok = results.every((result) => result.verdict !== "BROKEN");
  return Object.freeze({
    ok,
    clientBaseline: baseline,
    installed: Object.freeze([installed.claude, installed.codex]),
    results: Object.freeze(results),
    ...(ok ? {} : { error: "at-least-one-access-path-broken" }),
  });
}

/** Secret-free status view: tested baselines + latest per-path verdicts. */
export function canaryStatusSummary(
  summaries: readonly CanaryRunSummary[],
  installed?: Readonly<{ claude: InstalledClient; codex: InstalledClient }>,
): unknown {
  const latest = summaries.length === 0 ? undefined : summaries[summaries.length - 1];
  return Object.freeze({
    testedBaselines: Object.freeze({
      claudeCode: testedBaselineFor("claude-code"),
      codexCli: testedBaselineFor("codex-cli"),
    }),
    installed: installed === undefined
      ? undefined
      : Object.freeze({
          claude: Object.freeze({ found: installed.claude.found, executable: installed.claude.executable, ...(installed.claude.version === undefined ? {} : { version: installed.claude.version }), versionSource: installed.claude.versionSource }),
          codex: Object.freeze({ found: installed.codex.found, executable: installed.codex.executable, ...(installed.codex.version === undefined ? {} : { version: installed.codex.version }), versionSource: installed.codex.versionSource }),
        }),
    ...(latest === undefined
      ? { hasArtifacts: false }
      : {
          hasArtifacts: true,
          clientBaseline: latest.clientBaseline,
          results: latest.results.map((result) => Object.freeze({
            accessProviderId: result.accessProviderId,
            physicalModelId: result.physicalModelId,
            adapterId: result.adapterId,
            verdict: result.verdict,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          })),
        }),
  });
}

export { CLAUDE_CODE_CONTRACT, CLAUDE_CODE_FIXTURE_BASELINE };
