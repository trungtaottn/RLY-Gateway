export const QUOTA_CLASS_ORDER = ["healthy", "warning", "unknown", "exhausted"] as const;
export type QuotaClass = (typeof QUOTA_CLASS_ORDER)[number];

export function quotaRank(quotaClass: string): number {
  const index = (QUOTA_CLASS_ORDER as readonly string[]).indexOf(quotaClass);
  return index === -1 ? (QUOTA_CLASS_ORDER as readonly string[]).indexOf("unknown") : index;
}
