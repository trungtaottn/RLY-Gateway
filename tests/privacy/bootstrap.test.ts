import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { runStatus } from "../../src/cli/diagnostics.js";
import { buildBootstrapScript, bootstrapServiceDefinition, ensureInitialActiveDeployment, writeBootstrapScript } from "../../src/runtime/bootstrap.js";
import { defaultBuildIdentity, buildIdentityDigest, buildIdentitySchema } from "../../src/runtime/build-identity.js";
import { buildLaunchAgentPlist, buildSystemdUserUnit } from "../../src/service-manager/definitions.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-bootstrap-privacy-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FORBIDDEN = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|api[_-]?key\s*[:=]|password|accessToken|refreshToken|authorization\s*[:=]/i;

describe("bootstrap and build-identity privacy (#94)", () => {
  it("service definitions and the bootstrap script carry no secrets or identity", () => {
    const input = bootstrapServiceDefinition("/home/alice/.rly", "/home/alice/work/gateway.config.toml");
    const plist = buildLaunchAgentPlist({ ...input, label: "com.rly.gateway" });
    const unit = buildSystemdUserUnit(input);
    for (const definition of [plist, unit]) {
      expect(definition).not.toMatch(FORBIDDEN);
      expect(definition).not.toMatch(/token|secret|Bearer|authorization|@/i);
    }
    const script = buildBootstrapScript();
    expect(script).not.toMatch(FORBIDDEN);
    expect(script).not.toMatch(/authorization|Bearer|token/i);
    expect(script).not.toMatch(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/); // no email
  });

  it("build identity objects contain only public build metadata", () => {
    const identity = {
      ...defaultBuildIdentity(),
      artifactId: "a".repeat(64),
    };
    expect(buildIdentitySchema.safeParse(identity).success).toBe(true);
    assertSecretFree(identity);
    expect(JSON.stringify(identity)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(identity)).not.toMatch(/token|secret|authorization|email|@/i);
    // The digest is deterministic public metadata.
    expect(buildIdentityDigest(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an initial deployment's metadata carries identifiers only", async () => {
    const controlPlane = await directory();
    const packageRoot = await directory();
    await mkdir(join(packageRoot, "dist", "cli"), { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, "dist", "cli", "main.js"), "// runtime\n", "utf8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "rly-gateway", version: "0.1.0" }), "utf8");
    await ensureInitialActiveDeployment(controlPlane, { packageRoot, identity: defaultBuildIdentity() });
    const { readFile } = await import("node:fs/promises");
    const { resolveActiveDeployment } = await import("../../src/runtime/bootstrap.js");
    const active = await resolveActiveDeployment(controlPlane);
    const metadata = await readFile(join(active.deploymentDirectory, ".rly-deployment.json"), "utf8");
    expect(metadata).not.toMatch(FORBIDDEN);
    expect(metadata).not.toMatch(/token|secret|authorization|@/i);
  });

  it("status output stays secret-free with bootstrap/build identity fields", async () => {
    const dir = await directory();
    const controlPlane = join(dir, "control-plane");
    const configPath = join(dir, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17902\n[controlPlane]\n" + `dataDirectory = "${controlPlane}"\n`, "utf8");
    await writeBootstrapScript(controlPlane);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runStatus(configPath);
      const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain('"bootstrap"');
      expect(printed).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i);
      expect(printed).not.toMatch(/accessToken|refreshToken|authorization|prompt|api[_-]?key/i);
    } finally {
      log.mockRestore();
    }
  });
});
