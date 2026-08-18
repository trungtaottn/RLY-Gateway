import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  LEGACY_V1_POLICY,
  appendObservation,
  claimIdentityFor,
  claimKeyFor,
  claimKeyHash,
  claimStatusFor,
  compatibilityClaimDocumentSchema,
  emptyClaimDocument,
  evidenceArtifactV2Schema,
  isV2EvidenceSummary,
  layerStatuses,
  legacyPolicyNote,
  requiredLayersForAdapter,
} from "../../src/canary/claim.js";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { runCanary } from "../../src/canary/run.js";
import type { CompatibilityClaimIdentity, EvidenceArtifactV2 } from "../../src/canary/claim.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-claim-"));
  directories.push(directory);
  return directory;
}

const CLAUDE_IDENTITY: CompatibilityClaimIdentity = claimIdentityFor({
  client: "claude-code",
  clientVersion: CLAUDE_CODE_CONTRACT.baseline,
  contract: CLAUDE_CODE_CONTRACT,
  adapterId: "codex-oauth",
  accessProviderId: "codex",
  physicalModelId: "gpt-5.4",
  modelFamily: "openai/codex",
});

function record(overrides: Partial<EvidenceArtifactV2> = {}): EvidenceArtifactV2 {
  return Object.freeze({
    claimKey: claimKeyFor(CLAUDE_IDENTITY, "text"),
    feature: "text",
    layer: "A",
    kind: "deterministic-fake-matrix",
    fixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    runnerVersion: "rly-canary-runner/2.0",
    checkedAt: "1970-01-01T00:00:00.000Z",
    result: "passed",
    environment: Object.freeze({ platform: "linux", nodeVersion: "v24.0.0" }),
    ...overrides,
  });
}

describe("Compatibility Claim and Evidence v2 (#122)", () => {
  it("builds a stable, versioned claim key from the exact execution path", () => {
    const key = claimKeyFor(CLAUDE_IDENTITY, "text");
    expect(key.startsWith("v2|")).toBe(true);
    expect(key).toContain("claude-code");
    expect(key).toContain(CLAUDE_CODE_CONTRACT.baseline);
    expect(key).toContain("anthropic-messages");
    expect(key).toContain("codex-oauth");
    expect(key).toContain("codex");
    expect(key).toContain("oauth");
    expect(key).toContain("gpt-5.4");
    expect(key.endsWith("|text")).toBe(true);
    expect(claimKeyFor(CLAUDE_IDENTITY, "text")).toBe(claimKeyFor(CLAUDE_IDENTITY, "text"));
    expect(claimKeyHash(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(claimKeyHash(key)).toBe(claimKeyHash(key));
  });

  it("keeps model family as metadata only — never part of the claim key", () => {
    const withFamily = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "codex-oauth",
      accessProviderId: "codex",
      physicalModelId: "gpt-5.4",
      modelFamily: "openai/codex",
    });
    const withoutFamily = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "codex-oauth",
      accessProviderId: "codex",
      physicalModelId: "gpt-5.4",
    });
    expect(claimKeyFor(withFamily, "text")).toBe(claimKeyFor(withoutFamily, "text"));
    expect(withFamily.modelFamily).toBe("openai/codex");
  });

  it("never reuses claims across provider/model/feature (distinct keys and docs)", () => {
    const cline = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "cline-interop",
      accessProviderId: "cline",
      physicalModelId: "gpt-5.6-sol",
    });
    const codex = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "codex-oauth",
      accessProviderId: "codex",
      physicalModelId: "gpt-5.6-sol",
    });
    const keys = new Set([
      claimKeyFor(cline, "text"),
      claimKeyFor(codex, "text"),
      claimKeyFor(cline, "tools-parallel"),
      claimKeyFor(cline, "reasoning"),
      claimKeyFor(CLAUDE_IDENTITY, "text"),
    ]);
    expect(keys.size).toBe(5);
  });

  it("derives per-feature status with explicit layer presence (missing ≠ not-run ≠ pass ≠ fail)", () => {
    const doc = emptyClaimDocument(CLAUDE_IDENTITY, "text");
    expect(claimStatusFor(doc)).toBe("missing");
    expect(layerStatuses(doc)).toEqual({ A: "missing", B: "missing", C: "missing" });

    // A single Layer A pass cannot satisfy a claim: B and C are required layers.
    const layerAOnly = appendObservation(doc, record());
    expect(claimStatusFor(layerAOnly)).toBe("not-run");
    expect(layerStatuses(layerAOnly)).toEqual({ A: "passed", B: "missing", C: "missing" });

    // A typed failure wins immediately (evidence of brokenness).
    const failed = appendObservation(doc, record({ result: "failed", failureReason: "tool-result-invalid" }));
    expect(claimStatusFor(failed)).toBe("failed");

    // Explicit not-run record stays not-run, never passed.
    const notRun = appendObservation(doc, record({ result: "not-run", failureReason: "no-tool-evidence" }));
    expect(claimStatusFor(notRun)).toBe("not-run");
    expect(layerStatuses(notRun).A).toBe("not-run");
  });

  it("requires every required layer before a claim can pass (Layer A alone never implies production trust)", () => {
    expect(requiredLayersForAdapter("codex-oauth")).toEqual(["A", "B", "C"]);
    expect(requiredLayersForAdapter("unknown-adapter")).toEqual(["A", "B", "C"]); // fail closed
    const doc = emptyClaimDocument(CLAUDE_IDENTITY, "text");
    const a = appendObservation(doc, record());
    const b = appendObservation(a, record({ layer: "B", kind: "installed-client", result: "passed" }));
    const c = appendObservation(b, record({ layer: "C", kind: "live-access-path", result: "passed" }));
    expect(claimStatusFor(c)).toBe("passed");
    expect(layerStatuses(c)).toEqual({ A: "passed", B: "passed", C: "passed" });
  });

  it("serializes and re-parses claim documents through the Zod schema", () => {
    const doc = appendObservation(emptyClaimDocument(CLAUDE_IDENTITY, "text"), record());
    const reparsed = compatibilityClaimDocumentSchema.parse(JSON.parse(JSON.stringify(doc)));
    expect(reparsed).toEqual(doc);
    const evidence = evidenceArtifactV2Schema.parse(JSON.parse(JSON.stringify(record())));
    expect(evidence).toEqual(record());
    expect(() => compatibilityClaimDocumentSchema.parse({ schemaVersion: 1, claimKey: "x", records: "nope" })).toThrow();
  });

  it("appends observations audit-friendly: existing records are never rewritten or reordered", () => {
    const first = appendObservation(emptyClaimDocument(CLAUDE_IDENTITY, "text"), record({ checkedAt: "1970-01-01T00:00:00.000Z" }));
    const second = appendObservation(first, record({ checkedAt: "1970-01-01T00:00:01.000Z" }));
    expect(second.records.length).toBe(2);
    expect(second.records[0]).toEqual(first.records[0]);
    // Exact duplicate observations are idempotent no-ops.
    const duplicate = appendObservation(second, record({ checkedAt: "1970-01-01T00:00:00.000Z" }));
    expect(duplicate).toBe(second);
    expect(duplicate.records.length).toBe(2);
  });

  it("stores claims append-only and supports deterministic lookup by claim identity + feature", async () => {
    const directory = await temporaryDirectory();
    const store = new ClaimEvidenceStore(join(directory, "control-plane"));
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    await store.appendRun(summary);
    const clineSolIdentity = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "cline-interop",
      accessProviderId: "cline",
      physicalModelId: "gpt-5.6-sol",
    });
    const textClaim = await store.findEvidence(clineSolIdentity, "text");
    expect(textClaim).toBeDefined();
    expect(textClaim?.feature).toBe("text");
    expect(textClaim?.claimIdentity.accessProviderId).toBe("cline");
    expect(claimStatusFor(textClaim ?? emptyClaimDocument(clineSolIdentity, "text"))).toBe("not-run"); // Layer A only
    // Exact lookup: a different feature or different provider finds nothing.
    expect(await store.findEvidence(clineSolIdentity, "config-overlay")).toBeUndefined(); // never observed → missing
    const unknownIdentity = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "codex-oauth",
      accessProviderId: "codex",
      physicalModelId: "gpt-9999", // not in the registry run
    });
    expect(await store.findEvidence(unknownIdentity, "text")).toBeUndefined(); // exact lookup fails closed
    // Re-running appends observations; identical records are deduped.
    await store.appendRun(summary);
    const reloaded = await store.findEvidence(clineSolIdentity, "text");
    expect(reloaded?.records.length).toBe(1);
    // Summary view.
    const summaryView = await store.summary();
    expect(summaryView.schemaVersion).toBe(CLAIM_SCHEMA_VERSION);
    expect(summaryView.claimCount).toBeGreaterThan(0);
    expect(summaryView.legacyPolicy).toBe(LEGACY_V1_POLICY);
    // Private permissions.
    const claimFile = join(directory, "control-plane", "claims", `claim-${claimKeyHash(textClaim?.claimKey ?? "")}.json`);
    expect((await stat(claimFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "control-plane", "claims"))).mode & 0o777).toBe(0o700);
  }, 15_000);

  it("treats legacy v1 canary outputs as legacy/untrusted — they can never satisfy a v2 claim", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    // A v1-shaped canary artifact (no evidenceSchemaVersion) exists in canary/.
    const canaryDirectory = join(controlPlane, "canary");
    await import("node:fs/promises").then((fs) => fs.mkdir(canaryDirectory, { recursive: true, mode: 0o700 }));
    const v1Summary = {
      ok: true,
      clientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      installed: [],
      results: [{
        client: "claude-code",
        clientVersion: CLAUDE_CODE_CONTRACT.baseline,
        accessProviderId: "codex",
        adapterId: "codex-oauth",
        physicalModelId: "gpt-5.4",
        fixtureRevision: "v1",
        testedGates: [{ gate: "text", status: "passed" }],
        checkedAt: "1970-01-01T00:00:00.000Z",
        evidenceKind: "fake",
        verdict: "EXPERIMENTAL",
      }],
    };
    await writeFile(join(canaryDirectory, "canary-claude-code-2.1.229.json"), JSON.stringify(v1Summary), { mode: 0o600 });
    // The v2 claim store never reads canary/ artifacts: lookup stays missing.
    const store = new ClaimEvidenceStore(controlPlane);
    expect(await store.findEvidence(CLAUDE_IDENTITY, "text")).toBeUndefined();
    expect(await store.listClaims()).toEqual([]);
    // The explicit policy classifies the v1 doc as legacy/untrusted.
    expect(isV2EvidenceSummary(v1Summary)).toBe(false);
    expect(legacyPolicyNote(v1Summary)).toEqual({ legacy: true, reason: LEGACY_V1_POLICY });
    expect(legacyPolicyNote({ evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION })).toEqual({ legacy: false });
  });

  it("fails closed on malformed claim documents instead of trusting them", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new ClaimEvidenceStore(controlPlane);
    const claimsDirectory = join(controlPlane, "claims");
    await import("node:fs/promises").then((fs) => fs.mkdir(claimsDirectory, { recursive: true, mode: 0o700 }));
    await writeFile(join(claimsDirectory, "claim-deadbeef.json"), "not json", { mode: 0o600 });
    await expect(store.listClaims()).rejects.toThrow(/Malformed claim evidence artifact/);
  });

  it("keeps claim evidence secret-free (no prompts, responses, credentials, or identity material)", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const serialized = JSON.stringify(summary.claims);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
    expect(serialized).not.toMatch(/api[_-]?key\s*[:=]|password|accessToken|refreshToken|real-prompt|real-response/i);
    expect(serialized).not.toMatch(/synthetic fixture text|reasoning marker|thinking/);
  });
});
