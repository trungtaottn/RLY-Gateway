import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDecisionStore, QuarantineStore, COMPAT_SCHEMA_VERSION } from "../../src/compatibility/stores.js";
import { passedClaim } from "../helpers/compat.js";
import { claimKeyHash } from "../../src/canary/claim.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-compat-stores-"));
  directories.push(directory);
  return directory;
}

describe("ReviewDecisionStore (#124)", () => {
  it("appends monotonic decision revisions and persists metadata-only records", async () => {
    const directory = await temporaryDirectory();
    const store = new ReviewDecisionStore(join(directory, "control-plane"));
    const claim = passedClaim("text");
    const first = await store.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: "rev-1",
      reviewer: "owner",
      source: "test",
      reason: "reviewed",
      decidedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(first.decision.decisionRevision).toBe(1);
    const second = await store.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "reject",
      evidenceRevision: "rev-2",
      reviewer: "qa",
      source: "test",
      reason: "rejected-after-drift",
      decidedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(second.decision.decisionRevision).toBe(2);
    const decisions = await store.decisionsFor(claim.claimKey, "text");
    expect(decisions.map((decision) => decision.decision)).toEqual(["promote", "reject"]);
    expect(decisions.map((decision) => decision.decisionRevision)).toEqual([1, 2]);
    const summary = await store.summary();
    expect(summary.decisionCount).toBe(2);
    expect(summary.promoteCount).toBe(1);
    expect(summary.rejectCount).toBe(1);
    expect(summary.schemaVersion).toBe(COMPAT_SCHEMA_VERSION);
  });

  it("keeps review artifacts secret-free and private (0700/0600)", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new ReviewDecisionStore(controlPlane);
    const claim = passedClaim("text");
    await store.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: "rev-1",
      reviewer: "owner",
      source: "test",
      reason: "reviewed",
      decidedAt: "1970-01-01T00:00:00.000Z",
    });
    const serialized = JSON.stringify(await store.listDecisions());
    expect(serialized).not.toMatch(/token|secret|authorization|email|prompt|response|identity/i);
    expect((await stat(join(controlPlane, "compat"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(controlPlane, "compat", "reviews"))).mode & 0o777).toBe(0o700);
    const file = join(controlPlane, "compat", "reviews", `${claimKeyHash(claim.claimKey)}-text.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("fails closed on malformed review documents", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new ReviewDecisionStore(controlPlane);
    const claim = passedClaim("text");
    await store.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: "rev-1",
      reviewer: "owner",
      source: "test",
      reason: "reviewed",
      decidedAt: "1970-01-01T00:00:00.000Z",
    });
    await writeFile(join(controlPlane, "compat", "reviews", `${claimKeyHash(claim.claimKey)}-text.json`), "{not-json");
    await expect(store.decisionsFor(claim.claimKey, "text")).rejects.toThrow(/Malformed review decision artifact/);
  });
});

describe("QuarantineStore (#124)", () => {
  it("quarantines an exact claim/feature and lifts it explicitly (audit-friendly)", async () => {
    const directory = await temporaryDirectory();
    const store = new QuarantineStore(join(directory, "control-plane"));
    const claim = passedClaim("text");
    const added = await store.quarantine({
      claimKey: claim.claimKey,
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "runner-fail-fast",
      quarantinedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(added.record.quarantineRevision).toBe(1);
    const records = await store.recordsFor(claim.claimKey, "text");
    expect(records.some((record) => record.liftedAt === undefined)).toBe(true);
    const lifted = await store.lift(claim.claimKey, "text", { by: "owner", reason: "verified-fixed" });
    expect(lifted.record.liftedAt).toBeDefined();
    expect(lifted.record.liftReason).toBe("verified-fixed");
    const after = await store.recordsFor(claim.claimKey, "text");
    expect(after.some((record) => record.liftedAt === undefined)).toBe(false);
  });

  it("refuses to lift a claim with no active quarantine", async () => {
    const directory = await temporaryDirectory();
    const store = new QuarantineStore(join(directory, "control-plane"));
    const claim = passedClaim("text");
    await expect(store.lift(claim.claimKey, "text", { by: "owner", reason: "nope" })).rejects.toThrow(/No active quarantine/);
  });

  it("keeps quarantine scope narrow: one claim never affects another claim/feature", async () => {
    const directory = await temporaryDirectory();
    const store = new QuarantineStore(join(directory, "control-plane"));
    const text = passedClaim("text");
    const reasoning = passedClaim("reasoning");
    await store.quarantine({
      claimKey: text.claimKey,
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "runner-fail-fast",
      quarantinedAt: "1970-01-01T00:00:00.000Z",
    });
    expect((await store.recordsFor(reasoning.claimKey, "reasoning")).length).toBe(0);
    // A different provider path for the same feature is untouched.
    expect((await store.recordsFor(text.claimKey.replace("|codex|", "|cline|"), "text")).length).toBe(0);
    const summary = await store.summary();
    expect(summary.recordCount).toBe(1);
    expect(summary.activeCount).toBe(1);
  });

  it("fails closed on malformed quarantine documents", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const store = new QuarantineStore(controlPlane);
    const claim = passedClaim("text");
    await store.quarantine({
      claimKey: claim.claimKey,
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "runner-fail-fast",
      quarantinedAt: "1970-01-01T00:00:00.000Z",
    });
    await writeFile(join(controlPlane, "compat", "quarantines", `${claimKeyHash(claim.claimKey)}-text.json`), "[]");
    await expect(store.recordsFor(claim.claimKey, "text")).rejects.toThrow(/Malformed quarantine artifact/);
  });
});
