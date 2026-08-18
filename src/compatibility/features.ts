import { createHash } from "node:crypto";
import type { CapabilityRequirement } from "../core/capabilities.js";
import type { ClaimFeature } from "../canary/claim.js";
import type { ReasoningRequirement } from "../routing/model-selection/types.js";

/**
 * Evidence-revision + feature-requirement helpers for the Effective
 * Compatibility Registry (#124).
 *
 * `evidenceRevisionFor` binds a Review Decision to the EXACT evidence snapshot
 * it was made against: the digest changes whenever a genuinely new observation
 * is appended (identical observations are deduped by `appendObservation`, so a
 * re-run of the same canary keeps the same revision). A decision whose
 * `evidenceRevision` no longer matches the current claim document does NOT
 * cover the current evidence — the claim needs re-review. This is the
 * "evidence update without promotion" invariant.
 */

/** Deterministic digest of a claim document's full observation history. */
export function evidenceRevisionFor(doc: Readonly<{ records: readonly unknown[] }>): string {
  const serialized = JSON.stringify(doc.records);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * RLY-reliance features a model/access path must effectively trust before it
 * may be EXPOSED through runtime discovery/projection by default (#124).
 * Mirrors the canary's `REQUIRED_VERIFIED_GATES` feature set: text, streaming,
 * cancellation, single-tool, reasoning, model discovery, session attribution,
 * effort signal, and long-running-session behavior on the exact path.
 */
export const REQUIRED_RLY_FEATURES: readonly ClaimFeature[] = Object.freeze([
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

/** Feature claims a request's capability requirements demand (enforcement). */
export function requiredFeaturesForCapabilities(
  capabilities: readonly CapabilityRequirement[],
  reasoning?: ReasoningRequirement,
): readonly ClaimFeature[] {
  const features = new Set<ClaimFeature>(["text", "cancellation"]);
  if (capabilities.includes("streaming")) features.add("streaming");
  if (capabilities.includes("tools")) {
    features.add("tools-single");
    features.add("tools-multi");
  }
  if (capabilities.includes("parallelTools")) features.add("tools-parallel");
  if (capabilities.includes("reasoning")) features.add("reasoning");
  if (capabilities.includes("redactedReasoning")) features.add("reasoning");
  if (reasoning?.required === true) features.add("reasoning");
  if (reasoning?.withTools === true) features.add("reasoning-tools");
  if (capabilities.includes("reasoning") && reasoning?.withTools === true) features.add("reasoning-tools");
  return Object.freeze([...features]);
}

/** Feature claims a model's reviewed capability evidence demands (projection). */
export function requiredFeaturesForEvidence(evidence: Readonly<{
  capabilities: Readonly<{ tools: boolean; parallelTools: boolean; reasoning: boolean }>;
  reasoning: Readonly<{ supported: boolean; reasoningWithTools: boolean }>;
}>): readonly ClaimFeature[] {
  const features = new Set<ClaimFeature>([...REQUIRED_RLY_FEATURES]);
  if (evidence.capabilities.tools) features.add("tools-multi");
  if (evidence.capabilities.parallelTools) features.add("tools-parallel");
  if (evidence.capabilities.reasoning) features.add("reasoning");
  if (evidence.reasoning.reasoningWithTools) features.add("reasoning-tools");
  return Object.freeze([...features]);
}
