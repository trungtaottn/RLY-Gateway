// Type declarations for scripts/release/channel.mjs (signed channel metadata, #128).

export type ChannelArtifact = {
  filename: string;
  sha256: string;
  artifactDigest: string;
  targetStatus: "supported" | "experimental";
};

export type ChannelSnapshot = {
  releaseVersion: string;
  sourceCommit: string;
  buildId: string;
  publishedAt: string;
  manifestRef: string;
  artifacts: Record<string, ChannelArtifact>;
  qualification: { status: "qualified" | "experimental-gaps" | "not-qualified"; ref?: string };
  state: "current";
};

export type ChannelMetadata = {
  channelSchemaVersion: 1;
  channel: "beta" | "stable";
  version: number;
  updatedAt: string;
  staleness: { maxAgeDays: number };
  freeze: { frozen: boolean; frozenAt?: string; reason?: string };
  snapshots: ChannelSnapshot[];
};

export const CHANNEL_METADATA_SCHEMA_VERSION: 1;
export const CHANNEL_MAX_AGE_DAYS: 30;
export const CHANNELS: readonly ["beta", "stable"];
export function CHANNEL_METADATA_FILENAME(channel: string): string;

export function channelVersionFor(releaseVersion: string, channel: string): number | null;
export function buildChannelMetadata(args: {
  channel: string;
  releaseVersion: string;
  sourceCommit: string;
  buildId: string;
  publishedAt: string;
  artifactDigests: Record<string, ChannelArtifact>;
  qualification: { status: string; ref?: string };
  previousHighestVersion?: number;
  freeze?: { frozen: boolean; frozenAt?: string; reason?: string };
  stalenessMaxAgeDays?: number;
  updatedAt?: string;
}): ChannelMetadata;
export function validateChannelMetadata(metadata: unknown): string[];
export function evaluateChannelMetadata(
  metadata: ChannelMetadata,
  args?: { highestObservedVersion?: number; now?: string; maxAgeDaysOverride?: number },
): { ok: boolean; errors: string[]; rollbackDetected: boolean; stale: boolean; frozen: boolean; ageDays: number | null };
export function qualificationStatusForChannel(qualificationByTarget: Record<string, { result?: string; status?: string }>, channel: string): string;
