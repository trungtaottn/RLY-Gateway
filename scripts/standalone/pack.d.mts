// Type declarations for scripts/standalone/pack.mjs (the plain-JS standalone
// artifact packaging library, #35). Kept in sync with the module's exports so
// tests and tooling get precise types at the JS interop boundary.

export type MatrixEntry = {
  nodeDistFor: (version: string) => string;
  status: "supported" | "experimental";
  reason: string;
};

export type IdentityMeta = {
  semanticVersion: string;
  commitRevision: string;
  buildId: string;
  releaseChannel: "dev" | "beta" | "stable";
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
};

export type RlyManifest = IdentityMeta & {
  product: "rly-gateway";
  version: string;
  stateVersion: number;
  migrationClass: string;
};

export type ArtifactMetadata = {
  artifactSchemaVersion: number;
  product: string;
  semanticVersion: string;
  commitRevision: string;
  buildId: string;
  releaseChannel: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
  targetPlatform: string;
  targetStatus: string;
  targetStatusReason: string;
  bundledNodeVersion: string;
  bundledNodeVersionSource: string;
  artifactDigest: string;
  fileCount: number;
  sourceDateEpoch: number;
  allowlistVersion: number;
  digestInputs: string[];
};

export type TreeNode = {
  path: string;
  type: "file" | "dir" | "symlink" | "special";
  target?: string;
};

export type BundledNode = {
  bin: string;
  license: string | undefined;
  version: string;
  source: string;
};

export const ARTIFACT_SCHEMA_VERSION: number;
export const ALLOWLIST_VERSION: number;
export const TARGET_MATRIX: Readonly<Record<string, MatrixEntry>>;
export const ALL_TARGETS: readonly string[];
export const TOP_LEVEL_ALLOWLIST: readonly string[];
export const BIN_ALLOWLIST: readonly string[];
export const DOCS_ALLOWLIST: readonly string[];
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[];
export const PNPM_METADATA_FILES: readonly string[];

export function readJson(path: string): Promise<unknown>;
export function pinnedNodeVersion(): Promise<string>;
export function targetStatus(target: string): MatrixEntry;
export function hostTarget(platform?: string, arch?: string): string | null;
export function forbiddenMatch(path: string): string | undefined;
export function isSafeRelativeSymlink(entryPath: string, target: string): boolean;
export function isTestArtifactPath(name: string): boolean;
export function paxRecord(key: string, value: string): string;
export function walkTree(root: string, relativePrefix?: string): Promise<TreeNode[]>;
export function checkAllowlist(root: string): Promise<string[]>;
export function treeDigest(root: string, options?: { exclude?: string[] }): Promise<string>;
export function sha256Of(data: Uint8Array | string): string;
export function buildRlyLauncher(): string;
export function buildRlyManifest(identityMeta: IdentityMeta): RlyManifest;
export function buildArtifactMetadata(args: {
  identityMeta: IdentityMeta;
  target: string;
  bundledNodeVersion: string;
  bundledNodeVersionSource: string;
  artifactDigest: string;
  fileCount: number;
  sourceDateEpoch: number;
  matrixStatus: string;
  matrixReason: string;
}): ArtifactMetadata;
export function copyEntryDeref(source: string, target: string, visited?: Set<string>): Promise<void>;
export function buildTarBytes(
  entries: Array<{ path: string; type: "file" | "dir" | "symlink"; size: number; content: Uint8Array; linkname?: string }>,
  sourceDateEpoch: number,
): Uint8Array;
export function gzipDeterministic(buffer: Uint8Array): Uint8Array;
export function tarballForTree(root: string, sourceDateEpoch: number): Promise<Uint8Array>;
export function assembleStandaloneArtifact(args: {
  runtimeRoot: string;
  outDir: string;
  target: string;
  node: BundledNode;
  identityMeta: IdentityMeta;
  releaseVersion: string;
  sourceDateEpoch: number;
}): Promise<{ artifactDir: string; metadata: ArtifactMetadata; digest: string; fileCount: number }>;
export function verifyArtifactDirectory(
  artifactRoot: string,
  options?: { target?: string; expectedVersion?: string },
): Promise<{ ok: boolean; errors: string[] }>;
export function smokeRun(
  artifactRoot: string,
  options?: { timeoutMs?: number },
): Promise<{ product: string; version: string; commitRevision: string }>;
export function readFileSafe(path: string): Promise<string | undefined>;
export function readJsonSafe(path: string): Promise<unknown>;
export function writeJson(path: string, value: unknown): Promise<void>;
export function resolveReleaseVersion(args: {
  env?: Record<string, string | undefined>;
  gitTag?: string;
  packageVersion?: string;
}): string;
export function exactGitTag(cwd?: string): string | undefined;
export function comparePath(left: string, right: string): number;
