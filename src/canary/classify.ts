import type { CanaryGateResult, CanaryVerdict } from "./types.js";
import { gatesRequiredForEvidence } from "./types.js";

/**
 * Canary classification (#24, semantics updated by #122).
 *
 * Semantics (v2 authority):
 * - `EXPERIMENTAL`: the access path's deterministic Layer A matrix passed (or
 *   partially passed) but the observation can never by itself establish a
 *   production Compatibility Claim. Layer B (installed client) and Layer C
 *   (live access path) evidence plus reviewed promotion (#124) are required
 *   before a path may be treated as production-trusted. A fake-only matrix is
 *   never `VERIFIED`.
 * - `BROKEN`: a required contract is known to fail for the exact combination.
 * - `unknown`: required gates were not run (missing evidence). Missing/unrun
 *   evidence is never conflated with `BROKEN` and never reported as VERIFIED.
 *
 * #122: `VERIFIED` is UNREACHABLE from any observation path. There is no
 * `livePassed`/`liveEvidence` boolean input; an opt-in runner switch only
 * enables execution and can never stand in for an evidence artifact.
 */

export type ClassifyInput = Readonly<{
  results: readonly CanaryGateResult[];
  requiredGates: readonly string[];
  adapterId: string;
  fakeMatrixRan: boolean;
}>;

export function classifyVerdict(input: ClassifyInput): Readonly<{ verdict: CanaryVerdict; reason?: string }> {
  if (!input.fakeMatrixRan) {
    return { verdict: "unknown", reason: "fake-matrix-not-run" };
  }
  const required = new Set(input.requiredGates);
  for (const result of input.results) {
    if (!required.has(result.gate)) continue;
    if (result.status === "failed") {
      return { verdict: "BROKEN", reason: result.reason ?? "required-gate-failed" };
    }
    if (result.status === "not-run") {
      return { verdict: "unknown", reason: `${result.gate}-not-run` };
    }
  }
  // Every required gate passed for the exact access path — a real deterministic
  // Layer A observation, but not production trust. The canary has no boolean
  // that can grant a reviewed Compatibility Claim: installed-client (B) and
  // live access-path (C) evidence plus explicit reviewed promotion (#124) are
  // required, and none of them is derivable from this run.
  return { verdict: "EXPERIMENTAL", reason: "production-claim-not-established" };
}

/** Gates required for this exact access path based on its reviewed evidence. */
export function requiredGatesFor(evidence: Readonly<{
  capabilities: Readonly<{ tools: boolean; parallelTools: boolean; reasoning: boolean }>;
  reasoning: Readonly<{ reasoningWithTools: boolean }>;
}>): readonly string[] {
  return gatesRequiredForEvidence(evidence).map((gate) => gate as string);
}

/** Summary counts for the CLI/status view. */
export function summarizeGates(results: readonly CanaryGateResult[]): Readonly<{
  passed: number;
  failed: number;
  notRun: number;
}> {
  return Object.freeze({
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    notRun: results.filter((result) => result.status === "not-run").length,
  });
}
