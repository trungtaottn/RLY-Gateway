// Type declarations for scripts/release/sbom.mjs (SBOM generation, #128).

export type SbomPackage = {
  name: string;
  version: string;
  supplier?: string;
  licenseConcluded: string;
  homepage?: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
};

export type Sbom = {
  sbomSchemaVersion: 1;
  spec: string;
  dataLicense: string;
  documentNamespace: string;
  documentDescribes: string;
  artifactRef: { filename: string; sha256: string; artifactDigest: string };
  releaseRef: { releaseVersion: string; releaseChannel: string; target: string; sourceDateEpoch: number };
  packages: SbomPackage[];
  relationships: Array<{ spdxElementId: string; relationshipType: string; relatedSpdxElement: string }>;
  componentCount: number;
  digestInputs: string[];
};

export const SBOM_SCHEMA_VERSION: 1;
export const SBOM_SPEC: string;
export const SBOM_DATA_LICENSE: string;

export function collectThirdPartyPackages(artifactRoot: string): Promise<SbomPackage[]>;
export function buildSbomForArtifact(
  artifactRoot: string,
  args: {
    filename: string;
    sha256: string;
    artifactDigest: string;
    releaseVersion: string;
    releaseChannel: string;
    target: string;
    sourceDateEpoch: number;
  },
): Promise<Sbom>;
export function spdxId(name: string): string;
export function validateSbom(sbom: unknown): string[];
export function verifySbomArtifactRef(sbom: Sbom, expectedRef: { filename: string; sha256: string; artifactDigest: string }): string[];
