import type { FidelitySourceProtocol } from "../core/fidelity.js";
import type { CompatibilityState } from "../registry/model-registry.js";

/**
 * Runtime compatibility canary types (#24 / BL-043, extended by #122).
 *
 * The canary answers two separate questions and never collapses them:
 *  1. client compatibility — does this Claude Code / Codex CLI version still
 *     produce/consume the wire behavior RLY expects?
 *  2. model access-path compatibility — does this exact
 *     (access provider, physical model, RLY adapter, client baseline) support
 *     the runtime capabilities RLY claims?
 *
 * #122 turns the raw observations into feature-scoped, versioned Compatibility
 * Claim + Evidence v2 documents (`src/canary/claim.ts`). The deterministic
 * fake matrix is reclassified as Layer A evidence; a Layer A pass alone never
 * establishes a production compatibility claim (layers B/C plus reviewed
 * promotion are required). `livePassed`/`liveEvidence` booleans no longer
 * exist on the authoritative classification path.
 */

/**
 * Evidence layer of one observation (#122).
 * - `A` — deterministic protocol/adapter conformance against fake/synthetic
 *   fixtures (the current canary gate matrix).
 * - `B` — exact installed-client black-box behavior (#123, runner not built).
 * - `C` — exact real access-path live verification (#123, runner not built).
 *
 * Layer presence/result is explicit per record; a claim never collapses its
 * layers into one boolean.
 */
export type EvidenceLayer = "A" | "B" | "C";

/** Result of one evidence observation. `missing` is the ABSENCE of a record. */
export type EvidenceResult = "passed" | "failed" | "not-run";

/**
 * Authentication mode of the exact access path (part of claim identity).
 * `unknown` is a fail-closed identity: it is never omitted from the key and
 * never promoted.
 */
export type AuthMode = "oauth" | "direct-api-key" | "interop-import" | "bridge" | "unknown";

/** Client-facing endpoint wire contract the claim is about. */
export const ENDPOINT_CONTRACTS = ["anthropic-messages", "openai-responses"] as const;
export type EndpointContract = (typeof ENDPOINT_CONTRACTS)[number];

/**
 * Compatible source-protocol vocabulary shared with the #119 fidelity
 * envelope so a claim's protocol identity references the same surfaces.
 */
export type ClaimSourceProtocol = FidelitySourceProtocol;

export type ClientKind = "claude-code" | "codex-cli";

/** The exact installed client identity: kind + executable + version probe. */
export type InstalledClient = Readonly<{
  kind: ClientKind;
  found: boolean;
  executable: string;
  version?: string;
  versionSource: "cli-output" | "unknown";
}>;

/**
 * Capability gates evaluated by the canary matrix. Each gate pins a contract
 * the higher-level features (#67-#72) depend on; a gate is evaluated for an
 * exact access path, never for an upstream model name alone.
 */
export type CanaryGate =
  | "text"
  | "streaming"
  | "cancellation"
  | "tools-single"
  | "tools-multi"
  | "tools-parallel"
  | "reasoning"
  | "reasoning-tools"
  | "model-discovery"
  | "session-attribution"
  | "subagent-routing"
  | "subagent-parallel"
  | "effort-signal"
  | "long-running-session";

export const CANARY_GATES: readonly CanaryGate[] = Object.freeze([
  "text",
  "streaming",
  "cancellation",
  "tools-single",
  "tools-multi",
  "tools-parallel",
  "reasoning",
  "reasoning-tools",
  "model-discovery",
  "session-attribution",
  "subagent-routing",
  "subagent-parallel",
  "effort-signal",
  "long-running-session",
]);

/** Gates required before an access path may be classified VERIFIED. */
export const REQUIRED_VERIFIED_GATES: readonly CanaryGate[] = Object.freeze([
  "text",
  "streaming",
  "cancellation",
  "tools-single",
  "reasoning",
  "model-discovery",
  "session-attribution",
  "effort-signal",
  "long-running-session",
]);

/** Which gates the access path's own capability evidence makes mandatory. */
export function gatesRequiredForEvidence(evidence: Readonly<{
  capabilities: Readonly<{ tools: boolean; parallelTools: boolean; reasoning: boolean }>;
  reasoning: Readonly<{ reasoningWithTools: boolean }>;
}>): readonly CanaryGate[] {
  const gates = new Set<CanaryGate>(REQUIRED_VERIFIED_GATES);
  if (evidence.capabilities.tools) {
    gates.add("tools-multi");
  }
  if (evidence.capabilities.parallelTools) {
    gates.add("tools-parallel");
  }
  if (evidence.reasoning.reasoningWithTools) {
    gates.add("reasoning-tools");
  }
  if (evidence.capabilities.reasoning) {
    gates.add("reasoning");
  }
  return Object.freeze([...gates]);
}

export type GateStatus = "passed" | "failed" | "not-run";

/** Alias: a gate status is one evidence result; `missing` is record absence. */
export type GateResultStatus = EvidenceResult;

export type CanaryGateResult = Readonly<{
  gate: CanaryGate;
  status: GateStatus;
  /** Typed reason when failed/not-run, e.g. `missing-agent-header`. */
  reason?: string;
}>;

export type CanaryVerdict = CompatibilityState | "unknown";

/**
 * Machine-readable canary evidence for ONE exact access path. Scoped narrowly
 * enough to prevent false reuse: the same upstream model through Codex vs
 * ClinePass vs OpenRouter never shares a result.
 */
export type CanaryEvidence = Readonly<{
  client: ClientKind;
  /** Exact tested client baseline, e.g. `claude-code-2.1.229`. */
  clientVersion: string;
  /** Client-facing source protocol (#119 fidelity vocabulary). */
  sourceProtocol: ClaimSourceProtocol;
  /** Pinned client-contract revision (fixture corpus) backing the observation. */
  protocolRevision: string;
  accessProviderId: string;
  adapterId: string;
  authMode: AuthMode;
  endpointContract: EndpointContract;
  physicalModelId: string;
  modelFamily?: string;
  fixtureRevision: string;
  testedGates: readonly CanaryGateResult[];
  checkedAt: string;
  /** Evidence layer that produced this record (#122): the canary is Layer A. */
  evidenceLayer: EvidenceLayer;
  /** Final classification for this exact access path (never VERIFIED from an observation). */
  verdict: CanaryVerdict;
  reason?: string;
}>;

/** Secret-free, deterministic canary run summary (the CLI/diagnostic view). */
export type CanaryRunSummary = Readonly<{
  ok: boolean;
  clientBaseline: string;
  installed: readonly InstalledClient[];
  results: readonly CanaryEvidence[];
  /** #122: evidence schema version of this run's artifacts (2 = v2 claim/evidence). */
  evidenceSchemaVersion: number;
  /** #122: runner/tool version that produced the evidence. */
  runnerVersion: string;
  /** #122: flat list of feature-scoped Evidence Artifact v2 records. */
  evidence: readonly EvidenceArtifactV2[];
  /** #122: per-feature Compatibility Claim documents for this run. */
  claims: readonly CompatibilityClaimDocument[];
  /** #122: environment/platform metadata needed to interpret the evidence. */
  environment: Readonly<{ platform: string; nodeVersion: string }>;
  /** #122: opt-in runner switch state (never evidence by itself). */
  liveRunner: Readonly<{ enabled: boolean; evidenceEmitted: false; note: string }>;
  artifactPath?: string;
  error?: string;
  /** Set by `CanaryStore.list()` for pre-v2 (legacy) artifacts only. */
  legacy?: boolean;
  legacyReason?: string;
}>;

import type { EvidenceArtifactV2, CompatibilityClaimDocument } from "./claim.js";

/** What one changed client contract assumption would break, for diagnostics. */
export type ContractDrift = Readonly<{
  fixtureRevision: string;
  baseline: string;
  drift: readonly CanaryGateResult[];
}>;
