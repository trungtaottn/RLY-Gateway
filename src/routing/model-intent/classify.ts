/**
 * Deterministic model-intent classifier (#125).
 *
 * Pure string classification: maps an incoming selector string onto a typed
 * `ModelIntent` kind with provenance metadata. No registry/policy/profile
 * access and no account/credential access. Classification is the boundary the
 * rest of the routing pipeline consumes, so the #69 tier resolver is only ever
 * invoked for an explicitly typed tier intent — never through accidental bare
 * string equality with a tier name.
 *
 * Precedence is fixed and documented (highest → lowest):
 * 1. `rly-tier:<tier>` — explicit RLY logical-tier namespace.
 * 2. `claude-rly-*` — explicit RLY projection namespace.
 * 3. bare `haiku|sonnet|opus|fable` — client-native alias (Claude/Codex-owned).
 * 4. `inherit` — inherit the parent/current execution target.
 * 5. empty / `default` — profile default.
 * 6. anything else — exact client model id / profile role / helper alias.
 */

import { isProjectionId } from "../model-projection/types.js";
import { isLogicalTier } from "../model-tiers/types.js";
import { ModelIntentError } from "./errors.js";
import {
  CLIENT_NATIVE_ALIASES,
  RLY_TIER_NAMESPACE,
  type ClientNativeAlias,
  type ModelIntent,
} from "./types.js";

/** Strips the `rly-tier:` namespace prefix and returns the raw tier value. */
export function parseRlyTierSelector(selector: string): string | undefined {
  if (!selector.startsWith(RLY_TIER_NAMESPACE)) return undefined;
  return selector.slice(RLY_TIER_NAMESPACE.length);
}

/**
 * Classifies an incoming selector string into a typed `ModelIntent`. Throws a
 * typed `ModelIntentError` only when a selector claims an RLY namespace but
 * names an unknown value (`unknown-namespace`) — an explicit RLY policy
 * selector must never be silently reinterpreted as a client alias/model.
 */
export function classifyModelIntent(selector: string): ModelIntent {
  if (selector.startsWith(RLY_TIER_NAMESPACE)) {
    const tier = parseRlyTierSelector(selector);
    if (tier === undefined || !isLogicalTier(tier)) {
      throw new ModelIntentError("unknown-namespace", `Unknown RLY logical tier namespace selector: ${selector}`);
    }
    return Object.freeze({
      kind: "RLY_LOGICAL_TIER",
      tier,
      sourceSelector: selector,
      source: "rly-tier-namespace",
    });
  }
  if (isProjectionId(selector)) {
    return Object.freeze({
      kind: "EXACT_PROJECTION",
      projectionId: selector,
      sourceSelector: selector,
      source: "projection-namespace",
    });
  }
  if ((CLIENT_NATIVE_ALIASES as readonly string[]).includes(selector)) {
    return Object.freeze({
      kind: "CLIENT_NATIVE_ALIAS",
      alias: selector as ClientNativeAlias,
      mappedTier: selector as ClientNativeAlias,
      sourceSelector: selector,
      source: "client-native-alias-contract",
    });
  }
  if (selector === "" || selector === "default") {
    return Object.freeze({ kind: "DEFAULT", sourceSelector: selector, source: "default" });
  }
  if (selector === "inherit") {
    return Object.freeze({ kind: "INHERIT", sourceSelector: selector, source: "inherit" });
  }
  return Object.freeze({
    kind: "EXACT_CLIENT_MODEL",
    modelId: selector,
    sourceSelector: selector,
    source: "exact-model",
  });
}
