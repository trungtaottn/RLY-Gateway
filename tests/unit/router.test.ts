import { describe, expect, it } from "vitest";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../../src/core/router.js";

const route: RouteRecord = {
  role: "primary",
  providerId: "test-provider",
  modelId: "test-model",
  adapterId: "test-adapter",
  credentialRef: { kind: "env", name: "TEST_PROVIDER_KEY" },
  capabilities: {
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: false,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "unsupported",
  },
};

describe("decideRoute", () => {
  it("creates an immutable request-scoped decision", () => {
    const decision = decideRoute({
      requestId: "request-1",
      route,
      required: ["streaming", "tools"],
      configFingerprint: "a".repeat(64),
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(decision.sourceRule).toBe("role:primary");
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.capabilitySnapshot)).toBe(true);
  });

  it("rejects required unsupported semantics", () => {
    expect(() => decideRoute({
      requestId: "request-2",
      route,
      required: ["images", "reasoning"],
      configFingerprint: "b".repeat(64),
    })).toThrow(UnsupportedRouteError);
  });
});

