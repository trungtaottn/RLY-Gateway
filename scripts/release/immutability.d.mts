// Type declarations for scripts/release/immutability.mjs (#128).
import type { ChannelMetadata } from "./channel.d.mts";
import type { ReleaseManifest } from "./manifest.d.mts";

export function assertReleaseImmutable(args: {
  existingMetadata: ChannelMetadata | undefined;
  newManifest: ReleaseManifest;
}): { ok: boolean; errors: string[] };

export function detectAssetReplacement(args: {
  metadata: ChannelMetadata | undefined;
  assets: Array<{ releaseVersion: string; target: string; filename: string; sha256: string; artifactDigest: string }>;
}): Array<{
  releaseVersion: string;
  target: string;
  filename: string;
  expectedSha256: string;
  actualSha256: string;
  expectedArtifactDigest: string;
  actualArtifactDigest: string;
}>;
