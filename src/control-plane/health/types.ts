export type HealthRecord = Readonly<{
  accountId: string;
  lastOutcome: string | undefined;
  lastOutcomeAt: string | undefined;
  consecutiveFailures: number;
  cooldownUntil: string | undefined;
}>;

export type RouteOutcomeClass = "success" | "auth" | "quota" | "transient" | "fatal";

export type RouteOutcomeInput = Readonly<{
  outcome: RouteOutcomeClass;
  quotaClass?: string | undefined;
  cooldownUntil?: string | null;
}>;
