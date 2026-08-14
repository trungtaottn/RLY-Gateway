import { describe, expect, it } from "vitest";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { createDecisionTrace } from "../../src/routing/eligibility/trace.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";

describe("profile diagnostic privacy", () => {
  it("rejects traces that carry forbidden keys and keeps listed traces secret-free", () => {
    const ring = new RouteTraceRing(2);
    const trace = createDecisionTrace({
      requestId: "req-1",
      policyRevision: 1,
      policyHash: "a".repeat(64),
      strategy: "fill-first",
      sourceRule: "pool:fill-first",
      candidates: [{ accountPseudonym: "acct-fixture", eligible: true, reasons: [] }],
      selected: { accountPseudonym: "acct-fixture", credentialGeneration: 1 },
      decidedAt: "2026-08-14T00:00:00.000Z",
    });
    ring.push(trace, "work");
    const listed = ring.list("work");
    assertSecretFree(listed);
    expect(JSON.stringify(listed)).not.toMatch(/accessToken|refreshToken|authorization|email|prompt|response/i);
    expect(() => ring.push({
      ...trace,
      // @ts-expect-error privacy invariant
      prompt: "secret-prompt",
    }, "work")).toThrow(/secret or identity/);
  });

  it("keeps Claude Code agent linkage pseudonym-only (#71)", () => {
    const ring = new RouteTraceRing(2);
    const trace = createDecisionTrace({
      requestId: "req-2",
      policyRevision: 1,
      policyHash: "b".repeat(64),
      strategy: "fill-first",
      sourceRule: "pool:fill-first",
      candidates: [{ accountPseudonym: "acct-fixture", eligible: true, reasons: [] }],
      selected: { accountPseudonym: "acct-fixture", credentialGeneration: 1 },
      decidedAt: "2026-08-25T00:00:00.000Z",
    });
    ring.push(trace, "work", undefined, undefined, undefined, {
      claudeSessionPseudonym: "a1b2c3d4e5f60718",
      agentPseudonym: "f6e5d4c3b2a19087",
      parentAgentPseudonym: "1122334455667788",
      contextSource: "parent-agent",
      parentModelId: "gpt-5.6-terra",
      parentModelFamily: "openai/codex",
    });
    const stored = ring.list("work")[0] as { agentLinkage?: { claudeSessionPseudonym?: string } } | undefined;
    expect(stored).toBeDefined();
    if (stored === undefined) throw new Error("missing trace");
    assertSecretFree(stored);
    const serialized = JSON.stringify(stored);
    expect(serialized).toContain("agentLinkage");
    // Raw agent/session ids and forbidden content never appear.
    expect(serialized).not.toMatch(/session-1|kongming|main|accessToken|refreshToken|authorization|email|prompt|response|identity/i);
    expect(stored.agentLinkage?.claudeSessionPseudonym).toMatch(/^[0-9a-f]{16}$/);  });
});
