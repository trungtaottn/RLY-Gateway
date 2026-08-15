import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanaryStore } from "../../src/canary/artifact.js";
import { CLAUDE_CODE_FIXTURE_BASELINE } from "../../src/canary/client-fixtures.js";
import { runCanaryCommand } from "../../src/cli/canary.js";
import { parseCliArgs, runCli } from "../../src/cli/main.js";
import { RLY_LIVE_CANARY_ENV } from "../../src/canary/run.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-canary-"));
  directories.push(directory);
  return directory;
}

async function configPathWithControlPlane(directory: string): Promise<string> {
  const controlPlane = join(directory, "control-plane");
  const path = join(directory, "gateway.toml");
  await writeFile(path, [
    "schemaVersion = 1",
    "[gateway]",
    "port = 17871",
    "logLevel = \"silent\"",
    "[controlPlane]",
    `dataDirectory = ${JSON.stringify(controlPlane)}`,
  ].join("\n"), "utf8");
  return path;
}

describe("canary CLI (#24)", () => {
  it("parses canary run|status and rejects unknown actions", () => {
    expect(parseCliArgs(["canary", "run", "--config", "gateway.toml"], "/work")).toEqual({
      command: "canary",
      action: "run",
      configPath: "/work/gateway.toml",
    });
    expect(parseCliArgs(["canary", "status"], "/work")).toEqual({
      command: "canary",
      action: "status",
      configPath: "/work/gateway.config.toml",
    });
    expect(() => parseCliArgs(["canary", "fly"], "/work")).toThrow("canary requires run or status");
    expect(() => parseCliArgs(["canary", "run", "--live"], "/work")).toThrow("unknown option");
  });

  it("runs the deterministic matrix, persists a secret-free artifact and claim docs, and prints a summary", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await runCanaryCommand("run", configPath);
      expect(code).toBe(0);
      const printed = String(log.mock.calls.at(-1)?.[0]);
      const summary = JSON.parse(printed) as { clientBaseline: string; results: unknown[]; artifactPath: string; installed: unknown[]; evidenceSchemaVersion: number; claims: unknown[] };
      expect(summary.clientBaseline).toBe(CLAUDE_CODE_FIXTURE_BASELINE);
      expect(summary.results.length).toBeGreaterThan(0);
      expect(summary.artifactPath).toContain(join("control-plane", "canary"));
      expect(summary.evidenceSchemaVersion).toBe(2);
      expect(Array.isArray(summary.claims)).toBe(true);
      expect(Array.isArray(summary.installed)).toBe(true);
      // Secret-free surface.
      expect(printed).not.toMatch(/OPENROUTER_API_KEY|accessToken|authorization|Bearer|prompt|response/i);
      const artifact = JSON.parse(await readFile(summary.artifactPath, "utf8")) as { results: { verdict: string }[] };
      expect(artifact.results.length).toBe(summary.results.length);
      // Claim/evidence v2 documents are persisted under <control-plane>/claims/.
      const claimsDirectory = join(directory, "control-plane", "claims");
      const names = (await import("node:fs/promises")).readdir;
      const files = await names(claimsDirectory);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((name) => name.startsWith("claim-") && name.endsWith(".json"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("never reports fake-only evidence as VERIFIED (evidence is Layer A only; runner switch is not evidence)", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runCanaryCommand("run", configPath);
      const printed = String(log.mock.calls.at(-1)?.[0]);
      const summary = JSON.parse(printed) as { results: { verdict: string; evidenceLayer: string }[]; liveRunner: { enabled: boolean; evidenceEmitted: boolean } };
      expect(summary.results.length).toBeGreaterThan(0);
      for (const result of summary.results) {
        expect(result.evidenceLayer).toBe("A");
        expect(["EXPERIMENTAL", "unknown"]).toContain(result.verdict);
        expect(result.verdict).not.toBe("VERIFIED");
      }
      expect(RLY_LIVE_CANARY_ENV).toBe("RLY_LIVE_CANARY");
      expect(summary.liveRunner.evidenceEmitted).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("status reports no artifacts before a run and the tested baselines + claim schema after", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const before = await runCanaryCommand("status", configPath);
      expect(before).toBe(1);
      expect(String(log.mock.calls.at(-1)?.[0])).toContain('"hasArtifacts":false');
      expect(String(log.mock.calls.at(-1)?.[0])).toContain('"claimEvidence"');
      await runCanaryCommand("run", configPath);
      const after = await runCanaryCommand("status", configPath);
      expect(after).toBe(0);
      const printed = String(log.mock.calls.at(-1)?.[0]);
      expect(printed).toContain('"hasArtifacts":true');
      expect(printed).toContain('"testedBaselines"');
      expect(printed).toContain('"claudeCode"');
      expect(printed).toContain('"claimEvidence"');
      expect(printed).toContain('"claimCount"');
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed on a malformed persisted artifact instead of trusting it", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const canaryDirectory = join(controlPlane, "canary");
    await mkdir(canaryDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(canaryDirectory, "canary-claude-code-2.1.229.json"), "not json", { mode: 0o600 });
    const store = new CanaryStore(controlPlane);
    await expect(store.list()).rejects.toThrow(/Malformed canary artifact/);
  });

  it("routes through runCli dispatch", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await runCli(["canary", "run", "--config", configPath]);
      expect(code).toBe(0);
      expect(String(log.mock.calls.at(-1)?.[0])).toContain('"clientBaseline"');
    } finally {
      log.mockRestore();
    }
  });
});
