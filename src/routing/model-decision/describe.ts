/**
 * EffectiveModelDecision diagnostics surface (#127).
 *
 * Secret-free projection of one decision for `rly route-trace` / `rly doctor`
 * / model query: requested selector, intent type, precedence sources, winner,
 * profile/view, compatibility result, selected provider/model/family/tier/
 * projection, reasoning mapping, pool binding, revisions, blocked
 * alternatives, and rejection/fallback reasons. Allowlisted metadata only —
 * never prompts, responses, reasoning text, credentials, auth headers, raw
 * account identity, or full user settings content.
 */

import type { EffectiveModelDecision } from "./types.js";

/**
 * Compact, secret-free describe object for diagnostics. Keeps the fields a
 * human needs to explain WHY a model was selected and what was blocked —
 * without any user content or credentials.
 */
export type ModelDecisionDescription = Readonly<{
  schemaVersion: number;
  requestId: string;
  profileName: string;
  viewId: string;
  intent: Readonly<{ kind: string; sourceSelector: string; source: string; tier?: string; alias?: string; modelId?: string; role?: string }>;
  precedence: Readonly<{ winner: string; resolvedThrough: string; conflicts: readonly Readonly<{ kind: string; detail: string }>[] }>;
  target: Readonly<{ accessProviderId: string; physicalModelId: string; logicalId: string; modelFamily?: string; adapterId: string }>;
  provenance: Readonly<{
    projectionId?: string;
    tier?: string;
    alias?: string;
    parentModelId?: string;
    contextSource?: string;
    profileRole?: string;
    launchPolicyModel?: string;
    persistedViewModel?: string;
    defaulted: boolean;
  }>;
  reasoning: Readonly<{ canonicalIntent: string; mappingKind: string; effective: string; fallbackReason?: string }>;
  compatibility: Readonly<{ authority: string; effectiveLabel?: string; enforcementReason?: string; seedState?: string }>;
  poolBinding: Readonly<{ poolId: string; providerId: string; policyRevision: number; experimentalModels: boolean }>;
  revisions: Readonly<{ policyRevision: number; registryRevision?: number; mappingRevision?: number; sessionUniverseRevision: number }>;
  reasons: readonly Readonly<{ code: string; detail: string }>[];
  blockedAlternatives: readonly Readonly<{
    logicalId: string;
    physicalModelId: string;
    modelFamily?: string;
    blockedBy: readonly string[];
    effectiveLabel?: string;
    enforcementReason?: string;
  }>[];
  decidedAt: string;
}>;

/** Deterministic, secret-free describe of one decision (for diagnostics). */
export function describeModelDecision(decision: EffectiveModelDecision): ModelDecisionDescription {
  return Object.freeze({
    schemaVersion: decision.schemaVersion,
    requestId: decision.requestId,
    profileName: decision.profileName,
    viewId: decision.viewId,
    intent: Object.freeze({
      kind: decision.intent.kind,
      sourceSelector: decision.intent.sourceSelector,
      source: decision.intent.source,
      ...(decision.intent.tier === undefined ? {} : { tier: decision.intent.tier }),
      ...(decision.intent.alias === undefined ? {} : { alias: decision.intent.alias }),
      ...(decision.intent.modelId === undefined ? {} : { modelId: decision.intent.modelId }),
      ...(decision.intent.role === undefined ? {} : { role: decision.intent.role }),
    }),
    precedence: Object.freeze({
      winner: decision.precedence.winner,
      resolvedThrough: decision.precedence.resolvedThrough,
      conflicts: Object.freeze(decision.precedence.conflicts.map((conflict) => Object.freeze({ kind: conflict.kind, detail: conflict.detail }))),
    }),
    target: Object.freeze({
      accessProviderId: decision.target.accessProviderId,
      physicalModelId: decision.target.physicalModelId,
      logicalId: decision.target.logicalId,
      ...(decision.target.modelFamily === undefined ? {} : { modelFamily: decision.target.modelFamily }),
      adapterId: decision.target.adapterId,
    }),
    provenance: Object.freeze({
      ...(decision.provenance.projection === undefined ? {} : { projectionId: decision.provenance.projection.projectionId }),
      ...(decision.provenance.tier === undefined ? {} : { tier: decision.provenance.tier.requestedTier }),
      ...(decision.provenance.clientAlias === undefined ? {} : { alias: decision.provenance.clientAlias.alias }),
      ...(decision.provenance.inherit === undefined ? {} : { parentModelId: decision.provenance.inherit.parentModelId }),
      ...(decision.provenance.inherit === undefined ? {} : { contextSource: decision.provenance.inherit.contextSource }),
      ...(decision.provenance.profileRole === undefined ? {} : { profileRole: decision.provenance.profileRole }),
      ...(decision.provenance.launchPolicyModel === undefined ? {} : { launchPolicyModel: decision.provenance.launchPolicyModel }),
      ...(decision.provenance.persistedViewModel === undefined ? {} : { persistedViewModel: decision.provenance.persistedViewModel }),
      defaulted: decision.provenance.defaulted,
    }),
    reasoning: Object.freeze({
      canonicalIntent: decision.reasoning.canonicalIntent,
      mappingKind: decision.reasoning.mappingKind,
      effective: JSON.stringify(decision.reasoning.effective),
      ...(decision.reasoning.fallbackReason === undefined ? {} : { fallbackReason: decision.reasoning.fallbackReason }),
    }),
    compatibility: Object.freeze({
      authority: decision.compatibility.authority,
      ...(decision.compatibility.effectiveLabel === undefined ? {} : { effectiveLabel: decision.compatibility.effectiveLabel }),
      ...(decision.compatibility.enforcementReason === undefined ? {} : { enforcementReason: decision.compatibility.enforcementReason }),
      ...(decision.compatibility.seedState === undefined ? {} : { seedState: decision.compatibility.seedState }),
    }),
    poolBinding: Object.freeze({
      poolId: decision.poolBinding.poolId,
      providerId: decision.poolBinding.providerId,
      policyRevision: decision.poolBinding.policyRevision,
      experimentalModels: decision.poolBinding.experimentalModels,
    }),
    revisions: Object.freeze({
      policyRevision: decision.revisions.policyRevision,
      ...(decision.revisions.registryRevision === undefined ? {} : { registryRevision: decision.revisions.registryRevision }),
      ...(decision.revisions.mappingRevision === undefined ? {} : { mappingRevision: decision.revisions.mappingRevision }),
      sessionUniverseRevision: decision.revisions.sessionUniverseRevision,
    }),
    reasons: Object.freeze(decision.reasons.map((reason) => Object.freeze({ code: reason.code, detail: reason.detail }))),
    blockedAlternatives: Object.freeze(decision.blockedAlternatives.map((blocked) => Object.freeze({
      logicalId: blocked.logicalId,
      physicalModelId: blocked.physicalModelId,
      ...(blocked.modelFamily === undefined ? {} : { modelFamily: blocked.modelFamily }),
      blockedBy: Object.freeze([...blocked.blockedBy]),
      ...(blocked.effectiveLabel === undefined ? {} : { effectiveLabel: blocked.effectiveLabel }),
      ...(blocked.enforcementReason === undefined ? {} : { enforcementReason: blocked.enforcementReason }),
    }))),
    decidedAt: decision.decidedAt,
  });
}
