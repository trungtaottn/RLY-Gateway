import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { buildChannelMetadata } from "../../scripts/release/channel.mjs";
import { buildReleaseManifest } from "../../scripts/release/manifest.mjs";
import { generateSigningKeyPair, signDigestStatement, signJson } from "../../scripts/release/signing.mjs";
import { treeDigest, sha256Of } from "../../scripts/standalone/pack.mjs";

/**
 * Hermetic signed-release fixture (#129). Builds a realistic signed release
 * lineage with the PUBLISHER-side code (`scripts/release/*`): a fake but
 * structurally-complete standalone artifact tree + deterministic tarball, the
 * canonical release manifest, signed channel metadata (beta/stable), per-
 * artifact Ed25519 signatures, and sha256 — all written to a fixture release
 * directory. The acquisition code under test must verify this lineage with
 * the TS verifier and never trust it implicitly.
 */

export type ReleaseFixture = Readonly<{
  publicKeyPem: string;
  privateKeyPem: string;
  releaseDir: string;
  version: string;
  sourceCommit: string;
  buildId: string;
  channel: "beta" | "stable";
  filename: string;
  tarballPath: string;
  sha256: string;
  artifactDigest: string;
  sizeBytes: number;
  channelMetadataVersion: number;
  publishedAt: string;
  manifest: ReturnType<typeof buildReleaseManifest>;
  channelMetadata: ReturnType<typeof buildChannelMetadata>;
}>;

export type FixtureOptions = Readonly<{
  releaseDir: string;
  version?: string;
  channel?: "beta" | "stable";
  channelVersion?: number;
  publishedAt?: string;
  targetStatus?: "supported" | "experimental";
  qualificationStatus?: "qualified" | "experimental-gaps" | "not-qualified";
  target?: string;
  /** When true the channel metadata snapshot carries no matching release. */
  unknownSnapshot?: boolean;
  freeze?: boolean;
}>;

export async function buildReleaseFixture(options: FixtureOptions): Promise<ReleaseFixture> {
  const version = options.version ?? "1.0.0-beta.5";
  const channel = options.channel ?? "beta";
  const target = options.target ?? "linux-x64";
  const publishedAt = options.publishedAt ?? "2026-08-20T00:00:00.000Z";
  const sourceCommit = "a".repeat(40);
  const buildId = `build-${version}`;
  const keypair = generateSigningKeyPair();
  const publicKeyPem = keypair.publicKey;
  const privateKeyPem = keypair.privateKey;

  // Fake standalone artifact tree (structurally complete for #92/#94/#35).
  const artifactDir = join(options.releaseDir, "artifact");
  await mkdir(join(artifactDir, "dist", "cli"), { recursive: true, mode: 0o700 });
  await writeFile(join(artifactDir, "dist", "cli", "main.js"), "// rly fixture dispatcher\n", "utf8");
  await writeFile(join(artifactDir, "dist", "rly-build.json"), `${JSON.stringify({
    identitySchemaVersion: 1,
    product: "rly-gateway",
    semanticVersion: version,
    commitRevision: sourceCommit,
    buildId,
    releaseChannel: channel,
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    stateSchemaVersion: 2,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "package.json"), `${JSON.stringify({ name: "rly-gateway", version }, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "LICENSE"), "MIT\n", "utf8");
  await writeFile(join(artifactDir, "rly.json"), `${JSON.stringify({
    product: "rly-gateway",
    version,
    stateVersion: 2,
    migrationClass: "backward-compatible-expand",
    buildId,
    commitRevision: sourceCommit,
    releaseChannel: channel,
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "rly-build.json"), `${JSON.stringify({
    identitySchemaVersion: 1,
    product: "rly-gateway",
    semanticVersion: version,
    commitRevision: sourceCommit,
    buildId,
    releaseChannel: channel,
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    stateSchemaVersion: 2,
  }, null, 2)}\n`, "utf8");
  await mkdir(join(artifactDir, "docs"), { recursive: true, mode: 0o700 });
  await writeFile(join(artifactDir, "docs", "third-party-notices.md"), "notices\n", "utf8");

  const artifactDigest = await treeDigest(artifactDir, { exclude: ["rly-artifact.json"] });
  await writeFile(join(artifactDir, "rly-artifact.json"), `${JSON.stringify({
    artifactSchemaVersion: 1,
    product: "rly-gateway",
    semanticVersion: version,
    commitRevision: sourceCommit,
    buildId,
    releaseChannel: channel,
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    stateSchemaVersion: 2,
    targetPlatform: target,
    targetStatus: options.targetStatus ?? "supported",
    artifactDigest,
    fileCount: 6,
  }, null, 2)}\n`, "utf8");
  const filename = `rly-${version}-${target}.tar.gz`;
  const tarballPath = join(options.releaseDir, filename);
  execFileSync("tar", ["-czf", tarballPath, "-C", artifactDir, "."], { stdio: "ignore" });
  const tarballBytes = await readFile(tarballPath);
  const sha256 = sha256Of(tarballBytes);
  await writeFile(`${tarballPath}.sha256`, `${sha256}  ${filename}\n`, "utf8");
  await writeFile(`${tarballPath}.sig`, `${JSON.stringify(signDigestStatement(privateKeyPem, sha256), null, 2)}\n`, "utf8");

  const manifest = buildReleaseManifest({
    releaseVersion: version,
    releaseChannel: channel,
    sourceCommit,
    buildId,
    stateSchemaVersion: 2,
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    publishedAt,
    workflow: { name: "fixture" },
    artifacts: [
      {
        target,
        filename,
        sizeBytes: tarballBytes.byteLength,
        sha256,
        artifactDigest,
        targetStatus: options.targetStatus ?? "supported",
        bundledNodeVersion: "24.0.0",
        requiredSignatures: ["ed25519-sha256"],
        attestations: ["rly-sbom.json", "rly-provenance.json"],
      },
    ],
  });
  await writeFile(join(options.releaseDir, "rly-release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(options.releaseDir, "rly-release.json.sig"), `${JSON.stringify(signJson(privateKeyPem, manifest), null, 2)}\n`, "utf8");

  const channelVersion = options.channelVersion ?? 1;
  const snapshotReleaseVersion = options.unknownSnapshot === true ? "1.0.0-beta.4" : version;
  const channelMetadata = buildChannelMetadata({
    channel,
    releaseVersion: snapshotReleaseVersion,
    sourceCommit,
    buildId,
    publishedAt,
    artifactDigests: { [target]: { filename, sha256, artifactDigest, targetStatus: options.targetStatus ?? "supported" } },
    qualification: { status: options.qualificationStatus ?? "qualified", ref: "rly-qualification.json" },
    previousHighestVersion: channelVersion - 1,
    freeze: options.freeze === true ? { frozen: true, reason: "fixture freeze" } : { frozen: false },
    updatedAt: publishedAt,
  });
  await writeFile(join(options.releaseDir, `rly-channel-${channel}.json`), `${JSON.stringify(channelMetadata, null, 2)}\n`, "utf8");
  await writeFile(join(options.releaseDir, `rly-channel-${channel}.json.sig`), `${JSON.stringify(signJson(privateKeyPem, channelMetadata), null, 2)}\n`, "utf8");

  return {
    publicKeyPem,
    privateKeyPem,
    releaseDir: options.releaseDir,
    version,
    sourceCommit,
    buildId,
    channel,
    filename,
    tarballPath,
    sha256,
    artifactDigest,
    sizeBytes: tarballBytes.byteLength,
    channelMetadataVersion: channelMetadata.version,
    publishedAt,
    manifest,
    channelMetadata,
  };
}

/** Reads a file as a Uint8Array (fixture serving). */
export async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Mock fetch serving the fixture as a GitHub API + release-asset origin. Any
 * URL shape used by the acquisition code resolves to the fixture files.
 */
export function fixtureFetch(fixture: ReleaseFixture, options: Readonly<{ tamperTarball?: boolean; omitSignature?: boolean; wrongKey?: boolean }> = {}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const { releaseDir, version, filename } = fixture;
  const tag = `v${version}`;
  const releaseList = JSON.stringify([
    { tag_name: tag, draft: false, prerelease: fixture.channel === "beta" },
  ]);
  const serve = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    if (path.endsWith("/releases")) {
      return new Response(releaseList, { status: 200, headers: { "content-type": "application/json" } });
    }
    const prefix = `/releases/download/${tag}/`;
    const marker = path.indexOf(prefix);
    if (marker < 0) return new Response("not found", { status: 404 });
    const asset = path.slice(marker + prefix.length);
    if (asset === filename) {
      const bytes = await readBytes(join(releaseDir, filename));
      if (options.tamperTarball === true) {
        const tampered = new Uint8Array(bytes.byteLength + 1);
        tampered.set(bytes);
        tampered[0] = tampered[0] === 0 ? 1 : 0;
        return new Response(tampered, { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }
    if (asset === `${filename}.sig`) {
      if (options.omitSignature === true) return new Response("not found", { status: 404 });
      const bytes = await readBytes(join(releaseDir, `${filename}.sig`));
      return new Response(bytes, { status: 200 });
    }
    // Channel/manifest metadata is served by basename regardless of the tag
    // (the acquisition code never trusts the tag; signature + evaluation is
    // the authority).
    if (asset.endsWith(".json") || asset.endsWith(".json.sig")) {
      const local = join(releaseDir, basename(asset));
      const bytes = await readFile(local).catch(() => undefined);
      if (bytes === undefined) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return serve;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
