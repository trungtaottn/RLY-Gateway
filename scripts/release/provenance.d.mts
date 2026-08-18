// Type declarations for scripts/release/provenance.mjs (build provenance, #128).

export type ProvenanceSubject = {
  name: string;
  digest: { sha256: string; rlyArtifactDigest: string };
};

export type Provenance = {
  provenanceSchemaVersion: 1;
  predicateType: string;
  releaseRef: {
    releaseVersion: string;
    releaseChannel: string;
    sourceCommit: string;
    buildId: string;
    sourceDateEpoch: number;
  };
  subject: ProvenanceSubject[];
  predicate: {
    builder: { id: string };
    buildType: string;
    invocation: {
      configSource: { uri: string; digest: { gitCommit: string } };
      parameters: Record<string, unknown>;
      environment: Record<string, unknown>;
    };
    materials: Array<{ uri: string; digest: { gitCommit: string } }>;
    metadata: { buildInvocationId: string; completionTimestamp: string; reproducible: boolean };
  };
};

export const PROVENANCE_SCHEMA_VERSION: 1;
export const PROVENANCE_PREDICATE_TYPE: string;
export const PROVENANCE_REPOSITORY_URI: string;

export function buildProvenance(args: {
  releaseVersion: string;
  releaseChannel: string;
  sourceCommit: string;
  buildId: string;
  workflow?: { name?: string; runId?: string; workflowSha?: string };
  toolchain?: { os?: string; node?: string; pnpm?: string };
  inputs?: Record<string, unknown>;
  artifacts: Array<{ name: string; sha256: string; artifactDigest: string }>;
  builder?: string;
  buildType?: string;
  reproducible?: boolean;
  completionTimestamp: string;
  sourceDateEpoch?: number;
}): Provenance;
export function validateProvenance(provenance: unknown): string[];
export function verifyProvenanceSubjects(provenance: Provenance, expectedSubjects: Array<{ name: string; sha256: string; artifactDigest: string }>): string[];
