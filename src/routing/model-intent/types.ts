/**
 * Typed model intent and selector namespaces (#125).
 *
 * A `ModelIntent` is the deterministic answer to "what kind of model selection
 * did the client/user/policy intend?" — classified from the incoming selector
 * string BEFORE any routing begins. It separates the client-native alias
 * vocabulary (owned by Claude/Codex) from the RLY logical selector namespace,
 * so a bare `fable` alias and the explicit `rly-tier:fable` selector are
 * different intent kinds even though they may ultimately resolve to the same
 * logical tier.
 *
 * Core invariant: `fable != rly-tier:fable`.
 */

import type { LogicalTier } from "../model-tiers/types.js";

/** Explicit RLY logical-tier namespace. Only `rly-tier:<tier>` is RLY policy. */
export const RLY_TIER_NAMESPACE = "rly-tier:" as const;

/**
 * Client-native alias vocabulary owned by Claude Code (and Codex). These bare
 * strings are NEVER RLY policy selectors by string equality; they are
 * classified as `CLIENT_NATIVE_ALIAS` and mapped to an RLY tier only through
 * the explicit, traceable client-alias contract (see `classify.ts`).
 */
export const CLIENT_NATIVE_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const;
export type ClientNativeAlias = (typeof CLIENT_NATIVE_ALIASES)[number];

export const MODEL_INTENT_KINDS = [
  "EXACT_PROJECTION",
  "RLY_LOGICAL_TIER",
  "CLIENT_NATIVE_ALIAS",
  "EXACT_CLIENT_MODEL",
  "INHERIT",
  "DEFAULT",
] as const;
export type ModelIntentKind = (typeof MODEL_INTENT_KINDS)[number];

/** The namespace/rule that produced a classification (provenance for diagnostics). */
export type ModelIntentSource =
  | "rly-tier-namespace"
  | "projection-namespace"
  | "client-native-alias-contract"
  | "exact-model"
  | "inherit"
  | "default";

export type ModelIntentProvenance = Readonly<{
  /** Exact selector string as received, never rewritten. */
  sourceSelector: string;
  /** Namespace/rule that produced the classification. */
  source: ModelIntentSource;
}>;

/**
 * Discriminated model-intent union. Every variant carries provenance metadata
 * (`sourceSelector` + `source`) so diagnostics can show selector kind/source
 * and the resolved logical target without user content, credentials, or
 * account identity.
 */
export type ModelIntent =
  | Readonly<ModelIntentProvenance & { kind: "EXACT_PROJECTION"; projectionId: string }>
  | Readonly<ModelIntentProvenance & { kind: "RLY_LOGICAL_TIER"; tier: LogicalTier }>
  | Readonly<ModelIntentProvenance & {
      kind: "CLIENT_NATIVE_ALIAS";
      alias: ClientNativeAlias;
      /** Deliberate, traceable mapping to the equivalent RLY logical tier. */
      mappedTier: LogicalTier;
    }>
  | Readonly<ModelIntentProvenance & { kind: "EXACT_CLIENT_MODEL"; modelId: string }>
  | Readonly<ModelIntentProvenance & { kind: "INHERIT" }>
  | Readonly<ModelIntentProvenance & { kind: "DEFAULT" }>;

/**
 * Secret-free allowlisted intent metadata for the route trace. Shows selector
 * kind/source and the resolved logical target only — never prompts,
 * credentials, account identity, or settings contents.
 */
export type ModelIntentTrace = Readonly<{
  kind: ModelIntentKind;
  sourceSelector: string;
  source: ModelIntentSource;
  /** Resolved logical tier when the intent is tier-scoped. */
  tier?: LogicalTier;
  /** Client-native alias when the intent is `CLIENT_NATIVE_ALIAS`. */
  alias?: ClientNativeAlias;
  /** Resolved model id when the intent resolved through a model/role. */
  modelId?: string;
  /** Resolved profile role when the intent resolved through a role. */
  role?: string;
}>;
