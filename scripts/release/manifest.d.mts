// Type declarations for scripts/release/manifest.mjs (canonical release manifest, #128).

export type ReleaseManifestArtifact = {
  target: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  artifactDigest: string;
  targetStatus: "supported" | "experimental";
  targetStatusReason?: string;
  bundledNodeVersion: string;
  bundledNodeVersionSource?: string;
  requiredSignatures: string[];
  attestations: string[];
};

export type ReleaseManifest = {
  manifestSchemaVersion: 1;
  product: "rly-gateway";
  releaseVersion: string;
  releaseChannel: "beta" | "stable";
  sourceCommit: string;
  buildId: string;
  stateSchemaVersion: number;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  publishedAt: string;
  requiredSignatures: string[];
  requiredAttestations: string[];
  workflow?: Record<string, unknown>;
  artifacts: ReleaseManifestArtifact[];
};

export const RELEASE_MANIFEST_SCHEMA_VERSION: 1;
export const RELEASE_MANIFEST_FILENAME: "rly-release.json";
export const REQUIRED_SIGNATURES: readonly string[];
export const REQUIRED_ATTESTATIONS: readonly string[];

export function buildReleaseManifest(args: {
  releaseVersion: string;
  releaseChannel: string;
  sourceCommit: string;
  buildId: string;
  stateSchemaVersion: number;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  publishedAt: string;
  workflow?: Record<string, unknown>;
  artifacts: ReleaseManifestArtifact[];
  requiredSignatures?: string[];
  requiredAttestations?: string[];
}): ReleaseManifest;
export function validateReleaseManifest(manifest: unknown): string[];
export function releaseManifestArtifactDigests(manifest: ReleaseManifest): Record<string, string>;
export function releaseManifestSha256s(manifest: ReleaseManifest): Record<string, string>;
export function releaseManifestMatchesIdentity(manifest: ReleaseManifest, buildMeta: Record<string, unknown>): string[];
export function serializeReleaseManifest(manifest: ReleaseManifest): string;
