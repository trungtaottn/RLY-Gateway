import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { runCompatCommand, parseCompatArgs } from "../../src/cli/compat.js";
import { parseCliArgs } from "../../src/cli/main.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { ReviewDecisionStore, QuarantineStore } from "../../src/compatibility/stores.js";
import { passedClaim } from "../helpers/compat.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-compat-cli-"));
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

describe("compat CLI (#124)", () => {
  it("parses compat status/review/quarantine/lift/explain and rejects unknown subcommands", () => {
    expect(parseCliArgs(["compat", "status", "--config", "gateway.toml"], "/work")).toEqual({
      command: "compat",
      action: { kind: "status" },
      configPath: "/work/gateway.toml",
    });
    expect(parseCompatArgs(["review", "promote", "v2|key", "text", "--reviewer", "owner"])).toMatchObject({
      kind: "review", decision: "promote", claimKey: "v2|key", feature: "text", reviewer: "owner",
    });
    expect(parseCompatArgs(["quarantine", "v2|key", "text", "--reason", "strong-reproducible-failure"])).toMatchObject({
      kind: "quarantine", claimKey: "v2|key", feature: "text", reason: "strong-reproducible-failure",
    });
    expect(parseCompatArgs(["lift", "v2|key", "text", "--by", "qa"])).toMatchObject({ kind: "lift", claimKey: "v2|key", feature: "text", by: "qa" });
    expect(parseCompatArgs(["explain", "codex", "gpt-5.4"])).toMatchObject({ kind: "explain", provider: "codex", model: "gpt-5.4" });
    expect(() => parseCompatArgs(["fly"])).toThrow(/compat requires/);
    expect(() => parseCompatArgs(["review", "promote", "k", "nope"])).toThrow(/Unknown claim feature/);
    expect(() => parseCompatArgs(["quarantine", "k", "text"])).toThrow(/--reason/);
  });

  it("promotes a claim only when evidence exists and records the exact evidence revision", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const claim = passedClaim("text");
    await claimStore.writeClaim(claim);
    const { output: stdout, code } = await capture(() => runCompatCommand(
      { kind: "review", decision: "promote", claimKey: claim.claimKey, feature: "text", reviewer: "owner", reason: "layers-a-b-c-pass-review", source: "test" },
      configPath,
    ));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; decision: { decisionRevision: number; evidenceRevision: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.decision.decisionRevision).toBe(1);
    expect(parsed.decision.evidenceRevision).toBe(evidenceRevisionFor(claim));
    const decisions = await new ReviewDecisionStore(controlPlane).decisionsFor(claim.claimKey, "text");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reviewer).toBe("owner");
  });

  it("fails closed when promoting a claim with no evidence", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const { output: stdout, code } = await capture(() => runCompatCommand(
      { kind: "review", decision: "promote", claimKey: "v2|missing", feature: "text", reviewer: "owner", reason: "x", source: "test" },
      configPath,
    ));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "claim-not-found" });
  });

  it("quarantines and lifts an exact claim", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const controlPlane = join(directory, "control-plane");
    const store = new QuarantineStore(controlPlane);
    const claim = passedClaim("text");
    const quarantined = await capture(() => runCompatCommand(
      { kind: "quarantine", claimKey: claim.claimKey, feature: "text", reason: "strong-reproducible-failure", source: "runner-fail-fast" },
      configPath,
    ));
    expect(quarantined.code).toBe(0);
    expect(JSON.parse(quarantined.output)).toMatchObject({ ok: true });
    expect((await store.recordsFor(claim.claimKey, "text")).length).toBe(1);
    const lifted = await capture(() => runCompatCommand(
      { kind: "lift", claimKey: claim.claimKey, feature: "text", by: "qa", reason: "verified-fixed" },
      configPath,
    ));
    expect(lifted.code).toBe(0);
    expect(JSON.parse(lifted.output)).toMatchObject({ ok: true });
    const records = await store.recordsFor(claim.claimKey, "text");
    expect(records[0]?.liftedAt).toBeDefined();
    const noLift = await capture(() => runCompatCommand(
      { kind: "lift", claimKey: claim.claimKey, feature: "text", by: "qa", reason: "again" },
      configPath,
    ));
    expect(noLift.code).toBe(1);
    expect(JSON.parse(noLift.output)).toMatchObject({ ok: false });
  });

  it("explains a target secret-free and reports a clean status", async () => {
    const directory = await temporaryDirectory();
    const configPath = await configPathWithControlPlane(directory);
    const status = await capture(() => runCompatCommand({ kind: "status" }, configPath));
    expect(status.code).toBe(0);
    const statusParsed = JSON.parse(status.output) as { policy: { supportedClientBaseline: string }; reviews: { decisionCount: number }; quarantines: { activeCount: number } };
    expect(statusParsed.policy.supportedClientBaseline).toBeDefined();
    expect(statusParsed.reviews.decisionCount).toBe(0);
    expect(statusParsed.quarantines.activeCount).toBe(0);
    const explanation = await capture(() => runCompatCommand({ kind: "explain", provider: "codex", model: "gpt-5.4", feature: "text" }, configPath));
    expect(explanation.code).toBe(0);
    const parsed = JSON.parse(explanation.output) as { logicalId: string; seedState: string; features: Record<string, { effective: string }> };
    expect(parsed.logicalId).toBe("codex/gpt-5.4");
    expect(parsed.features.text?.effective).toBe("experimental");
    expect(explanation.output).not.toMatch(/"(accessToken|refreshToken|authorization|token|secret|password|email|prompt|response)"/);
    const missing = await capture(() => runCompatCommand({ kind: "explain", provider: "nope", model: "nope" }, configPath));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.output)).toMatchObject({ ok: false, error: "model-not-found" });
  });
});

async function capture(run: () => Promise<number>): Promise<{ output: string; code: number }> {
  const original = console.log;
  let output = "";
  console.log = (message?: unknown): void => {
    output += typeof message === "string" ? message : JSON.stringify(message);
  };
  try {
    const code = await run();
    return { output, code };
  } finally {
    console.log = original;
  }
}
