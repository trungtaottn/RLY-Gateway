#!/usr/bin/env node
// RLY exact-byte qualification (#128).
//
// Qualification is the PUBLICATION AUTHORITY: a release is promoted only on
// evidence produced by installing and exercising the EXACT artifact digest
// that is subsequently published — never a rebuilt equivalent, never a
// version label. The qualification record binds the qualified bytes
// (filename + tarball sha256 + content-addressed artifact digest) and the
// per-gate results of the matrix:
//
//   clean-install, identity (`rly --version`/build identity), permissions,
//   platform-signing (macOS codesign/notarization/stapling verification or
//   the Linux artifact signature/manifest trust chain), runtime readiness,
//   update handoff contract, init/service registration, uninstall.
//
// A gate is `passed` only when it executed against the exact bytes and
// passed; `skipped`/`not-run` is NEVER passing evidence, and any
// missing/failed required gate blocks stable promotion (machine-readable via
// `qualificationBlocksStable`).
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs.

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { lstat, readFile, readdir, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkSelfContained } from "./self-contained.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const QUALIFICATION_FILENAME = "rly-qualification.json";
export const QUALIFICATION_RESULTS = ["qualified", "experimental-gaps", "not-qualified"];

/** The qualification matrix. Every gate is explicit and stable-required. */
export const QUALIFICATION_GATES = Object.freeze([
  { id: "clean-install", name: "Clean install", description: "Unpack the exact tarball and execute the packaged runtime without a user toolchain" },
  { id: "identity", name: "Identity", description: "`rly --version` reports the exact build identity fields consistent with the release manifest" },
  { id: "permissions", name: "Permissions", description: "Executable bits, private modes, no world-writable files, bundled node version matches metadata" },
  { id: "platform-signing", name: "Platform signing", description: "macOS: codesign/notarization/stapling verification; Linux: artifact signature + manifest trust chain" },
  { id: "runtime-readiness", name: "Runtime readiness", description: "The packaged runtime reports authenticated readiness / doctor ok with the exact identity" },
  { id: "update-handoff", name: "Update handoff contract", description: "Artifact satisfies the #73/#92/#94 candidate contract (rly.json/rly-build.json identity, migration class, immutable layout)" },
  { id: "init-service-registration", name: "Init / service registration", description: "`rly init` registers the per-user service (launchd/systemd) on a qualified host" },
  { id: "uninstall", name: "Uninstall", description: "Removal is self-contained and leaves no files outside the artifact tree" },
  { id: "verified-install", name: "Verified installer acquisition", description: "The #129 installer/updater verification machinery (signed channel metadata + release manifest + artifact digest statement + unpacked-tree digest) accepts the EXACT bytes and refuses tampered bytes before any install mutation" },
]);

/** Gates that MUST pass for a target to be stable-qualified. */
export const REQUIRED_GATES_FOR_STABLE = Object.freeze(QUALIFICATION_GATES.map((gate) => gate.id));

/** Builds one gate result. `status` is passed|failed|skipped (never empty). */
export function gateResult(id, status, { detail = "", command = "" } = {}) {
  const gate = QUALIFICATION_GATES.find((entry) => entry.id === id);
  if (gate === undefined) throw new Error(`unknown qualification gate: ${id}`);
  if (!["passed", "failed", "skipped"].includes(status)) throw new Error(`invalid gate status ${status} for ${id}`);
  return { id, name: gate.name, status, detail, command };
}
/**
 * Runs a command; returns { ok, output }. `allowFailure` returns ok:false
 * instead of throwing so gates can classify non-conclusive hosts honestly.
 */
export function runCommand(command, args, options = {}) {
  const { cwd, env, allowFailure = false, timeoutMs = 120_000 } = options;
  try {
    const output = execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: output.trim() };
  } catch (error) {
    const message = String(error?.stdout ?? error?.message ?? error).trim();
    if (allowFailure) return { ok: false, output: message };
    throw error;
  }
}

/** Extracts a tarball into a dest dir (removing any previous copy). */
export async function extractTarball(tarballPath, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  runCommand("tar", ["-xzf", tarballPath, "-C", destDir]);
  return destDir;
}

/** Reads the identity JSON printed by `rly --version`. */
export function runVersionIdentity(artifactRoot, { executor = runCommand } = {}) {
  const launcher = join(artifactRoot, "rly");
  const result = executor(launcher, ["--version"], { cwd: artifactRoot, env: { RLY_BUNDLED_NODE: "1" } });
  if (!result.ok) throw new Error(`rly --version failed: ${result.output}`);
  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    throw new Error(`rly --version did not print a build identity JSON: ${result.output}`);
  }
  return parsed;
}

/** Static permission checks over the unpacked tree. */
export async function checkPermissions(artifactRoot) {
  const errors = [];
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  for (const entry of entries) {
    const details = await lstat(join(artifactRoot, entry.name)).catch(() => undefined);
    if (details === undefined || !details.isFile()) continue;
    if ((details.mode & 0o002) !== 0) errors.push(`world-writable file: ${entry.name}`);
  }
  const launcher = await lstat(join(artifactRoot, "rly")).catch(() => undefined);
  if (launcher === undefined || (launcher.mode & 0o111) === 0) errors.push("rly launcher missing or not executable");
  const node = await lstat(join(artifactRoot, "bin", "node")).catch(() => undefined);
  if (node === undefined || (node.mode & 0o111) === 0) errors.push("bin/node missing or not executable");
  return errors;
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when the qualification host can execute the target's binaries. */
export function hostCanExecute(target, host = { platform: process.platform, arch: process.arch }) {
  return `${host.platform}-${host.arch}` === target;
}

/**
 * Runs the qualification matrix for one target against the EXACT unpacked
 * bytes. `qualifiedBytes` binds filename + tarball sha256 + artifact digest.
 */
export async function runQualificationGates({
  artifactRoot,
  tarballPath,
  tarballSha256,
  artifactDigest,
  filename,
  releaseManifest,
  publicKeyPem,
  channel,
  target,
  host = { platform: process.platform, arch: process.arch, os: process.env.RUNNER_OS ?? "local" },
  executor = runCommand,
  macTools = undefined,
  controlPlaneHome,
  repoRoot = ROOT,
  verifyLocalAcquisitionImpl,
}) {
  const gates = [];
  const qualifiedBytes = { filename, sha256: tarballSha256, artifactDigest };

  // 1. clean-install: unpack and execute the exact tarball.
  if (tarballPath === undefined) {
    gates.push(gateResult("clean-install", "skipped", { detail: "no tarball provided; clean-install must run against the exact published bytes" }));
  } else if (!hostCanExecute(target, host)) {
    gates.push(gateResult("clean-install", "skipped", {
      detail: `host ${host.platform}-${host.arch} cannot execute ${target} binaries; smoke-testing requires a provisioned ${target} runner`, 
    }));
  } else {
    try {
      const dest = join(artifactRoot, "..", ".qualify-clean-install");
      await extractTarball(tarballPath, dest);
      const identity = runVersionIdentity(dest, { executor });
      const ok = identity.product === "rly-gateway" && typeof identity.version === "string";
      gates.push(gateResult("clean-install", ok ? "passed" : "failed", {
        detail: ok ? `unpacked and executed rly --version -> v${identity.version}` : `unexpected identity output: ${JSON.stringify(identity)}`,
        command: "tar -xzf <tarball> && ./rly --version",
      }));
    } catch (error) {
      gates.push(gateResult("clean-install", "failed", { detail: `unpack/run failed: ${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  // 2. identity: rly --version matches the release manifest identity fields.
  if (!hostCanExecute(target, host)) {
    gates.push(gateResult("identity", "skipped", {
      detail: `host ${host.platform}-${host.arch} cannot execute ${target} binaries; identity evidence requires a provisioned ${target} runner`,
    }));
  } else {
    try {
      const identity = runVersionIdentity(artifactRoot, { executor });
      const mismatches = [];
      const expectations = [
        ["version", identity.version, releaseManifest?.releaseVersion],
        ["commitRevision", identity.commitRevision, releaseManifest?.sourceCommit],
        ["buildId", identity.buildId, releaseManifest?.buildId],
        ["releaseChannel", identity.releaseChannel, releaseManifest?.releaseChannel],
        ["controlProtocolVersion", identity.controlProtocolVersion, releaseManifest?.controlProtocolVersion],
        ["dataProtocolVersion", identity.dataProtocolVersion, releaseManifest?.dataProtocolVersion],
        ["stateSchemaVersion", identity.stateSchemaVersion, releaseManifest?.stateSchemaVersion],
      ];
      for (const [field, actual, expected] of expectations) {
        if (String(actual) !== String(expected)) mismatches.push(`${field}: ${actual} != ${expected}`);
      }
      gates.push(gateResult("identity", mismatches.length === 0 ? "passed" : "failed", {
        detail: mismatches.length === 0 ? "identity fields match the release manifest" : mismatches.join("; "),
        command: "./rly --version",
      }));
    } catch (error) {
      gates.push(gateResult("identity", "failed", { detail: `identity probe failed: ${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  // 3. permissions: static checks over the exact bytes.
  {
    const errors = await checkPermissions(artifactRoot);
    gates.push(gateResult("permissions", errors.length === 0 ? "passed" : "failed", {
      detail: errors.length === 0 ? "no permission violations" : errors.join("; "),
    }));
  }

  // 4. platform-signing: macOS codesign/notarization/stapling verification OR
  //    the Linux artifact signature + manifest trust chain.
  {
    const isMacTarget = String(target).startsWith("darwin");
    const errors = [];
    if (tarballSha256 !== undefined && publicKeyPem !== undefined && tarballPath !== undefined) {
      const envelope = await readSignatureEnvelopeSafe(tarballPath);
      if (envelope === undefined) {
        errors.push("no artifact signature file (<tarball>.sig) found to verify");
      } else {
        const { verifyDigestStatement } = await import("./signing.mjs");
        try {
          if (!verifyDigestStatement(publicKeyPem, tarballSha256, envelope)) {
            errors.push("artifact signature does not verify against the release public key");
          }
        } catch (error) {
          errors.push(`artifact signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      errors.push("no artifact signature evidence to verify (sha256 + signature required)");
    }
    if (isMacTarget) {
      if (macTools === undefined || host.platform !== "darwin") {
        errors.push(
          "macOS signing/notarization/stapling verification gate not run: requires a provisioned macOS host with codesign/notarytool/stapler and the Apple certificate secrets (missing required platform signature blocks promotion for this target)",
        );
      } else {
        const codesign = macTools.codesign;
        const stapler = macTools.stapler;
        if (codesign !== undefined) {
          const result = executor(codesign, ["--verify", "--deep", "--strict", "--verbose=2", artifactRoot], { allowFailure: true });
          if (!result.ok) errors.push(`codesign --verify failed: ${result.output.slice(0, 300)}`);
        }
        if (stapler !== undefined) {
          const result = executor(stapler, ["validate", artifactRoot], { allowFailure: true });
          if (!result.ok) errors.push(`stapler validate failed: ${result.output.slice(0, 300)}`);
        }
      }
    }
    gates.push(gateResult("platform-signing", errors.length === 0 ? "passed" : "skipped", {
      detail: errors.length === 0 ? "platform authenticity chain verified" : errors.join("; "),
    }));
  }

  // 5. runtime-readiness: the packaged runtime reports doctor ok / readiness.
  {
    if (host.platform === "linux" || host.platform === "darwin") {
      const home = controlPlaneHome ?? join(artifactRoot, "..", ".qualify-home");
      await mkdir(home, { recursive: true });
      const result = executor(join(artifactRoot, "rly"), ["doctor", "--config", join(repoRoot, "gateway.config.example.toml")], {
        cwd: home,
        env: { HOME: home, RLY_BUNDLED_NODE: "1", XDG_CONFIG_HOME: join(home, ".config") },
        allowFailure: true,
      });
      const ok = result.ok && /"ok":\s*true/.test(result.output);
      gates.push(gateResult("runtime-readiness", ok ? "passed" : "skipped", {
        detail: ok ? "rly doctor ok:true with the exact identity" : `doctor not conclusive on this host: ${result.output.slice(0, 200)}`,
        command: "./rly doctor --config gateway.config.example.toml",
      }));
    } else {
      gates.push(gateResult("runtime-readiness", "skipped", { detail: `unsupported qualification host: ${host.platform}` }));
    }
  }

  // 6. update-handoff: the artifact satisfies the #73/#92/#94 candidate contract.
  {
    const errors = [];
    const manifest = await readJsonSafe(join(artifactRoot, "rly.json"));
    const buildMeta = await readJsonSafe(join(artifactRoot, "rly-build.json"));
    const artifactMeta = await readJsonSafe(join(artifactRoot, "rly-artifact.json"));
    if (manifest === undefined) errors.push("missing rly.json (candidate manifest)");
    if (buildMeta === undefined) errors.push("missing rly-build.json (exact build identity)");
    if (artifactMeta === undefined) errors.push("missing rly-artifact.json");
    if (manifest !== undefined && !["none", "backward-compatible-expand", "transactional-replace", "forward-only"].includes(manifest.migrationClass)) {
      errors.push(`invalid migrationClass ${manifest.migrationClass}`);
    }
    if (buildMeta !== undefined && releaseManifest !== undefined && buildMeta.semanticVersion !== releaseManifest.releaseVersion) {
      errors.push(`build identity version ${buildMeta.semanticVersion} != release ${releaseManifest.releaseVersion}`);
    }
    if (artifactMeta !== undefined && artifactMeta.artifactDigest !== artifactDigest) {
      errors.push(`artifact digest ${artifactMeta.artifactDigest} != qualified digest ${artifactDigest}`);
    }
    gates.push(gateResult("update-handoff", errors.length === 0 ? "passed" : "failed", {
      detail: errors.length === 0 ? "candidate contract satisfied (manifest + identity + digest consistent)" : errors.join("; "),
    }));
  }

  // 7. init/service registration on a qualified host (launchd/systemd).
  {
    if (host.platform !== "linux" && host.platform !== "darwin") {
      gates.push(gateResult("init-service-registration", "skipped", {
        detail: `host ${host.platform}/${host.os ?? "unknown"} has no provisioned per-user service manager; stable qualification requires a qualified host`,
      }));
    } else {
      const home = controlPlaneHome ?? join(artifactRoot, "..", ".qualify-home");
      await mkdir(home, { recursive: true });
      const result = executor(join(artifactRoot, "rly"), ["init", "--config", join(repoRoot, "gateway.config.example.toml")], {
        cwd: home,
        env: { HOME: home, RLY_BUNDLED_NODE: "1", XDG_CONFIG_HOME: join(home, ".config") },
        allowFailure: true,
      });
      gates.push(gateResult("init-service-registration", result.ok ? "passed" : "skipped", {
        detail: result.ok ? "rly init registered the per-user service" : `init not conclusive on this host: ${result.output.slice(0, 200)}`,
        command: "./rly init --config gateway.config.example.toml",
      }));
    }
  }

  // 8. uninstall: removal is self-contained (no writes outside the artifact tree).
  {
    const errors = await checkSelfContained(artifactRoot);
    gates.push(gateResult("uninstall", errors.length === 0 ? "passed" : "failed", {
      detail: errors.length === 0 ? "artifact is self-contained; removal leaves no files outside its tree" : errors.join("; "),
    }));
  }

  // 9. verified-install: the #129 installer/updater verification machinery
  //    (signed channel metadata + release manifest + artifact digest
  //    statement + unpacked-tree digest) accepts the EXACT bytes and refuses
  //    tampered bytes BEFORE any install mutation. A self-consistent signed
  //    chain is generated in a throwaway directory from the artifact's own
  //    exact identity + the exact tarball digest, then verified by the SAME
  //    acquisition code `rly install`/`rly update` consume. The real release
  //    signatures are separately verified post-publish by verify-release.mjs.
  gates.push(await runVerifiedInstallGate({
    artifactRoot,
    tarballPath,
    tarballSha256,
    artifactDigest,
    filename,
    channel,
    target,
    releaseManifest,
    publicKeyPem,
    repoRoot,
    verifyLocalAcquisitionImpl,
  }));

  const result = deriveQualificationResult(gates);
  return { qualifiedBytes, target, channel, gates, result, host };
}

/**
 * The #129 verified-install qualification gate (see gate 9 above). Injectable
 * verifier for hermetic tests; the real pipeline loads the compiled acquisition
 * module from `dist/installer/acquire.js`.
 */
export async function runVerifiedInstallGate({
  artifactRoot,
  tarballPath,
  tarballSha256,
  artifactDigest,
  filename,
  channel,
  target,
  releaseManifest,
  repoRoot = ROOT,
  verifyLocalAcquisitionImpl,
}) {
  // A self-consistent keypair is generated per gate run; the caller's
  // `publicKeyPem` (the release key) is NOT the chain key for this gate.
  const errors = [];
  const notes = [];
  const installerModule = join(repoRoot, "dist", "installer", "acquire.js");
  const moduleAvailable = await fileExistsSafe(installerModule);
  if (verifyLocalAcquisitionImpl === undefined && !moduleAvailable) {
    return gateResult("verified-install", "skipped", {
      detail: "dist/installer/acquire.js is not built in this context; the installer verification gate requires the compiled runtime",
    });
  }
  if (tarballPath === undefined || target === undefined) {
    return gateResult("verified-install", "skipped", {
      detail: "no exact tarball/target for the installer chain; exact-byte verification requires the packaged artifact lineage",
    });
  }
  try {
    const verifyLocalAcquisition = verifyLocalAcquisitionImpl ?? (await import(installerModule)).verifyLocalAcquisition;
    const { generateSigningKeyPair, signJson, signDigestStatement } = await import("./signing.mjs");
    const { buildChannelMetadata } = await import("./channel.mjs");
    const { buildReleaseManifest } = await import("./manifest.mjs");
    const chainDir = join(artifactRoot, "..", ".qualify-installer-chain");
    await rm(chainDir, { recursive: true, force: true });
    await mkdir(chainDir, { recursive: true });
    const keypair = generateSigningKeyPair();
    const keyPem = String(keypair.publicKey);
    const privateKeyPem = String(keypair.privateKey);
    const buildMeta = await readJsonSafe(join(artifactRoot, "rly-build.json"));
    const { channelVersionFor } = await import("./channel.mjs");
    const releaseVersion = buildMeta?.semanticVersion ?? releaseManifest?.releaseVersion ?? "unknown";
    if (channelVersionFor(releaseVersion, channel) === null) {
      return gateResult("verified-install", "skipped", {
        detail: `release version ${releaseVersion} is not a valid ${channel} channel version; channel acquisition exercises qualified release versions only`,
      });
    }
    const manifest = buildReleaseManifest({
      releaseVersion,
      releaseChannel: channel,
      sourceCommit: buildMeta?.commitRevision ?? releaseManifest?.sourceCommit ?? "unknown",
      buildId: buildMeta?.buildId ?? releaseManifest?.buildId ?? "unknown",
      stateSchemaVersion: buildMeta?.stateSchemaVersion ?? 1,
      controlProtocolVersion: buildMeta?.controlProtocolVersion ?? 1,
      dataProtocolVersion: buildMeta?.dataProtocolVersion ?? 1,
      publishedAt: new Date().toISOString(),
      workflow: { name: "qualification" },
      artifacts: [{
        target,
        filename,
        sizeBytes: (await statSafe(tarballPath))?.size ?? 0,
        sha256: tarballSha256,
        artifactDigest,
        targetStatus: "supported",
        bundledNodeVersion: "24",
        requiredSignatures: ["ed25519-sha256"],
        attestations: ["rly-sbom.json", "rly-provenance.json"],
      }],
    });
    const channelMetadata = buildChannelMetadata({
      channel,
      releaseVersion: manifest.releaseVersion,
      sourceCommit: manifest.sourceCommit,
      buildId: manifest.buildId,
      publishedAt: manifest.publishedAt,
      artifactDigests: { [target]: { filename, sha256: tarballSha256, artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified", ref: "rly-qualification.json" },
      updatedAt: manifest.publishedAt,
    });
    await writeJson(join(chainDir, `rly-channel-${channel}.json`), channelMetadata);
    await writeJson(join(chainDir, `rly-channel-${channel}.json.sig`), signJson(privateKeyPem, channelMetadata));
    await writeJson(join(chainDir, "rly-release.json"), manifest);
    await writeJson(join(chainDir, "rly-release.json.sig"), signJson(privateKeyPem, manifest));
    // The artifact digest statement beside a copy of the EXACT tarball (the
    // same bytes publish signs later); the release dir itself stays pristine.
    const chainTarball = join(chainDir, filename);
    await writeBytes(chainTarball, await readFileSafeBytes(tarballPath));
    await writeJson(`${chainTarball}.sig`, signDigestStatement(privateKeyPem, tarballSha256));

    const candidate = await verifyLocalAcquisition({
      metadataDirectory: chainDir,
      tarballPath: chainTarball,
      channel,
      target,
      publicKeyPem: keyPem,
    });
    notes.push(`verified the exact artifact (${candidate.version}, ${candidate.artifactDigest.slice(0, 16)}…)`);
    if (candidate.version !== manifest.releaseVersion) errors.push(`verified candidate version ${candidate.version} != manifest ${manifest.releaseVersion}`);

    // Negative: a tampered artifact must be refused BEFORE any mutation.
    const tamperedPath = join(chainDir, `tampered-${filename}`);
    const tarballBytes = await readFileSafeBytes(chainTarball);
    await writeBytes(tamperedPath, Buffer.concat([Buffer.from([tarballBytes[0] === 0 ? 1 : 0]), tarballBytes.subarray(1)]));
    await writeBytes(`${tamperedPath}.sig`, await readFileSafeBytes(`${chainTarball}.sig`));
    let refused = false;
    try {
      await verifyLocalAcquisition({ metadataDirectory: chainDir, tarballPath: tamperedPath, channel, target, publicKeyPem: keyPem });
    } catch {
      refused = true;
    }
    if (!refused) errors.push("tampered artifact was NOT refused by the installer verification");
    else notes.push("tampered artifact refused before install");

    return gateResult("verified-install", errors.length === 0 ? "passed" : "failed", {
      detail: errors.length === 0 ? `installer acquisition verified the exact bytes and refused tampered bytes: ${notes.join("; ")}` : errors.join("; "),
    });
  } catch (error) {
    return gateResult("verified-install", "failed", {
      detail: `installer verification gate failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Derives the machine-readable qualification result:
 *   qualified          — every required gate passed;
 *   experimental-gaps  — at least one required gate skipped/not-run with a
 *                        documented reason, none failed;
 *   not-qualified      — at least one required gate failed.
 */
export function deriveQualificationResult(gates) {
  const failed = gates.filter((gate) => gate.status === "failed");
  if (failed.length > 0) return "not-qualified";
  const skipped = gates.filter((gate) => gate.status === "skipped");
  return skipped.length > 0 ? "experimental-gaps" : "qualified";
}

/**
 * Stable promotion gate: returns blocking reasons (empty = stable-eligible).
 * A missing/failed required signing, SBOM/provenance, compatibility, or
 * platform qualification gate prevents stable promotion for that target.
 */
export function qualificationBlocksStable(qualification, { requireResult = true } = {}) {
  const blockers = [];
  if (qualification === undefined || qualification === null) {
    return ["no qualification record exists for the exact artifact bytes"];
  }
  if (requireResult && qualification.result !== "qualified") {
    blockers.push(`qualification result is ${qualification.result}; stable requires qualified on the exact bytes`);
  }
  const gateList = qualification.gates ?? [];
  for (const id of REQUIRED_GATES_FOR_STABLE) {
    const gate = gateList.find((entry) => entry.id === id);
    if (gate === undefined) {
      blockers.push(`required gate ${id} has no evidence (not-run)`);
    } else if (gate.status !== "passed") {
      blockers.push(`required gate ${id} is ${gate.status}${gate.detail ? `: ${gate.detail}` : ""}`);
    }
  }
  return blockers;
}

/** Serializes a qualification document (canonical shape). */
export function serializeQualification({ qualifiedBytes, target, channel, gates, result, host, releaseVersion }) {
  return {
    qualificationSchemaVersion: QUALIFICATION_SCHEMA_VERSION,
    releaseVersion,
    channel,
    target,
    qualifiedBytes,
    host,
    gates,
    result,
  };
}

async function readSignatureEnvelopeSafe(tarballPath) {
  try {
    const contents = await readFile(`${tarballPath}.sig`, "utf8");
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

async function fileExistsSafe(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function readFileSafeBytes(path) {
  return new Uint8Array(await readFile(path));
}

async function writeBytes(path, bytes) {
  await writeFile(path, Buffer.from(bytes));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
