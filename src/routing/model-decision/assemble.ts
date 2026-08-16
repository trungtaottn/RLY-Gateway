/**
 * EffectiveModelDecision assembly (#127).
 *
 * The assembler is a PURE recorder: every input is produced by the existing
 * components (#68 model selection, #69 tier resolver, #70 reasoning
 * translation, #71 parent context, #72 projection, #124 ECR, #125 intent
 * classification, #126 env/settings ownership) and the assembler derives the
 * precedence bookkeeping, visible conflicts, blocked alternatives, and the
 * stable reason list. It never re-resolves a model, tier, projection, or
 * compatibility answer and never touches accounts or credentials.
 *
 * The only external read is `readPersistedViewModel`: a bounded, best-effort
 * read of the OWNING profile view's RLY-owned persisted `claude-rly-*` model
 * (routing metadata, never settings content) so persisted-view provenance and
 * stale/foreign projection conflicts are visible instead of silent.
 */

import { readFile } from "node:fs/promises";
import type { ModelIntentKind } from "../model-intent/types.js";
import type { ModelSelectionTrace } from "../model-selection/types.js";
import type { SettingsOwnershipSummary } from "../../runtime/claude-overlay.js";
import { GATEWAY_CONTRACT_ENV_KEYS, claudeOverlayPaths, rlyOwnedModel } from "../../runtime/claude-overlay.js";
import { PRECEDENCE_ORDER, MODEL_DECISION_SCHEMA_VERSION } from "./types.js";
import type {
  DecisionResolutionPath,
  EffectiveModelDecision,
  EffectiveModelDecisionInput,
  ModelDecisionBlockedAlternative,
  ModelDecisionConflict,
  ModelDecisionReason,
  PrecedenceSource,
} from "./types.js";
import type { EffectiveCompatibilityLabel } from "../../compatibility/types.js";

/** Deterministic intent-kind → precedence-source mapping (#125 kinds). */
export function precedenceSourceForIntent(kind: ModelIntentKind): PrecedenceSource {
  switch (kind) {
    case "EXACT_PROJECTION": return "exact-projection";
    case "RLY_LOGICAL_TIER": return "explicit-rly-tier";
    case "CLIENT_NATIVE_ALIAS": return "client-native-alias";
    case "EXACT_CLIENT_MODEL": return "exact-client-model";
    case "INHERIT": return "subagent-inherit";
    case "DEFAULT": return "profile-policy";
  }
}

/**
 * Deterministic winner + resolution-path derivation. The request selector is
 * classified (#125) and is authoritative; the winner records which source
 * produced it (persisted-view provenance is recorded when the selector equals
 * the owning view's persisted RLY projection model).
 */
export function precedenceWinnerFor(input: EffectiveModelDecisionInput): Readonly<{
  winner: PrecedenceSource;
  resolvedThrough: DecisionResolutionPath;
}> {
  const kind = input.intent.kind;
  switch (kind) {
    case "EXACT_PROJECTION":
      return input.persistedViewModel !== undefined && input.persistedViewModel === input.intent.sourceSelector
        ? { winner: "persisted-rly-view", resolvedThrough: "persisted-view-state" }
        : { winner: "exact-projection", resolvedThrough: "projection-reverse-map" };
    case "RLY_LOGICAL_TIER":
      return { winner: "explicit-rly-tier", resolvedThrough: "tier-resolver" };
    case "CLIENT_NATIVE_ALIAS":
      return { winner: "client-native-alias", resolvedThrough: "client-alias-contract" };
    case "EXACT_CLIENT_MODEL":
      return { winner: "exact-client-model", resolvedThrough: "profile-role-mapping" };
    case "INHERIT":
      return input.parent === undefined
        ? { winner: "profile-policy", resolvedThrough: "profile-default-fallback" }
        : { winner: "subagent-inherit", resolvedThrough: "parent-context" };
    case "DEFAULT":
      return { winner: "profile-policy", resolvedThrough: "profile-default-role" };
  }
}

/** Fixed conflict-kind ordering so identical inputs always produce the same array. */
const CONFLICT_ORDER = [
  "projection-vs-view-state",
  "persisted-view-model-vs-request",
  "launch-policy-vs-request",
  "subagent-request-vs-parent-context",
  "gateway-contract-env-present",
] as const;

/**
 * Detects visible, deterministic conflicts among the decision inputs. The
 * request's explicit selection always wins; losing sources are recorded with
 * allowlisted detail — no hidden string/env override silently wins.
 */
export function detectConflicts(input: EffectiveModelDecisionInput): readonly ModelDecisionConflict[] {
  const conflicts: ModelDecisionConflict[] = [];
  const selector = input.intent.sourceSelector;
  // Persisted view model vs request.
  if (input.persistedViewModel !== undefined) {
    if (input.intent.kind === "EXACT_PROJECTION") {
      if (input.persistedViewModel !== selector) {
        conflicts.push({
          kind: "projection-vs-view-state",
          detail: `requested projection ${selector} is not the owning view's persisted model ${input.persistedViewModel}; resolved through the pinned session universe only`,
        });
      }
    } else if (input.persistedViewModel !== selector) {
      conflicts.push({
        kind: "persisted-view-model-vs-request",
        detail: `owning view persists ${input.persistedViewModel} but the request selector was ${selector}; explicit request selection wins`,
      });
    }
  }
  // Launch policy (explicit RLY/profile settings tier) vs request.
  if (input.launchPolicyModel !== undefined && input.launchPolicyModel !== selector) {
    conflicts.push({
      kind: "launch-policy-vs-request",
      detail: `launch policy pins ${input.launchPolicyModel} but the request selector was ${selector}; explicit request selection wins`,
    });
  }
  // Subagent explicit selection vs frozen parent context (#71/#127): the
  // child's own intent wins and the parent is never mutated.
  if (input.parent !== undefined && input.intent.kind !== "INHERIT" && input.resolvedModelId !== input.parent.parentModelId) {
    conflicts.push({
      kind: "subagent-request-vs-parent-context",
      detail: `subagent explicitly selected ${input.resolvedModelId} while the frozen parent context holds ${input.parent.parentModelId}; the child intent wins and the parent is not mutated`,
    });
  }
  // Gateway-contract env keys present in the child environment (#126): RLY
  // owns these by contract; recorded as consumed state, never silent.
  if (input.environmentOwnership !== undefined && input.environmentOwnership.gatewayEnvKeys.length > 0) {
    conflicts.push({
      kind: "gateway-contract-env-present",
      detail: `child environment carries RLY-owned gateway-contract env keys (${input.environmentOwnership.gatewayEnvKeys.join(",")}); RLY-owned by contract, stripped from native settings`,
    });
  }
  return Object.freeze([...conflicts].sort(
    (a, b) => CONFLICT_ORDER.indexOf(a.kind) - CONFLICT_ORDER.indexOf(b.kind),
  ));
}

/** Secret-free env/settings ownership summary (#126) for the child environment. */
export function environmentOwnershipSummary(
  environment: Readonly<NodeJS.ProcessEnv>,
): SettingsOwnershipSummary {
  const gatewayEnvKeys: string[] = [];
  let safePassThrough = 0;
  for (const key of Object.keys(environment)) {
    if ((GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key)) {
      gatewayEnvKeys.push(key);
    } else if (
      key.startsWith("ANTHROPIC_") || key.startsWith("OPENAI_")
      || key.startsWith("CODEX_") || key.startsWith("RLY_")
    ) {
      safePassThrough += 1;
    }
  }
  return {
    rlyOwned: gatewayEnvKeys.length,
    conflicting: [],
    safePassThrough,
    unsupported: [],
    userOverride: 0,
    gatewayEnvKeys: Object.freeze(gatewayEnvKeys),
  };
}

/**
 * Bounded, best-effort read of the OWNING profile view's RLY-owned persisted
 * `claude-rly-*` projection model (#126). Only the RLY-owned projection id
 * (routing metadata) is extracted — never settings content. Returns undefined
 * when the view/settings are absent or unreadable (fail-open; the decision is
 * still produced without persisted-state provenance).
 */
export async function readPersistedViewModel(
  controlPlaneDirectory: string | undefined,
  viewId: string,
): Promise<string | undefined> {
  if (controlPlaneDirectory === undefined) return undefined;
  try {
    const settingsPath = claudeOverlayPaths(controlPlaneDirectory, viewId).settings;
    const raw = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return rlyOwnedModel(parsed);
  } catch {
    return undefined;
  }
}

/** #68 trace → blocked alternatives (non-selected candidates with typed failures). */
export function blockedAlternativesFor(selection: ModelSelectionTrace): readonly ModelDecisionBlockedAlternative[] {
  const blocked: ModelDecisionBlockedAlternative[] = [];
  for (const candidate of selection.candidates) {
    if (candidate.selected) continue;
    const blockedBy: string[] = [];
    if (candidate.missingCapabilities !== undefined && candidate.missingCapabilities.length > 0) blockedBy.push("capability-unsupported");
    if (candidate.reasoningFailure !== undefined) blockedBy.push("reasoning-unsupported");
    if (candidate.compatibilityFailure !== undefined) blockedBy.push("compatibility-rejected");
    if (blockedBy.length === 0) continue;
    blocked.push(Object.freeze({
      logicalId: candidate.logicalId,
      physicalModelId: candidate.modelId,
      ...(candidate.modelFamily === undefined ? {} : { modelFamily: candidate.modelFamily }),
      compatibilityState: candidate.compatibilityState,
      blockedBy: Object.freeze(blockedBy),
      ...(candidate.effectiveLabel === undefined ? {} : { effectiveLabel: candidate.effectiveLabel }),
      ...(candidate.enforcementReason === undefined ? {} : { enforcementReason: candidate.enforcementReason }),
    }));
  }
  return Object.freeze(blocked);
}

/** Stable, documented decision reasons (actionable, secret-free). */
export function reasonsFor(input: EffectiveModelDecisionInput): readonly ModelDecisionReason[] {
  const reasons: ModelDecisionReason[] = [];
  reasons.push({
    code: "intent-resolved",
    detail: `selector classified as ${input.intent.kind} from ${input.intent.source}`,
  });
  reasons.push({
    code: "frozen-model-target",
    detail: `physical target frozen (${input.accessProviderId}/${input.resolvedModelId}) before account selection`,
  });
  if (input.tier !== undefined) {
    reasons.push({
      code: "tier-resolved",
      detail: `logical tier ${input.tier.requestedTier} resolved via ${input.tier.mappingSource} mapping`,
    });
  }
  if (input.projection !== undefined) {
    reasons.push({
      code: "projection-reverse-mapped",
      detail: `projection ${input.projection.projectionId} reverse-mapped to one exact access-provider/model target`,
    });
  }
  if (input.parent !== undefined && input.intent.kind === "INHERIT") {
    reasons.push({
      code: "parent-context-inherited",
      detail: `inherited frozen parent model ${input.parent.parentModelId} (${input.parent.contextSource})`,
    });
  }
  reasons.push({
    code: "reasoning-mapped",
    detail: `reasoning intent ${input.reasoning.canonicalIntent} mapped ${input.reasoning.mappingKind} to native control`,
  });
  const authority = input.selection.candidates.find((candidate) => candidate.selected)?.authority ?? "seed";
  const selected = input.selection.candidates.find((candidate) => candidate.selected);
  reasons.push(authority === "ecr"
    ? {
        code: "ecr-authority",
        detail: `Effective Compatibility Registry authority: ${selected?.effectiveLabel ?? "unknown"}${selected?.enforcementReason === undefined ? "" : ` (${selected.enforcementReason})`}`,
      }
    : { code: "seed-authority", detail: "no ECR snapshot; legacy static compatibility state is seed/reference only" });
  reasons.push({
    code: "pool-pinned",
    detail: `provider→pool binding ${input.poolId} pinned; account selection happens downstream in the pool`,
  });
  if (input.persistedViewModel !== undefined) {
    reasons.push({
      code: "persisted-view-state",
      detail: `RLY view ${input.viewId} persists projection ${input.persistedViewModel}`,
    });
  }
  if (input.environmentOwnership !== undefined && input.environmentOwnership.rlyOwned > 0) {
    reasons.push({
      code: "env-ownership",
      detail: `child environment: ${String(input.environmentOwnership.rlyOwned)} RLY-owned gateway keys, ${String(input.environmentOwnership.safePassThrough)} pass-through`,
    });
  }
  return Object.freeze(reasons);
}

/**
 * Pure, deterministic assembly of the EffectiveModelDecision. Every input is a
 * stage output from the existing components; this function only records,
 * derives precedence/conflict bookkeeping, and freezes the object. No account
 * or credential input exists here by construction.
 */
export function assembleEffectiveModelDecision(input: EffectiveModelDecisionInput): EffectiveModelDecision {
  const { winner, resolvedThrough } = precedenceWinnerFor(input);
  const conflicts = detectConflicts(input);
  const selected = input.selection.candidates.find((candidate) => candidate.selected);
  const compatibility = Object.freeze({
    authority: selected?.authority ?? "seed",
    selectedLogicalId: input.selection.selectedLogicalId,
    ...(selected?.effectiveLabel === undefined
      ? {}
      : { effectiveLabel: selected.effectiveLabel as EffectiveCompatibilityLabel }),
    ...(selected?.enforcementReason === undefined ? {} : { enforcementReason: selected.enforcementReason }),
    ...(selected === undefined ? {} : { seedState: selected.compatibilityState }),
    ...(input.effectiveFeatures === undefined || Object.keys(input.effectiveFeatures).length === 0
      ? {}
      : { features: Object.freeze(Object.fromEntries(
          Object.entries(input.effectiveFeatures).map(([feature, value]) => [feature, Object.freeze(value)]),
        )) }),
  });
  const decision: EffectiveModelDecision = Object.freeze({
    schemaVersion: MODEL_DECISION_SCHEMA_VERSION,
    requestId: input.requestId,
    profileId: input.profileId,
    profileName: input.profileName,
    viewId: input.viewId,
    intent: Object.freeze({ ...input.intent }),
    precedence: Object.freeze({
      order: Object.freeze([...PRECEDENCE_ORDER]),
      winner,
      resolvedThrough,
      conflicts,
    }),
    target: Object.freeze({
      accessProviderId: input.accessProviderId,
      physicalModelId: input.resolvedModelId,
      logicalId: input.logicalId,
      ...(input.modelFamily === undefined ? {} : { modelFamily: input.modelFamily }),
      adapterId: input.adapterId,
    }),
    provenance: Object.freeze({
      ...(input.projection === undefined ? {} : { projection: input.projection }),
      ...(input.tier === undefined ? {} : { tier: input.tier }),
      ...(input.clientAlias === undefined
        ? {}
        : { clientAlias: Object.freeze({ alias: input.clientAlias.alias, mappedTier: input.clientAlias.mappedTier }) }),
      ...(input.intent.kind === "EXACT_CLIENT_MODEL" ? { exactClientModel: true } : {}),
      ...(input.parent === undefined
        ? {}
        : { inherit: Object.freeze({
            parentModelId: input.parent.parentModelId,
            ...(input.parent.parentModelFamily === undefined ? {} : { parentModelFamily: input.parent.parentModelFamily }),
            contextSource: input.parent.contextSource,
          }) }),
      ...(input.profileRole === undefined ? {} : { profileRole: input.profileRole }),
      ...(input.launchPolicyModel === undefined ? {} : { launchPolicyModel: input.launchPolicyModel }),
      ...(input.persistedViewModel === undefined ? {} : { persistedViewModel: input.persistedViewModel }),
      ...(input.environmentOwnership === undefined ? {} : { environmentOwnership: input.environmentOwnership }),
      defaulted: input.intent.kind === "DEFAULT" || (input.intent.kind === "INHERIT" && input.parent === undefined),
    }),
    reasoning: Object.freeze({ ...input.reasoning }),
    compatibility,
    poolBinding: Object.freeze({
      poolId: input.poolId,
      providerId: input.accessProviderId,
      policyRevision: input.policyRevision,
      policyHash: input.policyHash,
      experimentalModels: input.experimentalModels,
    }),
    revisions: Object.freeze({
      policyRevision: input.policyRevision,
      policyHash: input.policyHash,
      ...(input.registryRevision === undefined ? {} : { registryRevision: input.registryRevision }),
      ...(input.mappingRevision === undefined ? {} : { mappingRevision: input.mappingRevision }),
      sessionUniverseRevision: input.sessionUniverseRevision,
    }),
    reasons: reasonsFor(input),
    blockedAlternatives: blockedAlternativesFor(input.selection),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  });
  return decision;
}
