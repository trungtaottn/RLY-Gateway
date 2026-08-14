import { assertSecretFree } from "../control-plane/secret-free.js";
import type { DecisionTrace } from "../routing/eligibility/trace.js";

export type ProfileDecisionTrace = DecisionTrace & Readonly<{ profileName: string }>;

/** Last-N secret-free traces for the running gateway instance. */
export class RouteTraceRing {
  private readonly items: ProfileDecisionTrace[] = [];

  public constructor(private readonly limit = 32) {}

  public push(trace: DecisionTrace, profileName: string): void {
    const stored: ProfileDecisionTrace = Object.freeze({ ...trace, profileName });
    assertSecretFree(stored);
    this.items.push(stored);
    if (this.items.length > this.limit) this.items.shift();
  }

  public list(profileName?: string): readonly ProfileDecisionTrace[] {
    return profileName === undefined ? this.items : this.items.filter((item) => item.profileName === profileName);
  }
}
