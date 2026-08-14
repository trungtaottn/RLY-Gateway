import { describe, expect, it } from "vitest";
import { classifyVerdict, requiredGatesFor } from "../../src/canary/classify.js";
import { runGateMatrix } from "../../src/canary/matrix.js";
import { proposeCanaryState, verdictToCompatibilityState } from "../../src/canary/proposals.js";
import { adapterIdForProvider, runCanary } from "../../src/canary/run.js";
import type { CanaryEvidence, CanaryGateResult } from "../../src/canary/types.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { directProviderRegistry, findModelEvidence, reviewedModel } from "../../src/registry/model-registry.js";

function gateResult(gate: CanaryGateResult["gate"], status: CanaryGateResult["status"], reason?: string): CanaryGateResult {
  return Object.freeze({ gate, status, ...(reason === undefined ? {} : { reason }) });
}

function evidenceFor(
  providerId: string,
  modelId: string,
  verdict: CanaryEvidence["verdict"],
  overrides: Partial<CanaryEvidence> = {},
): CanaryEvidence {
  const evidence = findModelEvidence(directProviderRegistry, providerId, modelId);
  if (evidence === undefined) throw new Error(`No registry evidence for ${providerId}/${modelId}`);
  return Object.freeze({
    client: "claude-code",
    clientVersion: CLAUDE_CODE_CONTRACT.baseline,
    accessProviderId: providerId,
    adapterId: adapterIdForProvider(providerId),
    physicalModelId: modelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
    fixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    testedGates: [],
    checkedAt: "1970-01-01T00:00:00.000Z",
    evidenceKind: "fake",
    verdict,
    ...overrides,
  });
}

describe("canary evidence and classification (#24)", () => {
  it("classifies all-required-passed + fake-only as EXPERIMENTAL (never VERIFIED without live proof)", () => {
    const required = requiredGatesFor({
      capabilities: { tools: true, parallelTools: false, reasoning: true },
      reasoning: { reasoningWithTools: false },
    });
    const results = required.map((gate) => gateResult(gate as CanaryGateResult["gate"], "passed"));
    const classified = classifyVerdict({ results, requiredGates: required, adapterId: "codex-oauth", livePassed: false, fakeMatrixRan: true });
    expect(classified.verdict).toBe("EXPERIMENTAL");
    expect(classified.reason).toBe("live-evidence-required");
  });

  it("classifies VERIFIED only when live evidence passed for a live-required adapter", () => {
    const required = requiredGatesFor({
      capabilities: { tools: true, parallelTools: false, reasoning: true },
      reasoning: { reasoningWithTools: false },
    });
    const results = required.map((gate) => gateResult(gate as CanaryGateResult["gate"], "passed"));
    const classified = classifyVerdict({ results, requiredGates: required, adapterId: "codex-oauth", livePassed: true, fakeMatrixRan: true });
    expect(classified.verdict).toBe("VERIFIED");
  });

  it("classifies BROKEN when a required gate fails with the typed reason", () => {
    const classified = classifyVerdict({
      results: [
        gateResult("text", "passed"),
        gateResult("model-discovery", "failed", "gateway-model-filter-changed"),
      ],
      requiredGates: ["text", "model-discovery"],
      adapterId: "openrouter-direct",
      livePassed: true,
      fakeMatrixRan: true,
    });
    expect(classified.verdict).toBe("BROKEN");
    expect(classified.reason).toBe("gateway-model-filter-changed");
  });

  it("never reports missing/unrun required gates as passed (unknown, not VERIFIED)", () => {
    const classified = classifyVerdict({
      results: [gateResult("text", "passed"), gateResult("streaming", "not-run", "no-streaming-evidence")],
      requiredGates: ["text", "streaming"],
      adapterId: "codex-oauth",
      livePassed: true,
      fakeMatrixRan: true,
    });
    expect(classified.verdict).toBe("unknown");
  });

  it("does not advertise reasoning+tools without reasoningWithTools evidence", () => {
    const required = requiredGatesFor({
      capabilities: { tools: true, parallelTools: false, reasoning: true },
      reasoning: { reasoningWithTools: false },
    });
    expect(required).not.toContain("reasoning-tools");
    expect(required).toContain("tools-multi");
  });

  it("keys evidence by exact client + provider + adapter + physical model, never upstream name alone", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const codexSol = summary.results.find((result) => result.accessProviderId === "codex" && result.physicalModelId === "gpt-5.6-sol");
    const clineSol = summary.results.find((result) => result.accessProviderId === "cline" && result.physicalModelId === "gpt-5.6-sol");
    expect(codexSol).toBeUndefined(); // gpt-5.6-sol is only a ClinePass aggregator fixture
    const clineTerra = summary.results.find((result) => result.accessProviderId === "cline" && result.physicalModelId === "gpt-5.6-terra");
    expect(clineSol).toBeDefined();
    expect(clineTerra).toBeDefined();
    expect(clineSol?.adapterId).toBe("cline-interop");
    expect(clineSol?.clientVersion).toBe(CLAUDE_CODE_CONTRACT.baseline);
    expect(clineSol?.testedGates.length).toBeGreaterThan(0);
    // Distinct access paths stay distinct evidence records.
    const ids = new Set(summary.results.map((result) => `${result.accessProviderId}/${result.physicalModelId}`));
    expect(ids.size).toBe(summary.results.length);
  });

  it("proposes canary state without ever mutating the trusted registry", () => {
    const proposal = proposeCanaryState(evidenceFor("codex", "gpt-5.4", "VERIFIED"), directProviderRegistry);
    expect(proposal).toBeDefined();
    expect(proposal?.currentState).toBe("EXPERIMENTAL");
    expect(proposal?.proposedState).toBe("VERIFIED");
    expect(proposal?.accessProviderId).toBe("codex");
    expect(proposal?.physicalModelId).toBe("gpt-5.4");
    // The trusted document is byte-identical after proposal.
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-5.4")?.compatibility.state).toBe("EXPERIMENTAL");
  });

  it("never proposes BROKEN/unreviewed evidence onto an unverified access path", () => {
    expect(verdictToCompatibilityState("unknown")).toBeUndefined();
    expect(proposeCanaryState(evidenceFor("codex", "gpt-5.4", "unknown"), directProviderRegistry)).toBeUndefined();
    expect(verdictToCompatibilityState("BROKEN")).toBe("BROKEN");
  });

  it("evaluates every trusted access path deterministically (same inputs → same results)", async () => {
    const first = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const second = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    expect(first.results.length).toBe(second.results.length);
    for (let index = 0; index < first.results.length; index += 1) {
      expect(first.results[index]).toEqual(second.results[index]);
    }
  });

  it("keeps registry provenance: reviewedModel entries carry typed baseline/evidenceRef", () => {
    const model = reviewedModel({
      accessProviderId: "openrouter",
      upstreamModelId: "nvidia/nemotron-3.5-lightning:free",
      modelFamily: "nvidia",
      verifiedAt: "2026-08-13",
      fixtureVersion: "openai-chat-v1",
      capabilities: { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" },
    });
    expect(model.compatibility.state).toBe("EXPERIMENTAL");
    expect(model.compatibility.baseline).toBe("claude-code-fake-upstream");
  });

  it("still exercises the real gate matrix for a registry entry (executable protocol evidence)", () => {
    const evidence = findModelEvidence(directProviderRegistry, "codex", "gpt-5.4");
    if (evidence === undefined) throw new Error("missing fixture");
    const results = runGateMatrix({
      clientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      accessProviderId: "codex",
      adapterId: "codex-oauth",
      physicalModelId: "gpt-5.4",
      evidence,
      contract: CLAUDE_CODE_CONTRACT,
    });
    expect(results.filter((result) => result.status === "passed").length).toBeGreaterThan(8);
  });
});
