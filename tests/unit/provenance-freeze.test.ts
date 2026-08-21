import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

type Artifact = {
  id: string;
  sha256: string;
  license: string;
  copyright: string;
  copyAllowed: boolean;
  researchCorrespondence?: string;
  packageGitHead?: string;
};

type Classification = "copied" | "adapted" | "oracle-only" | "rejected";

type MatrixRow = {
  id: string;
  artifactId: string;
  sourceModule: string;
  destination: string;
  classification: Classification;
  verificationOwner: string;
  license: string;
  kernelReview: string;
};

type Matrix = {
  rejectedPatterns: Array<{ id: string }>;
  rows: MatrixRow[];
};

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(root, relative), "utf8"));
}

describe("source provenance freeze", () => {
  const artifactsDoc = readJson("provenance/artifacts.json") as { artifacts: Artifact[] };
  const matrix = readJson("provenance/adaptation-matrix.json") as Matrix;
  const artifacts = new Map(artifactsDoc.artifacts.map((artifact) => [artifact.id, artifact]));

  it("pins a sha256, license, and copyright for every artifact", () => {
    expect(artifactsDoc.artifacts.length).toBeGreaterThanOrEqual(5);
    for (const artifact of artifactsDoc.artifacts) {
      expect(artifact.id).toMatch(/^[a-z0-9.-]+$/);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.license).toBe("MIT");
      expect(artifact.copyright.length).toBeGreaterThan(10);
    }
  });

  it("records research/package mismatch instead of treating later main as the package", () => {
    const ccs = artifacts.get("ccs-8.9.0");
    const opencodex = artifacts.get("opencodex-2.11.1");
    expect(ccs?.researchCorrespondence).toBe("mismatch-later-main");
    expect(ccs?.packageGitHead).toBe("f8a9518b1799fc034249fd4e4e39f5aa2c81186c");
    expect(opencodex?.researchCorrespondence).toBe("mismatch-later-main");
    expect(opencodex?.packageGitHead).toBe("121f1ad929dc6da3356c06f5192f2f97f7a5dde5");
  });

  it("requires every matrix row to name source, destination, class, owner, and license", () => {
    expect(matrix.rows.length).toBeGreaterThanOrEqual(20);
    for (const row of matrix.rows) {
      expect(row.id).toBeTruthy();
      expect(artifacts.has(row.artifactId), row.artifactId).toBe(true);
      expect(row.sourceModule.length).toBeGreaterThan(3);
      expect(row.destination.length).toBeGreaterThan(3);
      expect(["copied", "adapted", "oracle-only", "rejected"]).toContain(row.classification);
      expect(row.verificationOwner).toBeTruthy();
      expect(row.license.length).toBeGreaterThan(2);
      expect(row.kernelReview.length).toBeGreaterThan(10);
    }
  });

  it("blocks copy of CLIProxy binaries and dirty source trees", () => {
    expect(artifacts.get("cliproxy-plus-7.2.127-3")?.copyAllowed).toBe(false);
    expect(artifacts.get("cliproxy-api-7.2.129")?.copyAllowed).toBe(false);
    const plusRows = matrix.rows.filter((row) => row.artifactId.startsWith("cliproxy-"));
    expect(plusRows.length).toBeGreaterThan(0);
    for (const row of plusRows) {
      expect(["oracle-only", "rejected"]).toContain(row.classification);
    }
  });

  it("allows adapted rows only from copy-allowed MIT artifacts", () => {
    const reused = matrix.rows.filter(
      (row) => row.classification === "adapted" || row.classification === "copied",
    );
    for (const row of reused) {
      const artifact = artifacts.get(row.artifactId);
      expect(artifact, row.id).toBeDefined();
      expect(artifact?.copyAllowed, row.id).toBe(true);
      expect(artifact?.license).toBe("MIT");
    }
    expect(matrix.rows.some((row) => row.classification === "copied")).toBe(false);
  });

  it("records the four rejected patterns", () => {
    const ids = matrix.rejectedPatterns.map((pattern) => pattern.id);
    expect(ids).toEqual(expect.arrayContaining([
      "kill-by-port",
      "silent-import",
      "default-shared-store-writes",
      "post-output-retry",
    ]));
  });
});
