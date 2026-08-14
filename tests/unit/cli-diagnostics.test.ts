import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { runDoctor, runQuota, runRouteTrace, runStatus } from "../../src/cli/diagnostics.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { loadConfig } from "../../src/config/load-config.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { acquireGateway, runtimeDirectory } from "../../src/runtime/gateway-lifecycle.js";
import { prepareClaudeOverlay, CLAUDE_OVERLAY_ALLOWLIST_VERSION } from "../../src/runtime/claude-overlay.js";
import { CLAUDE_CODE_FIXTURE_BASELINE } from "../../src/canary/client-fixtures.js";
import { seedCodexClaudeProfile, sseFixture } from "../helpers/codex-profile-seed.js";

const directories: string[] = [];
let provider: FastifyInstance | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("CLI diagnostics", () => {
  it("prints secret-free doctor JSON without creating a control-plane store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-doctor-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runDoctor(configPath)).resolves.toBe(0);
      const printed = String(log.mock.calls[0]?.[0]);
      expect(printed).toContain('"ok":true');
      expect(printed).toContain('"claudeTarget"');
      expect(printed).toContain('"codexTarget"');
      expect(printed).not.toMatch(/OPENROUTER_API_KEY|accessToken|authorization|prompt/i);
    } finally {
      log.mockRestore();
    }
  });

  it("reports exact client version metadata and the canary baseline in doctor (#24)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-doctor-version-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runDoctor(configPath)).resolves.toBe(0);
      const printed = String(log.mock.calls[0]?.[0]);
      const doctor = JSON.parse(printed) as {
        claudeTarget: { found: boolean; executable: string; version?: string; versionSource: string };
        codexTarget: { found: boolean; executable: string; version?: string; versionSource: string };
        canary: { testedBaseline: string; liveGateEnv: string };
      };
      // Binary presence and exact version metadata are separate fields; a
      // machine may legitimately have an installed client (versionSource
      // "cli-output") or none ("unknown") — presence never implies baseline.
      expect(doctor.claudeTarget).toHaveProperty("found");
      expect(doctor.claudeTarget).toHaveProperty("executable");
      expect(["cli-output", "unknown"]).toContain(doctor.claudeTarget.versionSource);
      expect(["cli-output", "unknown"]).toContain(doctor.codexTarget.versionSource);
      if (doctor.claudeTarget.versionSource === "cli-output") {
        expect(doctor.claudeTarget["version"]).toEqual(expect.any(String));
      }
      expect(doctor.canary.testedBaseline).toBe(CLAUDE_CODE_FIXTURE_BASELINE);
      expect(doctor.canary.liveGateEnv).toBe("RLY_LIVE_CANARY");
      expect(printed).not.toMatch(/Bearer|accessToken|authorization|prompt/i);
    } finally {
      log.mockRestore();
    }
  });

  it("exposes allowlisted update metadata in status without secrets (#73)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-status-update-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      "logLevel = \"silent\"",
      "[controlPlane]",
      `dataDirectory = ${JSON.stringify(join(directory, "plane"))}`,
    ].join("\n"), "utf8");
    const store = new UpdateStateStore(join(directory, "plane"));
    await store.write({
      schemaVersion: 1,
      state: "pending-activation",
      currentVersion: "0.1.0",
      pendingVersion: "2.0.0",
      previousVersion: "0.1.0",
      updatedAt: new Date().toISOString(),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runStatus(configPath)).resolves.toBe(1); // runtime not running
      const printed = String(log.mock.calls.at(-1)?.[0]);
      const payload = JSON.parse(printed) as { update: { state: string; pendingVersion?: string; compatibility: { cli: string; compatible: boolean } } };
      expect(payload.update.state).toBe("pending-activation");
      expect(payload.update.pendingVersion).toBe("2.0.0");
      expect(payload.update.compatibility.cli).toBe(RUNTIME_VERSION);
      expect(typeof payload.update.compatibility.compatible).toBe("boolean");
      expect(printed).not.toMatch(/Bearer|accessToken|authorization|api[_-]?key|prompt|@/i);
    } finally {
      log.mockRestore();
    }
  });

  it("reports the RLY Claude overlay summary secret-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-overlay-diag-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    const native = join(directory, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: { HOME: directory, PATH: "/bin" } });
    const port = await availablePort();
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      `port = ${String(port)}`,
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Gateway is not running, but the overlay summary is still reported.
      await expect(runStatus(configPath)).resolves.toBe(1);
      const printed = log.mock.calls.map((call) => String(call[0]));
      const status = JSON.parse(printed.find((line) => line.includes("claudeOverlay")) ?? "{}") as {
        claudeOverlay?: { directory?: string; source?: string; allowlistVersion?: number; lastComposedAt?: string };
      };
      expect(status.claudeOverlay).toMatchObject({
        directory: join(controlPlane, "claude"),
        source: native,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      });
      expect(typeof status.claudeOverlay?.lastComposedAt).toBe("string");
      expect(printed.join("\n")).not.toMatch(/ANTHROPIC_AUTH_TOKEN|model|theme|settings|token|secret/i);
    } finally {
      log.mockRestore();
    }
  });

  it("prints only pseudonym, quota class, and decision reason for a Codex profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-diag-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("codex-diag", "CODEX_DIAG_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const store = await ControlPlaneStore.open(controlPlane);
    const broker = await CredentialBroker.open(controlPlane);
    try {
      await seedCodexClaudeProfile(store, broker, controlPlane, { endpoint });
    } finally {
      await broker.close();
      store.close();
    }
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      `port = ${String(port)}`,
      `managementPort = ${String(managementPort)}`,
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    const lease = await acquireGateway({
      config: await loadConfig(configPath),
      controlPlaneDirectory: controlPlane,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const issued = await fetch(`${lease.baseUrl}/v1/launch-sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${lease.authToken}`, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "codex", leaseId: lease.leaseId }),
      });
      expect(issued.status).toBe(201);
      const issuedBody = await issued.json() as { token?: string };
      const response = await fetch(`${lease.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${issuedBody.token ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] }),
      });
      expect(response.status).toBe(200);
      await expect(runQuota(configPath)).resolves.toBe(0);
      await expect(runRouteTrace(configPath)).resolves.toBe(0);
      await expect(runStatus(configPath)).resolves.toBe(0);
      const printed = log.mock.calls.map((call) => String(call[0]));
      const quota = JSON.parse(printed.find((line) => line.includes("accounts")) ?? "{}") as {
        accounts?: { pseudonym?: string; quotaClass?: string }[];
      };
      const traces = JSON.parse(printed.find((line) => line.includes("sourceRule")) ?? "{}") as {
        traces?: { profileName?: string; sourceRule?: string; selectedPseudonym?: string }[];
      };
      expect(quota.accounts?.[0]?.pseudonym).toBe("acct-codex-a");
      expect(quota.accounts?.[0]?.quotaClass).toBe("healthy");
      expect(quota.accounts?.[0]).toEqual({ pseudonym: "acct-codex-a", quotaClass: "healthy" });
      expect(traces.traces?.[0]?.profileName).toBe("codex");
      expect(traces.traces?.[0]?.sourceRule).toMatch(/^pool:/);
      expect(traces.traces?.[0]?.selectedPseudonym).toBe("acct-codex-a");
      expect(traces.traces?.[0]).toEqual({
        profileName: "codex",
        sourceRule: traces.traces?.[0]?.sourceRule,
        selectedPseudonym: "acct-codex-a",
      });
      expect(printed.join("\n")).not.toMatch(/access-token-fixture|refresh-token|authorization|prompt|@/i);
    } finally {
      log.mockRestore();
      await lease.release();
      await rm(runtimeDirectory(port), { recursive: true, force: true });
    }
  });
});
