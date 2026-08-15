import type { RegistryDocument } from "../registry/model-registry.js";
import { directProviderRegistry } from "../registry/model-registry.js";
import { CLAUDE_CODE_CONTRACT, CLIENT_CONTRACTS, CLAUDE_CODE_FIXTURE_BASELINE } from "./client-fixtures.js";
import {
  CANARY_RUNNER_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  claimIdentityFor,
  claimKeyFor,
  emptyClaimDocument,
  appendObservation,
  gateStatusToResult,
  type EvidenceArtifactV2,
  type CompatibilityClaimDocument,
} from "./claim.js";
import { classifyVerdict, requiredGatesFor } from "./classify.js";
import { detectInstalledClients, testedBaselineFor } from "./installed.js";
import { runGateMatrix } from "./matrix.js";
import type { CanaryEvidence, CanaryRunSummary, ClientKind, InstalledClient } from "./types.js";

/**
 * Canary runner (#24, evidence v2 by #122). Executes the deterministic fake
 * matrix over every reviewed access path (Layer A evidence), classifies each
 * path, probes the installed clients, and returns a secret-free summary with
 * feature-scoped Compatibility Claim + Evidence v2 documents. Never mutates
 * the trusted registry; when a control-plane directory is supplied the summary
 * is persisted by the caller through `CanaryStore` and the claim documents
 * through `ClaimEvidenceStore`.
 *
 * #122: there is no `livePassed`/`liveEvidence` boolean. The `RLY_LIVE_CANARY`
 * environment switch (or `liveRunnerEnabled`) may enable an opt-in runner hook
 * (#123), but it can never stand in for an evidence artifact — this run always
 * emits Layer A evidence only and never a VERIFIED verdict.
 */

export type RunCanaryOptions = Readonly<{
  registry?: RegistryDocument;
  environment?: Readonly<NodeJS.ProcessEnv>;
  client?: ClientKind;
  /**
   * Opt-in runner switch hook reserved for #123. Enabling it may START a
   * runner; it never creates evidence. This run emits Layer A only.
   */
  liveRunnerEnabled?: boolean;
  /** Deterministic clock override for tests. */
  now?: () => string;
  /** Deterministic platform metadata override for tests. */
  platform?: Readonly<{ platform: string; nodeVersion: string }>;
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

/** Runs the deterministic fake matrix for one exact access path (Layer A). */
export async function runCanary(options: RunCanaryOptions = {}): Promise<CanaryRunSummary> {
  const registry = options.registry ?? directProviderRegistry;
  const installed = await detectInstalledClients(options.environment ?? process.env);
  const client = options.client ?? "claude-code";
  const contract = CLIENT_CONTRACTS[client];
  const baseline = contract.baseline;
  const now = options.now ?? (() => new Date().toISOString());
  const environment = Object.freeze({
    platform: options.platform?.platform ?? process.platform,
    nodeVersion: options.platform?.nodeVersion ?? process.version,
  });
  const liveRunnerEnabled = options.liveRunnerEnabled
    ?? (options.environment?.[RLY_LIVE_CANARY_ENV] === "1");
  const results: CanaryEvidence[] = [];
  const evidence: EvidenceArtifactV2[] = [];
  const claimsByKey = new Map<string, CompatibilityClaimDocument>();
  for (const model of registry.models) {
    if (model.compatibility.state === "BROKEN") continue;
    const adapterId = adapterIdForProvider(model.identity.accessProviderId);
    const claimIdentity = claimIdentityFor({
      client,
      clientVersion: baseline,
      contract,
      adapterId,
      accessProviderId: model.identity.accessProviderId,
      physicalModelId: model.identity.upstreamModelId,
      ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }),
    });
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
      fakeMatrixRan: true,
    });
    // Feature-scoped Evidence Artifact v2 records: one per gate, Layer A.
    for (const gate of gateResults) {
      const claimKey = claimKeyFor(claimIdentity, gate.gate);
      const record: EvidenceArtifactV2 = Object.freeze({
        claimKey,
        feature: gate.gate,
        layer: "A",
        kind: "deterministic-fake-matrix",
        fixtureRevision: contract.fixtureRevision,
        runnerVersion: CANARY_RUNNER_VERSION,
        checkedAt: now(),
        result: gateStatusToResult(gate.status),
        ...(gate.reason === undefined ? {} : { failureReason: gate.reason }),
        environment,
      });
      evidence.push(record);
      const existing = claimsByKey.get(claimKey) ?? emptyClaimDocument(claimIdentity, gate.gate);
      claimsByKey.set(claimKey, appendObservation(existing, record));
    }
    results.push(Object.freeze({
      client,
      clientVersion: baseline,
      sourceProtocol: claimIdentity.sourceProtocol,
      protocolRevision: claimIdentity.protocolRevision,
      accessProviderId: model.identity.accessProviderId,
      adapterId,
      authMode: claimIdentity.authMode,
      endpointContract: claimIdentity.endpointContract,
      physicalModelId: model.identity.upstreamModelId,
      ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }),
      fixtureRevision: contract.fixtureRevision,
      testedGates: gateResults,
      checkedAt: now(),
      evidenceLayer: "A",
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
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    runnerVersion: CANARY_RUNNER_VERSION,
    evidence: Object.freeze(evidence),
    claims: Object.freeze([...claimsByKey.values()]),
    environment,
    liveRunner: Object.freeze({
      enabled: liveRunnerEnabled,
      evidenceEmitted: false,
      note: "installed-client/live runners are owned by #123; enabling only permits execution, never evidence",
    }),
    ...(ok ? {} : { error: "at-least-one-access-path-broken" }),
  });
}

/** Secret-free status view: tested baselines + latest per-path verdicts. */
export function canaryStatusSummary(
  summaries: readonly CanaryRunSummary[],
  installed?: Readonly<{ claude: InstalledClient; codex: InstalledClient }>,
): Record<string, unknown> {
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
          evidenceSchemaVersion: latest.evidenceSchemaVersion,
          clientBaseline: latest.clientBaseline,
          results: latest.results.map((result) => Object.freeze({
            accessProviderId: result.accessProviderId,
            physicalModelId: result.physicalModelId,
            adapterId: result.adapterId,
            evidenceLayer: result.evidenceLayer,
            verdict: result.verdict,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          })),
        }),
  });
}

export { CLAUDE_CODE_CONTRACT, CLAUDE_CODE_FIXTURE_BASELINE };
