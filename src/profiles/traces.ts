import { assertSecretFree } from "../control-plane/secret-free.js";
import type { ModelSelectionTrace } from "../routing/model-selection/types.js";
import type { DecisionTrace } from "../routing/eligibility/trace.js";

/**
 * Secret-free account decision trace, optionally carrying the #68 model
 * selection trace that preceded account selection (two-stage boundary:
 * model target selection first, account selection second).
 */
export type ProfileDecisionTrace = DecisionTrace & Readonly<{
  profileName: string;
  modelSelection?: ModelSelectionTrace;
}>;

/** Last-N secret-free traces for the running gateway instance. */
export class RouteTraceRing {
  private readonly items: ProfileDecisionTrace[] = [];

  public constructor(private readonly limit = 32) {}

  public push(trace: DecisionTrace, profileName: string, modelSelection?: ModelSelectionTrace): void {
    const stored: ProfileDecisionTrace = Object.freeze({
      ...trace,
      profileName,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    assertSecretFree(stored);
    this.items.push(stored);
    if (this.items.length > this.limit) this.items.shift();
  }

  public list(profileName?: string): readonly ProfileDecisionTrace[] {
    return profileName === undefined ? this.items : this.items.filter((item) => item.profileName === profileName);
  }
}
