import { z } from "zod";

/**
 * Verified acquisition contracts (#129). Channel policy, signed channel
 * metadata / release manifest shapes (mirrors of `scripts/release/channel.mjs`
 * and `scripts/release/manifest.mjs`), the verified candidate handed to
 * Wave 4 (INSTALL != ACTIVATE), and the typed acquisition failure taxonomy.
 *
 * No credentials, tokens, prompts, responses, or user content ever enter
 * these records — only channel/version/build/digest/platform/path/status
 * metadata.
 */

export const RELEASE_CHANNELS = ["beta", "stable"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const CHANNEL_POLICIES = ["beta", "stable", "current"] as const;
export type ChannelPolicy = (typeof CHANNEL_POLICIES)[number];

export const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type SupportedTarget = (typeof SUPPORTED_TARGETS)[number];

/** Signed channel metadata (`rly-channel-<channel>.json`), #128. */
export const channelMetadataSchema = z.object({
  channelSchemaVersion: z.literal(1),
  channel: z.enum(RELEASE_CHANNELS),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  staleness: z.object({ maxAgeDays: z.number().positive() }),
  freeze: z.object({
    frozen: z.boolean(),
    frozenAt: z.iso.datetime().optional(),
    reason: z.string().optional(),
  }),
  snapshots: z.array(z.object({
    releaseVersion: z.string().min(1),
    sourceCommit: z.string().min(1),
    buildId: z.string().min(1),
    publishedAt: z.iso.datetime(),
    manifestRef: z.string().min(1),
    artifacts: z.record(z.string(), z.object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })),
    qualification: z.object({
      status: z.enum(["qualified", "experimental-gaps", "not-qualified"]),
      detail: z.string().optional(),
    }),
    state: z.string().optional(),
  })),
});

export type ChannelMetadata = z.infer<typeof channelMetadataSchema>;

/** Canonical release manifest (`rly-release.json`), #128. */
export const releaseManifestSchema = z.object({
  manifestSchemaVersion: z.literal(1),
  product: z.literal("rly-gateway"),
  releaseVersion: z.string().min(1),
  releaseChannel: z.enum(RELEASE_CHANNELS),
  sourceCommit: z.string().min(1),
  buildId: z.string().min(1),
  stateSchemaVersion: z.number().int().positive(),
  controlProtocolVersion: z.number().int().positive(),
  dataProtocolVersion: z.number().int().positive(),
  publishedAt: z.iso.datetime(),
  requiredSignatures: z.array(z.string().min(1)).nonempty(),
  requiredAttestations: z.array(z.string().min(1)).nonempty(),
  workflow: z.unknown().optional(),
  artifacts: z.array(z.object({
    target: z.string().min(1),
    filename: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    targetStatus: z.enum(["supported", "experimental"]),
    requiredSignatures: z.array(z.string().min(1)).nonempty(),
    attestations: z.array(z.string().min(1)).nonempty(),
  })).nonempty(),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/**
 * The verified, immutable acquisition handoff to Wave 4 (#129). Produced only
 * after the full authenticity chain passed: signed channel metadata
 * (signature + rollback/staleness/freeze evaluation), signed release manifest,
 * exact platform target/qualification gates, artifact sha256 + Ed25519 digest
 * statement, and the unpacked-tree content-addressed digest. Acquisition may
 * install/stage this candidate; ONLY Wave 4 activates it (INSTALL != ACTIVATE).
 */
export type VerifiedCandidate = Readonly<{
  product: "rly-gateway";
  version: string;
  channel: ReleaseChannel;
  target: string;
  filename: string;
  sha256: string;
  artifactDigest: string;
  buildId: string;
  commitRevision: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateVersion: number;
  qualificationStatus: "qualified" | "experimental-gaps" | "not-qualified";
  /** Unpacked verified artifact directory (the candidate source for #92 staging). */
  sourceDirectory: string;
  /** Channel metadata monotonic version observed (rollback protection). */
  metadataVersion: number;
  verifiedAt: string;
}>;

export type AcquisitionErrorCode =
  | "network"
  | "channel-metadata-invalid"
  | "channel-signature-invalid"
  | "channel-rollback-detected"
  | "channel-stale"
  | "channel-frozen"
  | "channel-unknown-version"
  | "manifest-invalid"
  | "manifest-signature-invalid"
  | "manifest-identity-mismatch"
  | "release-unknown"
  | "target-unsupported"
  | "target-not-qualified"
  | "artifact-download-failed"
  | "artifact-sha256-mismatch"
  | "artifact-size-mismatch"
  | "artifact-signature-missing"
  | "artifact-signature-invalid"
  | "artifact-tree-invalid"
  | "artifact-digest-mismatch"
  | "candidate-invalid"
  | "unsupported-platform";

/** Typed acquisition failure: actionable, secret-free, never partial success. */
export class AcquisitionError extends Error {
  override name = "AcquisitionError";
  constructor(
    readonly code: AcquisitionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Secret-free durable acquisition-log record (#129 auditability). */
export const acquisitionLogEntrySchema = z.object({
  schemaVersion: z.literal(1),
  at: z.iso.datetime(),
  kind: z.enum(["install", "update", "channel-switch", "repair", "uninstall", "purge"]),
  channel: z.enum(RELEASE_CHANNELS),
  previousChannel: z.enum(RELEASE_CHANNELS).optional(),
  version: z.string().min(1),
  target: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
  metadataVersion: z.number().int().positive(),
  verifiedAt: z.iso.datetime(),
});

export type AcquisitionLogEntry = z.infer<typeof acquisitionLogEntrySchema>;

/** Durable observed per-channel metadata versions (rollback protection). */
export const observedChannelsSchema = z.object({
  schemaVersion: z.literal(1),
  channels: z.object({
    beta: z.object({ highestVersion: z.number().int().positive(), updatedAt: z.iso.datetime() }).optional(),
    stable: z.object({ highestVersion: z.number().int().positive(), updatedAt: z.iso.datetime() }).optional(),
  }),
});

export type ObservedChannels = z.infer<typeof observedChannelsSchema>;
