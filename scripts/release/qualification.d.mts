// Type declarations for scripts/release/qualification.mjs (exact-byte qualification, #128).

export type QualificationGateResult = {
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
  command: string;
};

export type QualificationDocument = {
  qualificationSchemaVersion: 1;
  releaseVersion: string;
  channel: string;
  target: string;
  qualifiedBytes: { filename: string; sha256: string; artifactDigest: string };
  host: { platform: string; arch: string; os: string };
  gates: QualificationGateResult[];
  result: "qualified" | "experimental-gaps" | "not-qualified";
};

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean; timeoutMs?: number },
) => { ok: boolean; output: string };

export const QUALIFICATION_SCHEMA_VERSION: 1;
export const QUALIFICATION_FILENAME: "rly-qualification.json";
export const QUALIFICATION_RESULTS: readonly string[];
export const QUALIFICATION_GATES: ReadonlyArray<{ id: string; name: string; description: string }>;
export const REQUIRED_GATES_FOR_STABLE: readonly string[];

export function gateResult(id: string, status: string, args?: { detail?: string; command?: string }): QualificationGateResult;
export function runCommand(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean; timeoutMs?: number }): { ok: boolean; output: string };
export function extractTarball(tarballPath: string, destDir: string): Promise<string>;
export function runVersionIdentity(artifactRoot: string, args?: { executor?: CommandExecutor }): Record<string, unknown>;
export function checkPermissions(artifactRoot: string): Promise<string[]>;
export function runQualificationGates(args: {
  artifactRoot: string;
  tarballPath?: string;
  tarballSha256?: string;
  artifactDigest: string;
  filename: string;
  releaseManifest?: Record<string, unknown>;
  publicKeyPem?: string;
  channel: string;
  target: string;
  host?: { platform: string; arch: string; os: string };
  executor?: CommandExecutor;
  macTools?: { codesign?: string; stapler?: string };
  controlPlaneHome?: string;
  repoRoot?: string;
  verifyLocalAcquisitionImpl?: (options: {
    metadataDirectory: string;
    tarballPath: string;
    channel: "beta" | "stable";
    target: string;
    publicKeyPem?: string;
    now?: string;
    highestObservedVersion?: number;
  }) => Promise<{ version: string; artifactDigest: string }>;
}): Promise<{
  qualifiedBytes: { filename: string; sha256: string | undefined; artifactDigest: string };
  target: string;
  channel: string;
  gates: QualificationGateResult[];
  result: string;
  host: { platform: string; arch: string; os: string };
}>;
export function deriveQualificationResult(gates: QualificationGateResult[]): "qualified" | "experimental-gaps" | "not-qualified";
export function hostCanExecute(target: string, host?: { platform: string; arch: string }): boolean;
export function qualificationBlocksStable(qualification: unknown, args?: { requireResult?: boolean }): string[];
export function serializeQualification(args: {
  qualifiedBytes: { filename: string; sha256?: string; artifactDigest: string };
  target: string;
  channel: string;
  gates: QualificationGateResult[];
  result: string;
  host: { platform: string; arch: string; os: string };
  releaseVersion: string;
}): QualificationDocument;

export function runVerifiedInstallGate(args: {
  artifactRoot: string;
  tarballPath?: string;
  tarballSha256?: string;
  artifactDigest?: string;
  filename?: string;
  channel: string;
  target?: string;
  releaseManifest?: Record<string, unknown>;
  publicKeyPem?: string;
  repoRoot?: string;
  verifyLocalAcquisitionImpl?: (options: {
    metadataDirectory: string;
    tarballPath: string;
    channel: "beta" | "stable";
    target: string;
    publicKeyPem?: string;
    now?: string;
    highestObservedVersion?: number;
    now?: string;
    highestObservedVersion?: number;
  }) => Promise<{ version: string; artifactDigest: string }>;
}): Promise<QualificationGateResult>;
