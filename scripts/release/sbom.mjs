#!/usr/bin/env node
// RLY SBOM generation (#128).
//
// Generates a software bill of materials for each production artifact from
// the ACTUAL packaged bytes (the unpacked standalone artifact tree), NOT from
// the workspace or a rebuilt equivalent. The SBOM references the EXACT
// artifact digest (`artifactRef`): filename + tarball sha256 + content
// addressed tree digest, so evidence is always attached to the exact bytes
// that were packaged and later qualified/published.
//
// The SBOM is a sibling release asset (never embedded in the artifact): an
// embedded SBOM would change the tree digest it describes (self-reference
// loop), and separating metadata from artifacts is the TUF-style discipline
// this track applies to every evidence file.
//
// Deterministic: sorted component lists, stable document namespace derived
// from the artifact identity. No credentials, tokens, prompts, responses, or
// user content ever enter this module or its outputs.

import { createHash } from "node:crypto";
import { readFile, readdir, lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

export const SBOM_SCHEMA_VERSION = 1;
export const SBOM_SPEC = "SPDX-2.3";
export const SBOM_DATA_LICENSE = "CC0-1.0";

/** Deterministic path ordering. */
function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function walkTree(root, relativePrefix = "") {
  const entries = [];
  const names = (await readdir(join(root, relativePrefix))).sort(comparePath);
  for (const name of names) {
    const path = relativePrefix ? `${relativePrefix}/${name}` : name;
    const details = await lstat(join(root, relativePrefix, name));
    if (details.isSymbolicLink()) {
      entries.push({ path, type: "symlink", target: await readlink(join(root, relativePrefix, name)) });
    } else if (details.isDirectory()) {
      entries.push({ path, type: "dir" });
      entries.push(...await walkTree(root, path));
    } else if (details.isFile()) {
      entries.push({ path, type: "file" });
    } else {
      entries.push({ path, type: "special" });
    }
  }
  return entries;
}

/**
 * Collects third-party packages from the packaged `node_modules` tree by
 * reading each real `package.json` (symlink targets resolve through the
 * virtual store). Dedupes by `name@version`, deterministic order. Only
 * public package metadata (name/version/license) is collected — never
 * content, credentials, or local state.
 */
export async function collectThirdPartyPackages(artifactRoot) {
  const packages = new Map();
  const entries = await walkTree(artifactRoot);
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (!/^node_modules\/.*\/package\.json$/.test(entry.path)) continue;
    if (/(^|\/)(\.bin|tests|__tests__)(\/|$)/.test(entry.path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(artifactRoot, entry.path), "utf8"));
    } catch {
      continue; // unreadable/non-JSON package.json — not a component we can identify
    }
    if (typeof parsed?.name !== "string" || typeof parsed?.version !== "string") continue;
    if (parsed.private === true) continue; // workspace internals are not shipped deps
    const key = `${parsed.name}@${parsed.version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        name: parsed.name,
        version: parsed.version,
        licenseConcluded: typeof parsed.license === "string" ? parsed.license : "NOASSERTION",
        homepage: typeof parsed.homepage === "string" ? parsed.homepage : undefined,
      });
    }
  }
  return [...packages.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : 1,
  );
}

function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Builds the SBOM document for one artifact from its unpacked tree plus the
 * exact artifact identity. `artifactRef` = { filename, sha256, artifactDigest }.
 */
export async function buildSbomForArtifact(artifactRoot, {
  filename,
  sha256,
  artifactDigest,
  releaseVersion,
  releaseChannel,
  target,
  sourceDateEpoch,
}) {
  const artifactMetadata = await readArtifactMetadata(artifactRoot);
  const bundledNodeVersion =
    artifactMetadata?.bundledNodeVersion ??
    (await readPackageJson(artifactRoot))?.engines?.node ??
    "unknown";
  const thirdParty = await collectThirdPartyPackages(artifactRoot);

  const documentNamespace = sha256Of(
    `rly-sbom:${releaseVersion}:${target}:${artifactDigest}`,
  );
  const packages = [
    {
      name: "rly-gateway",
      version: releaseVersion,
      supplier: "Organization: RLY Gateway",
      licenseConcluded: "MIT",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
    },
    {
      name: "node",
      version: bundledNodeVersion,
      supplier: "Organization: Node.js Foundation",
      licenseConcluded: "MIT",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
    },
    ...thirdParty,
  ].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : 1,
  );

  const relationships = packages.slice(1).map((component) => ({
    spdxElementId: "SPDXRef-Package-rly-gateway",
    relationshipType: "CONTAINS",
    relatedSpdxElement: `SPDXRef-Package-${spdxId(component.name)}`,
  }));

  return {
    sbomSchemaVersion: SBOM_SCHEMA_VERSION,
    spec: SBOM_SPEC,
    dataLicense: SBOM_DATA_LICENSE,
    documentNamespace: `https://rly-gateway.dev/sbom/${documentNamespace}`,
    documentDescribes: "SPDXRef-Package-rly-gateway",
    artifactRef: {
      filename,
      sha256,
      artifactDigest,
    },
    releaseRef: {
      releaseVersion,
      releaseChannel,
      target,
      sourceDateEpoch,
    },
    packages,
    relationships,
    componentCount: packages.length,
    digestInputs: [
      "artifact-tree-bytes",
      "bundled-node-version",
      "node_modules-package.json-metadata",
      "rly-artifact.json-bundledNodeVersion",
    ],
  };
}

/** Deterministic SPDX element id for a package name. */
export function spdxId(name) {
  const sanitized = String(name).replace(/[^A-Za-z0-9.-]/g, "-");
  return sanitized.length === 0 ? "unknown" : sanitized;
}

async function readPackageJson(artifactRoot) {
  try {
    return JSON.parse(await readFile(join(artifactRoot, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function readArtifactMetadata(artifactRoot) {
  try {
    return JSON.parse(await readFile(join(artifactRoot, "rly-artifact.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Validates the SBOM shape. Returns sorted errors; empty = valid. */
export function validateSbom(sbom) {
  const errors = [];
  if (sbom === undefined || sbom === null || typeof sbom !== "object") return ["SBOM is not an object"];
  if (sbom.sbomSchemaVersion !== SBOM_SCHEMA_VERSION) errors.push(`sbomSchemaVersion ${sbom.sbomSchemaVersion ?? "(missing)"} != ${SBOM_SCHEMA_VERSION}`);
  if (sbom.spec !== SBOM_SPEC) errors.push(`spec ${sbom.spec ?? "(missing)"} != ${SBOM_SPEC}`);
  if (sbom.artifactRef === undefined || typeof sbom.artifactRef !== "object") {
    errors.push("artifactRef missing (SBOM must reference the exact artifact digest)");
  } else {
    if (typeof sbom.artifactRef.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sbom.artifactRef.sha256)) errors.push("artifactRef.sha256 invalid");
    if (typeof sbom.artifactRef.artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(sbom.artifactRef.artifactDigest)) errors.push("artifactRef.artifactDigest invalid");
  }
  if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) errors.push("packages must be a non-empty list");
  const names = new Set();
  for (const component of sbom.packages ?? []) {
    if (typeof component?.name !== "string" || typeof component?.version !== "string") errors.push("component missing name/version");
    else {
      const key = `${component.name}@${component.version}`;
      if (names.has(key)) errors.push(`duplicate component ${key}`);
      names.add(key);
    }
  }
  return errors.sort();
}

/** Verifies the SBOM references the EXACT artifact digest expected. */
export function verifySbomArtifactRef(sbom, expectedRef) {
  const errors = [];
  if (sbom?.artifactRef?.sha256 !== expectedRef.sha256) {
    errors.push(`SBOM sha256 ${sbom?.artifactRef?.sha256 ?? "(missing)"} != expected ${expectedRef.sha256}`);
  }
  if (sbom?.artifactRef?.artifactDigest !== expectedRef.artifactDigest) {
    errors.push(`SBOM artifactDigest ${sbom?.artifactRef?.artifactDigest ?? "(missing)"} != expected ${expectedRef.artifactDigest}`);
  }
  if (sbom?.artifactRef?.filename !== expectedRef.filename) {
    errors.push(`SBOM filename ${sbom?.artifactRef?.filename ?? "(missing)"} != expected ${expectedRef.filename}`);
  }
  return errors;
}
