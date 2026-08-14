export const QUOTA_CLASS_ORDER = ["healthy", "warning", "unknown", "exhausted"] as const;
export type QuotaClass = (typeof QUOTA_CLASS_ORDER)[number];

export const INELIGIBLE_QUOTA_CLASSES = new Set<string>(["exhausted"]);

export function quotaRank(quotaClass: string): number {
  const index = (QUOTA_CLASS_ORDER as readonly string[]).indexOf(quotaClass);
  return index === -1 ? (QUOTA_CLASS_ORDER as readonly string[]).indexOf("unknown") : index;
}

export function isQuotaExhausted(quotaClass: string): boolean {
  return INELIGIBLE_QUOTA_CLASSES.has(quotaClass);
}
