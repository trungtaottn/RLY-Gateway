import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanaryStore } from "../../src/canary/artifact.js";
import { runCanary } from "../../src/canary/run.js";
import { CLAUDE_CODE_FIXTURE_BASELINE } from "../../src/canary/client-fixtures.js";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";

/**
 * Canary privacy (#24): artifacts/logs may carry client/provider/model ids,
 * gate names, timing/status, and fixture revisions — never prompts, model
 * responses, reasoning text, credential material, authorization headers,
 * email, or raw account identity. Synthetic fixture markers are allowed.
 */

const directories: string[] = [];
// Real credential/secret material and real content only — prose notes about
// "never authorization" are allowed. Mirrors scripts/check-privacy.mjs.
const FORBIDDEN = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|OPENROUTER_API_KEY|api[_-]?key\s*[:=]|password|accessToken|refreshToken|real-prompt|real-response/i;
const ALLOWED_EVIDENCE_KEYS = new Set([
  "client", "clientVersion", "sourceProtocol", "protocolRevision", "accessProviderId", "adapterId", "authMode", "endpointContract",
  "physicalModelId", "modelFamily", "fixtureRevision", "testedGates", "checkedAt", "evidenceLayer", "verdict", "reason",
]);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-canary-privacy-"));
  directories.push(directory);
  return directory;
}

describe("canary privacy (#24)", () => {
  it("produces secret-free evidence records for every access path", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    assertSecretFree(summary);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(FORBIDDEN);
    for (const result of summary.results) {
      // Evidence identity fields only: no prompt/response/reasoning/identity.
      for (const key of Object.keys(result)) {
        expect(ALLOWED_EVIDENCE_KEYS.has(key), `unexpected evidence key ${key}`).toBe(true);
      }
      for (const gate of result.testedGates) {
        expect(["passed", "failed", "not-run"]).toContain(gate.status);
      }
    }
  });

  it("persists artifacts that contain no credentials or account identity", async () => {
    const directory = await temporaryDirectory();
    const store = new CanaryStore(join(directory, "control-plane"));
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const artifactPath = await store.write(summary);
    expect(artifactPath).toContain(join("control-plane", "canary"));
    const content = await store.read(artifactPath);
    expect(content).toBeDefined();
    expect(content).not.toMatch(FORBIDDEN);
    assertSecretFree(JSON.parse(content ?? "") as unknown);
  });

  it("keeps v2 claim/evidence documents secret-free (no prompts, credentials, or identity material)", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    assertSecretFree(summary.claims);
    assertSecretFree(summary.evidence);
    const serialized = JSON.stringify({ claims: summary.claims, evidence: summary.evidence });
    expect(serialized).not.toMatch(FORBIDDEN);
    expect(serialized).not.toMatch(/synthetic fixture text|reasoning marker|thinking/);
    for (const claim of summary.claims) {
      expect(claim.schemaVersion).toBe(1);
      for (const record of claim.records) {
        expect(["passed", "failed", "not-run"]).toContain(record.result);
        expect(["A", "B", "C"]).toContain(record.layer);
      }
    }
  });

  it("persists v2 claim documents that contain no credentials or account identity", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new CanaryStore(controlPlane);
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const artifactPath = await store.write(summary);
    const ClaimEvidenceStore = (await import("../../src/canary/artifact.js")).ClaimEvidenceStore;
    const claimStore = new ClaimEvidenceStore(controlPlane);
    await claimStore.appendRun(summary, { ref: artifactPath });
    const claims = await claimStore.listClaims();
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(JSON.stringify(claim)).not.toMatch(FORBIDDEN);
      assertSecretFree(claim);
      for (const record of claim.records) {
        expect(record.ref).toBe(artifactPath);
        expect(record.environment).toBeDefined();
      }
    }
  });

  it("creates claim artifacts with restrictive private modes", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const ClaimEvidenceStore = (await import("../../src/canary/artifact.js")).ClaimEvidenceStore;
    const claimStore = new ClaimEvidenceStore(controlPlane);
    await claimStore.appendRun(summary);
    const claims = await claimStore.listClaims();
    expect(claims.length).toBeGreaterThan(0);
    expect((await stat(join(controlPlane, "claims"))).mode & 0o777).toBe(0o700);
  });

  it("pins synthetic (non-secret) upstream fixtures only", async () => {
    const fixture = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "fixtures", "upstream", "claude-code", "client-contract-2.1.229.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(fixture)).not.toMatch(FORBIDDEN);
    expect(CLAUDE_CODE_FIXTURE_BASELINE).toBe("claude-code-2.1.229");
  });

  it("never records prompts, responses, or reasoning text in gate results", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const serialized = JSON.stringify(summary.results);
    expect(serialized).not.toMatch(/synthetic fixture text/);
    expect(serialized).not.toMatch(/reasoning marker|thinking/);
  });

  it("keeps artifacts readable by review tooling and deterministic across runs", async () => {
    const directory = await temporaryDirectory();
    const store = new CanaryStore(join(directory, "control-plane"));
    const first = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    await store.write(first);
    const second = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    await store.write(second);
    const listed = await store.list();
    expect(listed.length).toBe(1); // deterministic per-baseline artifact name
    expect(listed[0]?.clientBaseline).toBe(CLAUDE_CODE_FIXTURE_BASELINE);
  });

  it("creates canary artifacts with restrictive private modes", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new CanaryStore(controlPlane);
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const artifactPath = await store.write(summary);
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(controlPlane, "canary"))).mode & 0o777).toBe(0o700);
  });

  it("leaves a reviewable no-artifact state empty before any run", async () => {
    const directory = await temporaryDirectory();
    const store = new CanaryStore(join(directory, "control-plane"));
    expect(await store.list()).toEqual([]);
  });
});
