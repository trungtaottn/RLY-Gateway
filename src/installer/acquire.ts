import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  downloadBytes,
  evaluateChannelMetadata,
  releaseAssetUrl,
  resolveChannelMetadata,
  resolveReleaseManifest,
  resolveTargetArtifact,
} from "./metadata.js";
import { verifyDigestStatement, verifyJsonSignature } from "./signing.js";
import { RELEASE_PUBLIC_KEY_PEM } from "./release-key.js";
import {
  AcquisitionError,
  channelMetadataSchema,
  releaseManifestSchema,
  SUPPORTED_TARGETS,
  type ReleaseChannel,
  type SupportedTarget,
  type VerifiedCandidate,
} from "./types.js";
import { LocalCandidateInstaller } from "../runtime/update/installer.js";
import type { CandidateInstallResult } from "../runtime/update/types.js";
import {
  ensurePrivateDirectory,
  isNotFound,
  PRIVATE_DIRECTORY_MODE,
} from "../storage/private-files.js";

/**
 * Verified remote acquisition (#129). Resolves the selected channel/platform/
 * arch through the #128 signed metadata, downloads the EXACT immutable
 * artifact from the approved origin, and verifies — BEFORE any install
 * mutation — the full authenticity chain:
 *
 *   1. signed channel metadata (Ed25519 signature + rollback/staleness/freeze
 *      evaluation against the durable observed version),
 *   2. signed canonical release manifest + identity cross-checks,
 *   3. exact platform target + channel qualification gate,
 *   4. artifact tarball sha256/size + the Ed25519 digest statement
 *      (`<tarball>.sig` over `sha256:<hex>`),
 *   5. unpacked-tree content-addressed digest equals the manifest
 *      `artifactDigest` + `rly-build.json`/`rly.json`/`rly-artifact.json`
 *      identity consistency.
 *
 * Any mismatch fails BEFORE the artifact is installed/staged, with an
 * actionable secret-free error. Acquisition may stage the verified candidate
 * (INSTALL != ACTIVATE): `installVerifiedCandidate` never touches `refs/active`
 * and never restarts the resident service.
 */

export const ARTIFACT_SIGNATURE_SUFFIX = ".sig";

const artifactMetadataSchema = z.object({
  artifactSchemaVersion: z.literal(1).optional(),
  product: z.string().optional(),
  semanticVersion: z.string().optional(),
  commitRevision: z.string().optional(),
  buildId: z.string().optional(),
  releaseChannel: z.enum(["dev", "beta", "stable"]).optional(),
  controlProtocolVersion: z.number().int().positive().optional(),
  dataProtocolVersion: z.number().int().positive().optional(),
  stateSchemaVersion: z.number().int().positive().optional(),
  targetPlatform: z.string().optional(),
  targetStatus: z.string().optional(),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  fileCount: z.number().int().nonnegative().optional(),
});

const candidateManifestSchema = z.object({
  product: z.literal("rly-gateway"),
  version: z.string().min(1),
  stateVersion: z.number().int().positive(),
  migrationForwardOnly: z.boolean().optional(),
  migrationClass: z.enum(["none", "backward-compatible-expand", "transactional-replace", "forward-only"]).optional(),
  buildId: z.string().min(1).optional(),
  commitRevision: z.string().min(1).optional(),
  releaseChannel: z.enum(["dev", "beta", "stable"]).optional(),
  controlProtocolVersion: z.number().int().positive().optional(),
  dataProtocolVersion: z.number().int().positive().optional(),
});

const buildIdentitySchema = z.object({
  identitySchemaVersion: z.number().int().positive().optional(),
  product: z.string().optional(),
  semanticVersion: z.string().min(1),
  commitRevision: z.string().min(1),
  buildId: z.string().min(1),
  releaseChannel: z.enum(["dev", "beta", "stable"]),
  controlProtocolVersion: z.number().int().positive(),
  dataProtocolVersion: z.number().int().positive(),
  stateSchemaVersion: z.number().int().positive(),
  artifactId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

/** Host target name for the current machine (e.g. "linux-x64"), or null. */
export function hostTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): SupportedTarget | null {
  const target = `${platform}-${arch}`;
  return (SUPPORTED_TARGETS as readonly string[]).includes(target) ? (target as SupportedTarget) : null;
}

/**
 * Cross-checks the release manifest against the unpacked #94 exact build
 * identity (`rly-build.json`). An exact release must agree on version, commit,
 * build ID, channel, and the control/data/state schema versions — a split
 * identity is a hard failure (mirror of `releaseManifestMatchesIdentity`).
 */
export function releaseManifestMatchesIdentity(
  manifest: Readonly<{
    releaseVersion: string;
    sourceCommit: string;
    buildId: string;
    releaseChannel: string;
    controlProtocolVersion: number;
    dataProtocolVersion: number;
    stateSchemaVersion: number;
  }>,
  buildMeta: BuildIdentity,
): readonly string[] {
  const errors: string[] = [];
  if (manifest.releaseVersion !== buildMeta.semanticVersion) {
    errors.push(`releaseVersion ${manifest.releaseVersion} != build identity semanticVersion ${buildMeta.semanticVersion}`);
  }
  if (manifest.sourceCommit !== buildMeta.commitRevision) {
    errors.push(`sourceCommit ${manifest.sourceCommit} != build identity commitRevision ${buildMeta.commitRevision}`);
  }
  if (manifest.buildId !== buildMeta.buildId) {
    errors.push(`buildId ${manifest.buildId} != build identity buildId ${buildMeta.buildId}`);
  }
  if (manifest.releaseChannel !== buildMeta.releaseChannel) {
    errors.push(`releaseChannel ${manifest.releaseChannel} != build identity releaseChannel ${buildMeta.releaseChannel}`);
  }
  if (manifest.controlProtocolVersion !== buildMeta.controlProtocolVersion) {
    errors.push(`controlProtocolVersion mismatch: ${String(manifest.controlProtocolVersion)} != ${String(buildMeta.controlProtocolVersion)}`);
  }
  if (manifest.dataProtocolVersion !== buildMeta.dataProtocolVersion) {
    errors.push(`dataProtocolVersion mismatch: ${String(manifest.dataProtocolVersion)} != ${String(buildMeta.dataProtocolVersion)}`);
  }
  if (manifest.stateSchemaVersion !== buildMeta.stateSchemaVersion) {
    errors.push(`stateSchemaVersion mismatch: ${String(manifest.stateSchemaVersion)} != ${String(buildMeta.stateSchemaVersion)}`);
  }
  return errors;
}

export type AcquireOptions = Readonly<{
  origin: string;
  channel: ReleaseChannel;
  target: SupportedTarget;
  /** Exact release version pin; resolves the newest channel release when absent. */
  version?: string;
  /** Durable directory that owns the staged downloads + unpacked candidate. */
  stagingDirectory: string;
  fetchImpl?: typeof fetch;
  publicKeyPem?: string;
  now?: string;
  highestObservedVersion?: number;
}>;

/**
 * Full verified remote acquisition: signed metadata chain → exact artifact
 * download → digest/signature/tree verification → verified candidate.
 */
export async function acquireVerifiedCandidate(options: AcquireOptions): Promise<VerifiedCandidate> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const publicKeyPem = options.publicKeyPem ?? RELEASE_PUBLIC_KEY_PEM;
  await ensurePrivateDirectory(options.stagingDirectory);

  const resolved = await resolveChannelMetadata({
    origin: options.origin,
    channel: options.channel,
    fetchImpl,
    publicKeyPem,
    ...(options.highestObservedVersion === undefined ? {} : { highestObservedVersion: options.highestObservedVersion }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  const snapshot = resolved.metadata.snapshots.find((entry) => entry.releaseVersion === resolved.releaseVersion);
  if (snapshot === undefined) {
    throw new AcquisitionError("channel-unknown-version", `channel snapshot for ${resolved.releaseVersion} is missing`);
  }
  const channelArtifact = snapshot.artifacts[options.target];
  if (channelArtifact === undefined) {
    throw new AcquisitionError("target-unsupported", `channel snapshot has no artifact entry for target ${options.target}`);
  }

  const { manifest } = await resolveReleaseManifest({
    origin: options.origin,
    releaseVersion: resolved.releaseVersion,
    channel: options.channel,
    fetchImpl,
    publicKeyPem,
  });

  const artifact = resolveTargetArtifact(manifest, options.channel, options.target, snapshot.qualification.status);

  // The channel snapshot and the manifest must agree on the exact bytes.
  if (channelArtifact.sha256 !== artifact.sha256 || channelArtifact.artifactDigest !== artifact.artifactDigest) {
    throw new AcquisitionError(
      "manifest-identity-mismatch",
      `channel metadata and release manifest disagree on ${options.target} bytes; refusing`,
    );
  }

  const verified = await verifyAndUnpackArtifact({
    tarballUrl: releaseAssetUrl(options.origin, resolved.releaseVersion, artifact.filename),
    tarballPath: join(options.stagingDirectory, artifact.filename),
    unpackedDirectory: join(options.stagingDirectory, `${basename(artifact.filename, ".tar.gz")}.unpacked`),
    fetchImpl,
    publicKeyPem,
    expected: artifact,
    manifest,
  });

  return {
    product: "rly-gateway",
    version: resolved.releaseVersion,
    channel: options.channel,
    target: options.target,
    filename: artifact.filename,
    sha256: verified.sha256,
    artifactDigest: verified.artifactDigest,
    buildId: verified.buildMeta.buildId,
    commitRevision: verified.buildMeta.commitRevision,
    controlProtocolVersion: verified.buildMeta.controlProtocolVersion,
    dataProtocolVersion: verified.buildMeta.dataProtocolVersion,
    stateVersion: verified.buildMeta.stateSchemaVersion,
    qualificationStatus: snapshot.qualification.status,
    sourceDirectory: verified.unpackedDirectory,
    metadataVersion: resolved.metadata.version,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Verifies an already-downloaded acquisition (the bootstrap-installer handoff):
 * channel metadata + release manifest + artifact are read from
 * `metadataDirectory` (private staging created by `scripts/install.sh`) and the
 * FULL signature/digest chain is re-verified locally before install. Failures
 * are identical to the remote path — nothing installs on unverified content.
 */
export async function verifyLocalAcquisition(
  options: Readonly<{
    metadataDirectory: string;
    tarballPath: string;
    channel: ReleaseChannel;
    target: SupportedTarget;
    publicKeyPem?: string;
    now?: string;
    highestObservedVersion?: number;
  }>,
): Promise<VerifiedCandidate> {
  const publicKeyPem = options.publicKeyPem ?? RELEASE_PUBLIC_KEY_PEM;
  const channelFilename = `rly-channel-${options.channel}.json`;
  const channelBytes = await readFileRequired(join(options.metadataDirectory, channelFilename), `channel metadata ${channelFilename}`);
  const channelSig = await readFileRequired(join(options.metadataDirectory, `${channelFilename}.sig`), `${channelFilename} signature`);
  const channelRaw = parseRawJson(channelBytes, `channel metadata ${channelFilename}`);
  if (!verifyJsonSignature(publicKeyPem, channelRaw, parseSignature(channelSig, channelFilename))) {
    throw new AcquisitionError("channel-signature-invalid", `channel metadata ${channelFilename} signature does not verify`);
  }
  const channelMetadata = validateChannelMetadata(channelRaw, `channel metadata ${channelFilename}`);

  const evaluation = evaluateChannelMetadata(channelMetadata, {
    highestObservedVersion: options.highestObservedVersion ?? 0,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!evaluation.ok) {
    throw new AcquisitionError(
      evaluation.rollbackDetected ? "channel-rollback-detected" : evaluation.stale ? "channel-stale" : "channel-frozen",
      `channel metadata evaluation failed: ${evaluation.errors.join("; ")}`,
    );
  }
  const snapshot = channelMetadata.snapshots.find((entry) => entry.state === "current") ?? channelMetadata.snapshots[0];
  if (snapshot === undefined) {
    throw new AcquisitionError("channel-metadata-invalid", `channel metadata ${channelFilename} carries no snapshot`);
  }
  const releaseVersion = snapshot.releaseVersion;
  const channelArtifact = snapshot.artifacts[options.target];
  if (channelArtifact === undefined) {
    throw new AcquisitionError("target-unsupported", `channel snapshot has no artifact entry for target ${options.target}`);
  }

  const manifestBytes = await readFileRequired(join(options.metadataDirectory, "rly-release.json"), "release manifest rly-release.json");
  const manifestSig = await readFileRequired(join(options.metadataDirectory, "rly-release.json.sig"), "release manifest signature");
  const manifest = parseManifest(manifestBytes);
  if (!verifyJsonSignature(publicKeyPem, manifest.raw, parseSignature(manifestSig, "rly-release.json"))) {
    throw new AcquisitionError("manifest-signature-invalid", "release manifest signature does not verify");
  }
  const validatedManifest = manifest.validated;
  if (validatedManifest.releaseVersion !== releaseVersion) {
    throw new AcquisitionError("manifest-identity-mismatch", `release manifest version ${validatedManifest.releaseVersion} does not match the channel snapshot ${releaseVersion}`);
  }
  if (validatedManifest.releaseChannel !== options.channel) {
    throw new AcquisitionError("manifest-identity-mismatch", `release manifest channel ${validatedManifest.releaseChannel} does not match ${options.channel}`);
  }

  const artifact = resolveTargetArtifact(validatedManifest, options.channel, options.target, snapshot.qualification.status);
  if (channelArtifact.sha256 !== artifact.sha256 || channelArtifact.artifactDigest !== artifact.artifactDigest) {
    throw new AcquisitionError(
      "manifest-identity-mismatch",
      `channel metadata and release manifest disagree on ${options.target} bytes; refusing`,
    );
  }

  const verified = await verifyUnpackedArtifact({
    tarballPath: options.tarballPath,
    unpackedDirectory: join(dirname(options.tarballPath), `${basename(options.tarballPath, ".tar.gz")}.unpacked`),
    publicKeyPem,
    expected: artifact,
    manifest: validatedManifest,
  });

  return {
    product: "rly-gateway",
    version: releaseVersion,
    channel: options.channel,
    target: options.target,
    filename: artifact.filename,
    sha256: verified.sha256,
    artifactDigest: verified.artifactDigest,
    buildId: verified.buildMeta.buildId,
    commitRevision: verified.buildMeta.commitRevision,
    controlProtocolVersion: verified.buildMeta.controlProtocolVersion,
    dataProtocolVersion: verified.buildMeta.dataProtocolVersion,
    stateVersion: verified.buildMeta.stateSchemaVersion,
    qualificationStatus: snapshot.qualification.status,
    sourceDirectory: verified.unpackedDirectory,
    metadataVersion: channelMetadata.version,
    verifiedAt: new Date().toISOString(),
  };
}

type ExpectedArtifact = Readonly<{ filename: string; sizeBytes: number; sha256: string; artifactDigest: string }>;

type ManifestFields = Readonly<{
  releaseVersion: string;
  sourceCommit: string;
  buildId: string;
  releaseChannel: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
}>;

type VerifiedArtifact = Readonly<{
  sha256: string;
  artifactDigest: string;
  buildMeta: BuildIdentity;
  unpackedDirectory: string;
}>;

async function verifyAndUnpackArtifact(input: Readonly<{
  tarballUrl: string;
  tarballPath: string;
  unpackedDirectory: string;
  fetchImpl: typeof fetch;
  publicKeyPem: string;
  expected: ExpectedArtifact;
  manifest: ManifestFields;
}>): Promise<VerifiedArtifact> {
  await ensurePrivateDirectory(dirname(input.tarballPath));
  const tarballBytes = await downloadBytes(input.tarballUrl, input.fetchImpl, 256 * 1024 * 1024);
  await writePrivateBytes(input.tarballPath, tarballBytes);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = await downloadBytes(`${input.tarballUrl}${ARTIFACT_SIGNATURE_SUFFIX}`, input.fetchImpl, 16_384);
  } catch (error) {
    throw new AcquisitionError("artifact-signature-missing", `artifact signature ${input.expected.filename}.sig is unavailable: ${errorMessage(error)}`);
  }
  await writePrivateBytes(`${input.tarballPath}.sig`, signatureBytes);
  return verifyUnpackedArtifact({ ...input, signatureBytes });
}

async function verifyUnpackedArtifact(
  input: Readonly<{
    tarballPath: string;
    unpackedDirectory: string;
    publicKeyPem: string;
    expected: ExpectedArtifact;
    manifest: ManifestFields;
    signatureBytes?: Uint8Array;
  }>,
): Promise<VerifiedArtifact> {
  const tarballBytes = await readFileRequired(input.tarballPath, `artifact ${input.expected.filename}`);
  const sha256 = sha256Of(tarballBytes);
  if (sha256 !== input.expected.sha256) {
    throw new AcquisitionError(
      "artifact-sha256-mismatch",
      `artifact ${input.expected.filename} sha256 ${sha256} does not match the signed metadata ${input.expected.sha256}; refusing before install`,
    );
  }
  const info = await stat(input.tarballPath).catch(() => undefined);
  if (info !== undefined && info.size !== input.expected.sizeBytes) {
    throw new AcquisitionError("artifact-size-mismatch", `artifact ${input.expected.filename} size ${String(info.size)} does not match the manifest ${String(input.expected.sizeBytes)}`);
  }
  let signatureBytes = input.signatureBytes;
  if (signatureBytes === undefined) {
    try {
      signatureBytes = await readFileRequired(`${input.tarballPath}.sig`, `artifact signature ${input.expected.filename}.sig`);
    } catch (error) {
      throw new AcquisitionError("artifact-signature-missing", `artifact signature ${input.expected.filename}.sig is unavailable: ${errorMessage(error)}`);
    }
  }
  let digestVerified: boolean;
  try {
    digestVerified = verifyDigestStatement(input.publicKeyPem, sha256, parseSignature(signatureBytes, `${input.expected.filename}.sig`));
  } catch (error) {
    throw new AcquisitionError("artifact-signature-invalid", `artifact signature verification failed: ${errorMessage(error)}`);
  }
  if (!digestVerified) {
    throw new AcquisitionError("artifact-signature-invalid", `artifact ${input.expected.filename} digest statement does not verify against the release public key`);
  }

  // Unpack only after the integrity + authenticity chain passed.
  await rm(input.unpackedDirectory, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(input.unpackedDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    await promisify(execFile)("tar", ["-xzf", input.tarballPath, "-C", input.unpackedDirectory], { timeout: 120_000 });
  } catch (error) {
    throw new AcquisitionError("artifact-tree-invalid", `artifact ${input.expected.filename} could not be unpacked: ${errorMessage(error)}`);
  }
  await chmod(input.unpackedDirectory, PRIVATE_DIRECTORY_MODE);

  // Unpacked-tree verification: identity consistency + content-addressed digest.
  const buildMeta = await readBuildIdentity(input.unpackedDirectory, input.expected.filename);
  const identityErrors = releaseManifestMatchesIdentity(input.manifest, buildMeta);
  if (identityErrors.length > 0) {
    throw new AcquisitionError("manifest-identity-mismatch", `unpacked build identity diverges from the release manifest: ${identityErrors.join("; ")}`);
  }
  const artifactMeta = await readArtifactMetadata(input.unpackedDirectory, input.expected.filename);
  if (artifactMeta.artifactDigest !== undefined && artifactMeta.artifactDigest !== input.expected.artifactDigest) {
    throw new AcquisitionError("artifact-digest-mismatch", `unpacked rly-artifact.json digest ${artifactMeta.artifactDigest} does not match the manifest ${input.expected.artifactDigest}`);
  }
  const candidate = await readCandidateManifest(input.unpackedDirectory, input.expected.filename);
  if (candidate === undefined) {
    throw new AcquisitionError("candidate-invalid", `unpacked artifact ${input.expected.filename} lacks a valid rly.json candidate manifest`);
  }
  const treeDigest = await treeDigestExcluding(input.unpackedDirectory, ["rly-artifact.json"]);
  if (treeDigest !== input.expected.artifactDigest) {
    throw new AcquisitionError("artifact-digest-mismatch", `unpacked tree digest ${treeDigest} does not equal the signed artifact digest ${input.expected.artifactDigest}`);
  }
  return { sha256, artifactDigest: treeDigest, buildMeta, unpackedDirectory: input.unpackedDirectory };
}

/**
 * Stages a verified candidate into the #92 immutable store (INSTALL !=
 * ACTIVATE): only `refs/staged` is updated; `refs/active` and the resident
 * service are never touched. Wave 4 activates the candidate.
 */
export async function installVerifiedCandidate(
  options: Readonly<{
    candidate: VerifiedCandidate;
    controlPlaneDirectory: string;
    installer?: LocalCandidateInstaller;
  }>,
): Promise<CandidateInstallResult> {
  const installer = options.installer ?? new LocalCandidateInstaller({ directory: options.controlPlaneDirectory });
  return installer.installCandidate({ version: options.candidate.version, sourceDirectory: options.candidate.sourceDirectory });
}

/**
 * Deterministic content-addressed digest of a tree with the SAME rules as the
 * #35 artifact digest (sorted relative paths + per-file sha256 + relative
 * symlink targets; `exclude` entries omitted, e.g. `rly-artifact.json` which
 * carries the digest). Escaping/absolute links fail closed.
 */
export async function treeDigestExcluding(root: string, exclude: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const entries = await treeFileDigests(root, "", exclude);
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}

async function treeFileDigests(
  root: string,
  relative: string,
  exclude: readonly string[],
): Promise<ReadonlyArray<{ path: string; sha256: string }>> {
  const directory = relative ? join(root, relative) : root;
  const names = await readdir(directory);
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const name of names.sort(comparePath)) {
    const entryRelative = relative ? `${relative}/${name}` : name;
    if (exclude.includes(entryRelative)) continue;
    const details = await lstat(join(directory, name)).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (details === undefined) continue;
    if (details.isSymbolicLink()) {
      const target = await readlink(join(directory, name));
      if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
        throw new AcquisitionError("artifact-tree-invalid", `artifact contains an absolute symlink ${entryRelative} -> ${target}; refusing`);
      }
      entries.push({ path: entryRelative, sha256: `link:${target}` });
      continue;
    }
    if (details.isDirectory()) {
      entries.push(...await treeFileDigests(root, entryRelative, exclude));
      continue;
    }
    if (!details.isFile()) {
      throw new AcquisitionError("artifact-tree-invalid", `artifact contains a special file: ${entryRelative}`);
    }
    const contents = await readFile(join(directory, name));
    entries.push({ path: entryRelative, sha256: sha256Of(contents) });
  }
  return entries;
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readBuildIdentity(root: string, filename: string): Promise<BuildIdentity> {
  const bytes = await readFileRequired(join(root, "rly-build.json"), `artifact ${filename} rly-build.json`);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const result = buildIdentitySchema.safeParse(parsed);
  if (!result.success) {
    throw new AcquisitionError("artifact-tree-invalid", `artifact ${filename} rly-build.json is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

async function readArtifactMetadata(root: string, filename: string): Promise<z.infer<typeof artifactMetadataSchema>> {
  const bytes = await readFileRequired(join(root, "rly-artifact.json"), `artifact ${filename} rly-artifact.json`);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const result = artifactMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new AcquisitionError("artifact-tree-invalid", `artifact ${filename} rly-artifact.json is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

async function readCandidateManifest(root: string, filename: string): Promise<z.infer<typeof candidateManifestSchema> | undefined> {
  const bytes = await readFileRequired(join(root, "rly.json"), `artifact ${filename} rly.json`);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const result = candidateManifestSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return result.data;
}

function parseRawJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new AcquisitionError("network", `${what} is not valid JSON`);
  }
}

function validateChannelMetadata(raw: unknown, what: string): z.infer<typeof channelMetadataSchema> {
  const parsed = channelMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AcquisitionError("channel-metadata-invalid", `${what} failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function parseManifest(bytes: Uint8Array): { raw: unknown; validated: z.infer<typeof releaseManifestSchema> } {
  const raw = parseRawJson(bytes, "release manifest rly-release.json");
  const parsed = releaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AcquisitionError("manifest-invalid", `release manifest failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return { raw, validated: parsed.data };
}

function parseSignature(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new AcquisitionError("channel-signature-invalid", `${what} signature is not valid JSON`);
  }
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readFileRequired(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new AcquisitionError("network", `${what} is unavailable at ${path}: ${errorMessage(error)}`);
  }
}

/** Private 0600 atomic binary write (downloads must never be world-readable). */
async function writePrivateBytes(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${randomSuffix()}.tmp`;
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function randomSuffix(): string {
  return createHash("sha256").update(String(Date.now())).update(randomBytes(8)).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export { RELEASE_PUBLIC_KEY_PEM };
