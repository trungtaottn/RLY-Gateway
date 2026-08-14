import { assertSecretFree } from "../control-plane/secret-free.js";
import type { ResolvedReasoning } from "../core/reasoning.js";
import type { ModelSelectionTrace } from "../routing/model-selection/types.js";
import type { TierResolutionTrace } from "../routing/model-tiers/types.js";
import type { DecisionTrace } from "../routing/eligibility/trace.js";

/**
 * Secret-free account decision trace, optionally carrying the #68 model
 * selection trace, the #69 tier resolution trace, and the #70 reasoning
 * translation result (control metadata only — never reasoning text, prompts,
 * responses, or credentials).
 */
export type ProfileDecisionTrace = DecisionTrace & Readonly<{
  profileName: string;
  modelSelection?: ModelSelectionTrace;
  tierResolution?: TierResolutionTrace;
  reasoning?: ResolvedReasoning;
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
  ): void {
    const stored: ProfileDecisionTrace = Object.freeze({
      ...trace,
      profileName,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(tierResolution === undefined ? {} : { tierResolution }),
    });
    assertSecretFree(stored);
    this.items.push(stored);
    if (this.items.length > this.limit) this.items.shift();
  }

  public list(profileName?: string): readonly ProfileDecisionTrace[] {
    return profileName === undefined ? this.items : this.items.filter((item) => item.profileName === profileName);
  }
}
