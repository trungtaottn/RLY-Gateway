export const ELIGIBILITY_REASONS = [
  "provider-disabled",
  "paused",
  "revoked",
  "auth-unready",
  "expired",
  "quota-exhausted",
  "cooling",
  "capability-incompatible",
  "terms-unaccepted",
  "generation-unbound",
] as const;

export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export type CredentialSnapshot = Readonly<{
  present: boolean;
  generation: number;
  expiresAt?: string;
}>;

export type CandidateAssessment = Readonly<{
  accountId: string;
  accountPseudonym: string;
  credentialHandle: string;
  credentialGeneration: number;
  pinOrder: number;
  quotaClass: string;
  eligible: boolean;
  reasons: readonly EligibilityReason[];
}>;
