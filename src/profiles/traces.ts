import { assertSecretFree } from "../control-plane/secret-free.js";
import type { ResolvedReasoning } from "../core/reasoning.js";
import type { ModelSelectionTrace } from "../routing/model-selection/types.js";
import type { ModelProjectionTrace } from "../routing/model-projection/types.js";
import type { ModelIntentTrace } from "../routing/model-intent/types.js";
import type { TierResolutionTrace } from "../routing/model-tiers/types.js";
import type { DecisionTrace } from "../routing/eligibility/trace.js";

/**
 * Allowlisted Claude Code agent linkage for one decision (#71). Pseudonyms
 * (hashes) only, plus the parent model/family that scoped tier resolution —
 * never prompts, credentials, or durable user identity.
 */
export type AgentTraceLinkage = Readonly<{
  claudeSessionPseudonym: string;
  agentPseudonym: string;
  parentAgentPseudonym?: string;
  /** How the parent/current execution context was derived for tier resolution. */
  contextSource: "parent-agent" | "session-default" | "profile-default";
  parentModelId?: string;
  parentModelFamily?: string;
}>;

/**
 * Secret-free account decision trace, optionally carrying the #68 model
 * selection trace, the #69 tier resolution trace, the #70 reasoning
 * translation result, the #71 agent linkage, the #72 projection decision, and
 * the #125 model-intent classification (control metadata only — never
 * reasoning text, prompts, responses, credentials, or account identity).
 */
export type ProfileDecisionTrace = DecisionTrace & Readonly<{
  profileName: string;
  modelSelection?: ModelSelectionTrace;
  tierResolution?: TierResolutionTrace;
  reasoning?: ResolvedReasoning;
  agentLinkage?: AgentTraceLinkage;
  projection?: ModelProjectionTrace;
  intent?: ModelIntentTrace;
}>;

/** Last-N secret-free traces for the running gateway instance. */
export class RouteTraceRing {
  private readonly items: ProfileDecisionTrace[] = [];

  public constructor(private readonly limit = 32) {}

  public push(
    trace: DecisionTrace,
    profileName: string,
    modelSelection?: ModelSelectionTrace,
    reasoning?: ResolvedReasoning,
    tierResolution?: TierResolutionTrace,
    agentLinkage?: AgentTraceLinkage,
    projection?: ModelProjectionTrace,
    intent?: ModelIntentTrace,
  ): void {
    const stored: ProfileDecisionTrace = Object.freeze({
      ...trace,
      profileName,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(tierResolution === undefined ? {} : { tierResolution }),
      ...(agentLinkage === undefined ? {} : { agentLinkage }),
      ...(projection === undefined ? {} : { projection }),
      ...(intent === undefined ? {} : { intent }),
    });
    assertSecretFree(stored);
    this.items.push(stored);
    if (this.items.length > this.limit) this.items.shift();
  }

  public list(profileName?: string): readonly ProfileDecisionTrace[] {
    return profileName === undefined ? this.items : this.items.filter((item) => item.profileName === profileName);
  }
}
