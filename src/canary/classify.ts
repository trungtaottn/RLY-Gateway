import type { CanaryGateResult, CanaryVerdict } from "./types.js";
import { gatesRequiredForEvidence } from "./types.js";

/**
 * Canary classification (#24).
 *
 * Semantics:
 * - `VERIFIED`: every required gate for the advertised RLY use of that exact
 *   access path passed AND live evidence exists for the provider class where a
 *   fake transport cannot prove the bridge (Codex OAuth / ClinePass / direct
 *   provider subscriptions). A fake-only matrix is never VERIFIED.
 * - `EXPERIMENTAL`: the access path is known/discovered or passes a partial
 *   matrix, but lacks required evidence for normal default exposure.
 * - `BROKEN`: a required contract is known to fail for the exact combination.
 * - `unknown`: required gates were not run (missing evidence). Missing/unrun
 *   evidence is never conflated with `BROKEN` and never reported as VERIFIED.
 */

export type LiveEvidencePolicy = "required-for-verified";

/**
 * Provider classes where live proof is required before normal exposure: a
 * protocol bridge (Codex OAuth, ClinePass) or a direct subscription (OpenRouter,
 * DeepSeek) may behave differently than a fake transport. Unknown adapters
 * fail closed (`required-for-verified`).
 */
export const ADAPTER_LIVE_POLICY: Readonly<Record<string, LiveEvidencePolicy>> = Object.freeze({
  "codex-oauth": "required-for-verified",
  "cline-interop": "required-for-verified",
  "openrouter-direct": "required-for-verified",
  "deepseek-direct": "required-for-verified",
});

export type ClassifyInput = Readonly<{
  results: readonly CanaryGateResult[];
  requiredGates: readonly string[];
  adapterId: string;
  /** True only when an opt-in live run actually passed for this exact path. */
  livePassed: boolean;
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
  // Every shipped provider class (Codex OAuth, ClinePass, direct OpenRouter/
  // DeepSeek) requires live proof before VERIFIED: a fake transport cannot
  // prove a subscription/bridge path. `ADAPTER_LIVE_POLICY` documents this per
  // adapter and is the single place a future optional-for-verified adapter
  // would be registered; unknown adapters fail closed (live required).
  if (!input.livePassed) {
    return { verdict: "EXPERIMENTAL", reason: "live-evidence-required" };
  }
  return { verdict: "VERIFIED" };
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
