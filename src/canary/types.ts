import type { CompatibilityState } from "../registry/model-registry.js";

/**
 * Runtime compatibility canary types (#24 / BL-043).
 *
 * The canary answers two separate questions and never collapses them:
 *  1. client compatibility — does this Claude Code / Codex CLI version still
 *     produce/consume the wire behavior RLY expects?
 *  2. model access-path compatibility — does this exact
 *     (access provider, physical model, RLY adapter, client baseline) support
 *     the runtime capabilities RLY claims?
 */

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

export type CanaryGateResult = Readonly<{
  gate: CanaryGate;
  status: GateStatus;
  /** Typed reason when failed/not-run, e.g. `missing-agent-header`. */
  reason?: string;
}>;

export type EvidenceKind = "fake" | "live";

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
  accessProviderId: string;
  adapterId: string;
  physicalModelId: string;
  modelFamily?: string;
  fixtureRevision: string;
  testedGates: readonly CanaryGateResult[];
  checkedAt: string;
  evidenceKind: EvidenceKind;
  /** Final classification for this exact access path. */
  verdict: CanaryVerdict;
  reason?: string;
}>;

/** Secret-free, deterministic canary run summary (the CLI/diagnostic view). */
export type CanaryRunSummary = Readonly<{
  ok: boolean;
  clientBaseline: string;
  installed: readonly InstalledClient[];
  results: readonly CanaryEvidence[];
  artifactPath?: string;
  error?: string;
}>;

/** What one changed client contract assumption would break, for diagnostics. */
export type ContractDrift = Readonly<{
  fixtureRevision: string;
  baseline: string;
  drift: readonly CanaryGateResult[];
}>;
