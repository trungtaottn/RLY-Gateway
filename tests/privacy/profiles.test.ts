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
});
