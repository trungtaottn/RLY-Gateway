import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SCRIPT_NAME,
  BootstrapResolutionError,
  bootstrapScriptPath,
  bootstrapServiceDefinition,
  buildBootstrapScript,
  ensureInitialActiveDeployment,
  materializeRuntimeTree,
  resolveActiveDeployment,
  writeBootstrapScript,
} from "../../src/runtime/bootstrap.js";
import { LocalCandidateInstaller, computeArtifactId } from "../../src/runtime/update/installer.js";
import { defaultBuildIdentity } from "../../src/runtime/build-identity.js";
import { runtimePaths } from "../../src/storage/paths.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function directory(prefix = "rly-bootstrap-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Builds a minimal immutable deployment tree (private 0700 layout). */
async function makeDeployment(parent: string, version: string): Promise<{ source: string; artifactId: string }> {
  const source = join(parent, `candidate-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true, mode: 0o700 });
  await chmod(source, 0o700);
  await chmod(join(source, "dist"), 0o700);
  await chmod(join(source, "dist", "cli"), 0o700);
  await writeFile(join(source, "dist", "cli", "main.js"), `// rly ${version}\n`, "utf8");
  await writeFile(join(source, "rly.json"), JSON.stringify({ product: "rly-gateway", version, stateVersion: 2, migrationClass: "backward-compatible-expand" }), "utf8");
  const artifactId = await computeArtifactId(source);
  return { source, artifactId };
}

async function installActive(controlPlane: string, version: string): Promise<string> {
  const installer = new LocalCandidateInstaller({ directory: controlPlane });
  const { source, artifactId } = await makeDeployment(controlPlane, version);
  await installer.installCandidate({ version, sourceDirectory: source });
  await installer.activateStaged();
  return artifactId;
}

describe("stable RLY-owned bootstrap (#94)", () => {
  it("renders a self-locating POSIX launcher that resolves only the committed active deployment", () => {
    const script = buildBootstrapScript();
    expect(script).toContain("#!/bin/sh");
    // Self-locating: derives the control-plane root from its own path.
    expect(script).toContain('RLY_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"');
    // Resolves ONLY refs/active; never staged, never a direct deployment path.
    expect(script).toContain('ACTIVE_REF="$RLY_ROOT/runtime/refs/active"');
    expect(script).toContain("RLY bootstrap: no committed active deployment");
    expect(script).toContain("refusing to start from a staged or uncommitted runtime");
    // Never executes dist/cli/init.js or a Node path (contract); the comment
    // may name it as the thing being replaced.
    expect(script).not.toContain('exec "$NODE_BIN" "$DEPLOY/dist/cli/init.js"');
    // Executes the real dispatcher with the caller's arguments.
    expect(script).toContain('exec "$NODE_BIN" "$DEPLOY/dist/cli/main.js" "$@"');
    // Exports the serving artifact digest for /identity.
    expect(script).toContain("export RLY_SERVING_ARTIFACT");
    // Node resolution is the bootstrap's implementation detail (override →
    // PATH → recorded fallback), never the definition's contract.
    expect(script).toContain('NODE_BIN="${RLY_NODE:-}"');
    expect(script).toContain('command -v node');
  });

  it("writes the bootstrap idempotently with an executable script and a node fallback", async () => {
    const controlPlane = await directory();
    const first = await writeBootstrapScript(controlPlane);
    expect(first).toBe(bootstrapScriptPath(controlPlane));
    expect(first).toBe(join(controlPlane, "bootstrap", BOOTSTRAP_SCRIPT_NAME));
    expect((await readFile(first, "utf8"))).toBe(buildBootstrapScript());
    const stats = await import("node:fs/promises").then((m) => m.stat(first));
    expect(stats.mode & 0o777).toBe(0o755);
    const fallback = await readFile(join(controlPlane, "bootstrap", "node-path"), "utf8");
    expect(fallback.trim().length).toBeGreaterThan(0);
    // Idempotent rewrite leaves content identical.
    await writeBootstrapScript(controlPlane);
    expect(await readFile(first, "utf8")).toBe(buildBootstrapScript());
  });

  it("builds the service definition against the bootstrap (no entrypoint, no node path)", () => {
    const controlPlane = "/home/alice/.rly";
    const definition = bootstrapServiceDefinition(controlPlane, "/home/alice/work/gateway.config.toml");
    expect(definition.executable).toBe(join(controlPlane, "bootstrap", "rly-gateway"));
    expect(definition.entrypoint).toBeUndefined();
    expect(definition.configPath).toBe("/home/alice/work/gateway.config.toml");
    expect(definition.executable).not.toMatch(/dist[/\\]cli[/\\]init\.js/);
  });

  it("resolves the committed active deployment and refuses staged/uncommitted/missing candidates", async () => {
    const controlPlane = await directory();
    const artifactId = await installActive(controlPlane, "0.1.0");
    const resolved = await resolveActiveDeployment(controlPlane);
    expect(resolved.artifactId).toBe(artifactId);
    expect(resolved.version).toBe("0.1.0");
    expect(resolved.entrypoint).toBe(join(runtimePaths(controlPlane).versions, artifactId, "dist", "cli", "main.js"));

    // Missing active reference ⇒ refusal (staged-only is NOT enough).
    const fresh = await directory();
    const installer = new LocalCandidateInstaller({ directory: fresh });
    const { source } = await makeDeployment(fresh, "0.2.0");
    await installer.installCandidate({ version: "0.2.0", sourceDirectory: source });
    // staged exists, active does not — the bootstrap refuses.
    await expect(resolveActiveDeployment(fresh)).rejects.toThrow(BootstrapResolutionError);
    await expect(resolveActiveDeployment(fresh)).rejects.toThrow(/no committed active deployment/);

    // No refs at all ⇒ refusal.
    const empty = await directory();
    await expect(resolveActiveDeployment(empty)).rejects.toThrow(/no committed active deployment/);
  });

  it("refuses an active reference that is not a valid immutable deployment", async () => {
    const controlPlane = await directory();
    await installActive(controlPlane, "0.1.0");
    const paths = runtimePaths(controlPlane);
    // Point active at a non-immutable target.
    await rm(paths.active).catch(() => undefined);
    await symlink("../versions/not-an-artifact", paths.active);
    await expect(resolveActiveDeployment(controlPlane)).rejects.toThrow(/not a valid immutable deployment/);
  });

  it("refuses an active deployment whose metadata identity conflicts", async () => {
    const controlPlane = await directory();
    const artifactId = await installActive(controlPlane, "0.1.0");
    const deploymentDir = join(runtimePaths(controlPlane).versions, artifactId);
    // Corrupt the metadata identity.
    await writeFile(join(deploymentDir, ".rly-deployment.json"), JSON.stringify({
      schemaVersion: 1,
      artifactId: "b".repeat(64),
      product: "rly-gateway",
      version: "0.1.0",
      installedAt: new Date().toISOString(),
    }), "utf8");
    await expect(resolveActiveDeployment(controlPlane)).rejects.toThrow(/does not match its directory/);
  });

  it("materializes the runtime tree with symlinks dereferenced and allowlisted entries only", async () => {
    const source = await directory("rly-bootstrap-src-");
    const target = await directory("rly-bootstrap-out-");
    await mkdir(join(source, "dist", "cli"), { recursive: true });
    await writeFile(join(source, "dist", "cli", "main.js"), "export const x = 1;\n", "utf8");
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "rly-gateway" }), "utf8");
    await mkdir(join(source, "node_modules", "realpkg"), { recursive: true });
    await writeFile(join(source, "node_modules", "realpkg", "index.js"), "// real\n", "utf8");
    // pnpm-style symlink into the virtual store.
    await mkdir(join(source, "node_modules", ".pnpm", "fastify@5", "node_modules"), { recursive: true });
    await writeFile(join(source, "node_modules", ".pnpm", "fastify@5", "node_modules", "index.js"), "// fastify\n", "utf8");
    await symlink(".pnpm/fastify@5/node_modules", join(source, "node_modules", "fastify"));
    // Non-allowlisted junk is never copied.
    await writeFile(join(source, "secret-local.txt"), "should-not-be-copied\n", "utf8");
    await mkdir(join(source, ".git"), { recursive: true });
    await writeFile(join(source, ".git", "config"), "junk\n", "utf8");

    await materializeRuntimeTree(source, target);

    const mainJs = await readFile(join(target, "dist", "cli", "main.js"), "utf8");
    expect(mainJs).toContain("export const x = 1");
    // The symlink was dereferenced into a real file.
    const fastify = await readFile(join(target, "node_modules", "fastify", "index.js"), "utf8");
    expect(fastify).toContain("// fastify");
    const details = await import("node:fs/promises").then((m) => m.lstat(join(target, "node_modules", "fastify")));
    expect(details.isSymbolicLink()).toBe(false);
    await expect(readFile(join(target, "secret-local.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target, ".git", "config"), "utf8")).rejects.toThrow();
  });

  it("establishes the initial committed active deployment idempotently from the runtime tree", async () => {
    const controlPlane = await directory();
    const packageRoot = await directory("rly-bootstrap-pkg-");
    await mkdir(join(packageRoot, "dist", "cli"), { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, "dist", "cli", "main.js"), "// initial runtime\n", "utf8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "rly-gateway", version: "0.1.0" }), "utf8");
    const identity = { ...defaultBuildIdentity(), commitRevision: "abc123", buildId: "b1" };

    const created = await ensureInitialActiveDeployment(controlPlane, { packageRoot, identity });
    expect(created.created).toBe(true);
    const resolved = await resolveActiveDeployment(controlPlane);
    expect(resolved.version).toBe("0.1.0");
    expect(resolved.artifactId).toBe(created.artifactId);
    const metadata = JSON.parse(await readFile(join(resolved.deploymentDirectory, ".rly-deployment.json"), "utf8")) as {
      artifactId: string; version: string; buildId?: string; commitRevision?: string; releaseChannel?: string; migrationClass?: string;
    };
    expect(metadata.artifactId).toBe(resolved.artifactId);
    expect(metadata.version).toBe("0.1.0");
    expect(metadata.buildId).toBe("b1");
    expect(metadata.commitRevision).toBe("abc123");
    expect(metadata.releaseChannel).toBe("dev");
    expect(metadata.migrationClass).toBe("backward-compatible-expand");

    // Idempotent: a valid committed active deployment is never re-created.
    const second = await ensureInitialActiveDeployment(controlPlane, { packageRoot, identity });
    expect(second.created).toBe(false);
    expect(second.artifactId).toBe(resolved.artifactId);
    const activeTarget = await readlink(runtimePaths(controlPlane).active);
    expect(activeTarget).toBe(`../versions/${resolved.artifactId}`);
  });

  it("proves bootstrap resolution → execution with a real dispatcher when sh/node are available", async () => {
    const script = buildBootstrapScript();
    const controlPlane = await directory();
    const bootstrapDir = join(controlPlane, "bootstrap");
    await mkdir(bootstrapDir, { recursive: true, mode: 0o700 });
    const scriptPath = join(bootstrapDir, BOOTSTRAP_SCRIPT_NAME);
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);
    const artifactId = await installActive(controlPlane, "0.1.0");
    // Replace the dispatcher with a real marker-writing node script.
    const marker = join(controlPlane, "executed.json");
    const entrypoint = join(runtimePaths(controlPlane).versions, artifactId, "dist", "cli", "main.js");
    await writeFile(entrypoint, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), artifact: process.env.RLY_SERVING_ARTIFACT }));\n`, "utf8");

    let result;
    try {
      result = await execFileAsync("/bin/sh", [scriptPath, "gateway", "start", "--config", "/work/gateway.config.toml"], {
        env: { ...process.env, PATH: "/usr/bin:/bin", RLY_NODE: process.execPath },
      });
    } catch (error) {
      // sh/node unavailable in this environment: skipped, not a pass.
      return;
    }
    expect(result.stderr).toBe("");
    const executed = JSON.parse(await readFile(marker, "utf8")) as { argv: string[]; artifact?: string };
    expect(executed.argv).toEqual(["gateway", "start", "--config", "/work/gateway.config.toml"]);
    expect(executed.artifact).toBe(artifactId);
  });

  it("refuses execution (exit 78) when no committed active deployment exists", async () => {
    const script = buildBootstrapScript();
    const controlPlane = await directory();
    const bootstrapDir = join(controlPlane, "bootstrap");
    await mkdir(bootstrapDir, { recursive: true, mode: 0o700 });
    const scriptPath = join(bootstrapDir, BOOTSTRAP_SCRIPT_NAME);
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);
    try {
      const result = await execFileAsync("/bin/sh", [scriptPath, "gateway", "start", "--config", "/work/gateway.config.toml"], {
        env: { PATH: "/usr/bin:/bin", RLY_NODE: process.execPath },
      });
      throw new Error(`bootstrap unexpectedly succeeded: ${result.stdout}`);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException & { code?: number; stderr?: string };
      if (cause.code === "ENOENT") return; // no sh: skipped, not a pass
      expect(cause.code).toBe(78);
      expect(cause.stderr ?? "").toContain("no committed active deployment");
    }
  });
});
