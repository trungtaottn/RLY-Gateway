import type { z } from "zod";
import {
  AcquisitionError,
  channelMetadataSchema,
  releaseManifestSchema,
  type ChannelMetadata,
  type ReleaseChannel,
  type ReleaseManifest,
} from "./types.js";
import { verifyJsonSignature, verifySignature } from "./signing.js";

/**
 * Signed channel metadata / release manifest resolution (#129), mirroring the
 * #128 publisher semantics (`scripts/release/channel.mjs`,
 * `scripts/release/manifest.mjs`). The updater NEVER trusts a mutable GitHub
 * `latest` target: it lists releases, picks the newest release matching the
 * channel, downloads the signed channel metadata + canonical release
 * manifest, verifies BOTH Ed25519 signatures against the committed public
 * key, and evaluates rollback (monotonic version) / staleness / freeze before
 * any artifact is trusted.
 *
 * All outputs are public build metadata only — never credentials, tokens,
 * prompts, responses, or account identity.
 */

/** Default artifact origin: the GitHub repository releases. */
export const DEFAULT_ORIGIN = "https://github.com/trungtaottn/RLY-Gateway";

const CHANNEL_METADATA_FILENAME = (channel: ReleaseChannel): string => `rly-channel-${channel}.json`;
export const RELEASE_MANIFEST_FILENAME = "rly-release.json";

/**
 * Deterministic monotonic counter for a release version on a channel
 * (mirror of `channelVersionFor`): beta `1.0.0-beta.<n>` → n, stable
 * `1.0.<n>` → n. Returns null when the version is not a valid version for
 * that channel.
 */
export function channelVersionFor(releaseVersion: string, channel: ReleaseChannel): number | null {
  if (channel === "beta") {
    const match = /^\d+\.\d+\.\d+-beta\.(\d+)$/.exec(releaseVersion);
    return match === null ? null : Number(match[1]);
  }
  const match = /^1\.0\.(\d+)$/.exec(releaseVersion);
  return match === null ? null : Number(match[1]);
}

/** The git tag for a release version (release tags are prefixed `v`). */
export function releaseTagFor(releaseVersion: string): string {
  return `v${releaseVersion}`;
}

/** Derives the GitHub API releases-list URL from the repository origin. */
export function releasesApiUrl(origin: string): string {
  const trimmed = origin.replace(/\/+$/, "");
  if (trimmed.startsWith("https://api.github.com/repos/")) return `${trimmed}/releases`;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (match === null) {
    throw new AcquisitionError("network", `cannot derive a GitHub API URL from origin ${origin}`);
  }
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) {
    throw new AcquisitionError("network", `cannot derive a GitHub API URL from origin ${origin}`);
  }
  return `https://api.github.com/repos/${owner}/${repo}/releases`;
}

/** Release-asset download URL (public; GitHub redirects to the CDN). */
export function releaseAssetUrl(origin: string, releaseVersion: string, filename: string): string {
  return `${origin.replace(/\/+$/, "")}/releases/download/${releaseTagFor(releaseVersion)}/${filename}`;
}

export type ReleaseListEntry = Readonly<{
  tagName: string;
  draft: boolean;
}>;

/**
 * Lists published releases (newest first). Deliberately bounded to the first
 * page: channel metadata rollback/staleness/freeze + signature verification
 * is the trust authority, never an unbounded scan.
 */
export async function listReleases(
  origin: string,
  fetchImpl: typeof fetch,
  limit = 100,
): Promise<readonly ReleaseListEntry[]> {
  const url = `${releasesApiUrl(origin)}?per_page=${String(limit)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "rly-gateway-installer" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AcquisitionError("network", `cannot list releases from ${url}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new AcquisitionError("network", `release listing failed with HTTP ${String(response.status)} from ${url}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AcquisitionError("network", `release listing returned a non-JSON body from ${url}`);
  }
  if (!Array.isArray(payload)) {
    throw new AcquisitionError("network", `release listing returned an unexpected shape from ${url}`);
  }
  return payload
    .filter((entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => entry.draft !== true)
    .map((entry) => {
      const tagName = typeof entry.tag_name === "string" ? entry.tag_name : "";
      return { tagName, draft: entry.draft === true };
    })
    .filter((entry) => entry.tagName.length > 0);
}

/**
 * Selects the newest release whose tag is a valid version for the channel
 * (mirror of the #128 channel-version pattern). `dev`-style tags never match.
 */
export function selectChannelRelease(
  releases: readonly ReleaseListEntry[],
  channel: ReleaseChannel,
): { releaseVersion: string; tag: string } | undefined {
  for (const release of releases) {
    const candidate = release.tagName.replace(/^v/, "");
    if (channelVersionFor(candidate, channel) !== null) {
      return { releaseVersion: candidate, tag: release.tagName };
    }
  }
  return undefined;
}

/** Downloads bytes with bounded size + timeout; fails closed on any error. */
export async function downloadBytes(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      headers: { "user-agent": "rly-gateway-installer" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AcquisitionError("network", `download failed for ${url}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new AcquisitionError("network", `download failed with HTTP ${String(response.status)} for ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AcquisitionError("network", `download ${url} exceeds the ${String(maxBytes)} byte bound`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new AcquisitionError("network", `download ${url} exceeds the ${String(maxBytes)} byte bound`);
  }
  return bytes;
}

function parseRawJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new AcquisitionError("network", `${what} is not valid JSON`);
  }
}

/** Fetches a signed JSON release asset and verifies its Ed25519 signature. */
export async function fetchSignedJsonAsset<T>(
  url: string,
  fetchImpl: typeof fetch,
  publicKeyPem: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<{ value: T; signatureVerified: boolean }> {
  const [bodyBytes, sigBytes] = await Promise.all([
    downloadBytes(url, fetchImpl, 1_000_000),
    downloadBytes(`${url}.sig`, fetchImpl, 16_384),
  ]);
  // Verify the signature over the RAW parsed JSON — canonical signing covers
  // every published field, so a schema-validated (field-stripped) copy would
  // fail verification. Validation happens after authenticity.
  const raw = parseRawJson(bodyBytes, what);
  let signatureVerified: boolean;
  try {
    const envelope: unknown = JSON.parse(Buffer.from(sigBytes).toString("utf8")) as unknown;
    signatureVerified = verifyJsonSignature(publicKeyPem, raw, envelope);
  } catch (error) {
    throw new AcquisitionError("channel-signature-invalid", `${what} signature verification failed: ${errorMessage(error)}`);
  }
  if (!signatureVerified) {
    throw new AcquisitionError("channel-signature-invalid", `${what} signature does not verify against the release public key`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AcquisitionError("channel-metadata-invalid", `${what} failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return { value: parsed.data, signatureVerified: true };
}

export type ChannelMetadataEvaluation = Readonly<{
  ok: boolean;
  errors: readonly string[];
  rollbackDetected: boolean;
  stale: boolean;
  frozen: boolean;
  ageDays: number | null;
}>;

/**
 * Evaluates channel metadata from the updater's point of view (#128): rollback
 * (monotonic version < highest observed), staleness (`updatedAt` +
 * `staleness.maxAgeDays`), and freeze (explicit marker). Any failure must
 * refuse the channel snapshot.
 */
export function evaluateChannelMetadata(
  metadata: ChannelMetadata,
  options: Readonly<{ highestObservedVersion: number; now?: string }> = { highestObservedVersion: 0 },
): ChannelMetadataEvaluation {
  const errors: string[] = [];
  const evaluation: ChannelMetadataEvaluation = {
    ok: true,
    errors,
    rollbackDetected: false,
    stale: false,
    frozen: false,
    ageDays: null,
  };
  if (metadata.version < options.highestObservedVersion) {
    (evaluation as { rollbackDetected: boolean }).rollbackDetected = true;
    errors.push(
      `rollback detected: metadata version ${String(metadata.version)} < highest observed ${String(options.highestObservedVersion)}; refusing to trust an older channel snapshot`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  const ageMs = Date.parse(now) - Date.parse(metadata.updatedAt);
  if (Number.isNaN(ageMs)) {
    errors.push("cannot compute channel metadata age: updatedAt invalid");
  } else {
    (evaluation as { ageDays: number | null }).ageDays = ageMs / 86_400_000;
    const ageDays = evaluation.ageDays ?? 0;
    if (ageDays > metadata.staleness.maxAgeDays) {
      (evaluation as { stale: boolean }).stale = true;
      errors.push(`channel metadata is stale: ${ageDays.toFixed(1)} days old > ${String(metadata.staleness.maxAgeDays)} day window`);
    }
  }
  if (metadata.freeze.frozen) {
    (evaluation as { frozen: boolean }).frozen = true;
    errors.push("channel is frozen; refusing to activate beyond the frozen snapshot");
  }
  (evaluation as { ok: boolean }).ok = errors.length === 0;
  return evaluation;
}

/**
 * Resolves the newest channel metadata: lists releases, selects the newest
 * release for the channel, fetches + signature-verifies the channel metadata,
 * and evaluates rollback/staleness/freeze. `version` pins an exact release
 * instead of resolving the newest.
 */
export async function resolveChannelMetadata(
  options: Readonly<{
    origin: string;
    channel: ReleaseChannel;
    fetchImpl?: typeof fetch;
    publicKeyPem: string;
    highestObservedVersion?: number;
    now?: string;
    version?: string;
  }>,
): Promise<{ metadata: ChannelMetadata; releaseVersion: string; tag: string; signatureVerified: boolean; evaluation: ChannelMetadataEvaluation }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let releaseVersion: string;
  let tag: string;
  if (options.version !== undefined) {
    releaseVersion = options.version;
    tag = releaseTagFor(options.version);
  } else {
    const releases = await listReleases(options.origin, fetchImpl);
    const selected = selectChannelRelease(releases, options.channel);
    if (selected === undefined) {
      throw new AcquisitionError("channel-unknown-version", `no ${options.channel} release found on ${options.origin}`);
    }
    releaseVersion = selected.releaseVersion;
    tag = selected.tag;
  }
  const url = releaseAssetUrl(options.origin, releaseVersion, CHANNEL_METADATA_FILENAME(options.channel));
  const { value, signatureVerified } = await fetchSignedJsonAsset(
    url,
    fetchImpl,
    options.publicKeyPem,
    channelMetadataSchema,
    `channel metadata ${CHANNEL_METADATA_FILENAME(options.channel)}`,
  );
  if (value.channel !== options.channel) {
    throw new AcquisitionError("channel-metadata-invalid", `channel metadata declares channel ${value.channel}, not ${options.channel}`);
  }
  const snapshot = value.snapshots.find((entry) => entry.releaseVersion === releaseVersion);
  if (snapshot === undefined) {
    throw new AcquisitionError(
      "channel-unknown-version",
      `channel metadata ${CHANNEL_METADATA_FILENAME(options.channel)} has no snapshot for release ${releaseVersion}; refusing an unknown release identity`,
    );
  }
  const evaluation = evaluateChannelMetadata(value, {
    highestObservedVersion: options.highestObservedVersion ?? 0,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!evaluation.ok) {
    throw new AcquisitionError(
      evaluation.rollbackDetected ? "channel-rollback-detected" : evaluation.stale ? "channel-stale" : "channel-frozen",
      `channel metadata evaluation failed: ${evaluation.errors.join("; ")}`,
    );
  }
  return { metadata: value, releaseVersion, tag, signatureVerified, evaluation };
}

/**
 * Resolves + signature-verifies the canonical release manifest for a release
 * and cross-checks it against the channel snapshot identity.
 */
export async function resolveReleaseManifest(
  options: Readonly<{
    origin: string;
    releaseVersion: string;
    channel: ReleaseChannel;
    fetchImpl?: typeof fetch;
    publicKeyPem: string;
  }>,
): Promise<{ manifest: ReleaseManifest; signatureVerified: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = releaseAssetUrl(options.origin, options.releaseVersion, RELEASE_MANIFEST_FILENAME);
  const { value, signatureVerified } = await fetchSignedJsonAsset(
    url,
    fetchImpl,
    options.publicKeyPem,
    releaseManifestSchema,
    `release manifest ${RELEASE_MANIFEST_FILENAME}`,
  );
  if (value.releaseVersion !== options.releaseVersion) {
    throw new AcquisitionError(
      "manifest-identity-mismatch",
      `release manifest version ${value.releaseVersion} does not match the channel snapshot ${options.releaseVersion}`,
    );
  }
  if (value.releaseChannel !== options.channel) {
    throw new AcquisitionError("manifest-identity-mismatch", `release manifest channel ${value.releaseChannel} does not match ${options.channel}`);
  }
  return { manifest: value, signatureVerified };
}

export type TargetArtifact = Readonly<{
  target: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  artifactDigest: string;
  targetStatus: "supported" | "experimental";
}>;

/**
 * Selects the exact platform artifact from the manifest and enforces the
 * channel qualification gate (#128): stable requires a `supported` target with
 * `qualified` channel qualification; beta permits documented
 * `experimental-gaps` but never `not-qualified`. Unknown targets and
 * unqualified-for-stable targets fail closed with actionable messages.
 */
export function resolveTargetArtifact(
  manifest: ReleaseManifest,
  channel: ReleaseChannel,
  target: string,
  channelQualificationStatus: "qualified" | "experimental-gaps" | "not-qualified",
): TargetArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.target === target);
  if (artifact === undefined) {
    const available = manifest.artifacts.map((entry) => entry.target).join(", ");
    throw new AcquisitionError(
      "target-unsupported",
      `release ${manifest.releaseVersion} has no artifact for target ${target}; available targets: ${available}`,
    );
  }
  if (channel === "stable" && artifact.targetStatus !== "supported") {
    throw new AcquisitionError(
      "target-unsupported",
      `target ${target} is ${artifact.targetStatus} on the stable channel; stable requires a supported, qualified target`,
    );
  }
  if (channel === "stable" && channelQualificationStatus !== "qualified") {
    throw new AcquisitionError(
      "target-not-qualified",
      `target ${target} is not stable-qualified (channel qualification: ${channelQualificationStatus}); stable requires exact-byte qualification on the published digest`,
    );
  }
  if (channelQualificationStatus === "not-qualified") {
    throw new AcquisitionError(
      "target-not-qualified",
      `target ${target} qualification is ${channelQualificationStatus} for channel ${channel}; refusing to install unqualified bytes`,
    );
  }
  return artifact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// Re-export for tests/consistency with the publisher-side verifier.
export { verifySignature };
