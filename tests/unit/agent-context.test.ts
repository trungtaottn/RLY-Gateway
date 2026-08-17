import { describe, expect, it } from "vitest";
import { parseAgentContext, agentPseudonym } from "../../src/core/agent-context.js";
import { AgentExecutionContextRegistry, type ExecutionContext } from "../../src/profiles/agent-contexts.js";

function session(leaseId = "lease-1") {
  return {
    profileId: "profile-1",
    profileName: "clinepass",
    leaseId,
    viewId: "a1b2c3d4e5f60718",
    modelUniverse: { policyRevision: 1, policyHash: "h", registryRevision: 4, bindings: [], experimentalModels: false } as const,
    binding: {
      profile: { id: "profile-1", name: "clinepass", harness: "claude" as const, modelRoles: {}, capabilityPolicy: undefined, launchPolicy: undefined },
      pool: { id: "pool-1", name: "pool", providerId: "prov-1", strategy: "fill-first", retryBudget: 0, affinity: undefined, memberships: [] },
      provider: { id: "prov-1", name: "cline", integrationMode: "direct" as const, endpointPolicy: undefined, enabled: true },
    },
  };
}

function context(input: Partial<Omit<ExecutionContext, "leaseId" | "profileId" | "profileName">>): Parameters<AgentExecutionContextRegistry["record"]>[1] {
  return {
    claudeSessionId: "session-a",
    agentId: "main-agent",
    role: "main",
    accessProviderId: "cline",
    resolvedModelId: "gpt-5.6-terra",
    modelFamily: "openai/codex",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...input,
  };
}

describe("Claude Code agent attribution parsing (#71)", () => {
  it("parses the supported attribution headers case-insensitively", () => {
    const parsed = parseAgentContext({
      "x-claude-code-session-id": "session-1",
      "x-claude-code-agent-id": "kongming",
      "x-claude-code-parent-agent-id": "main",
    });
    expect(parsed).toEqual({ claudeSessionId: "session-1", agentId: "kongming", parentAgentId: "main" });
    // Exact-case header objects (contract fixtures) are also accepted.
    const exactCase = parseAgentContext({
      "X-Claude-Code-Session-Id": "session-1",
      "X-Claude-Code-Agent-Id": "kongming",
      "X-Claude-Code-Parent-Agent-Id": "main",
    });
    expect(exactCase).toEqual(parsed);
  });

  it("returns undefined when no attribution header is present", () => {
    expect(parseAgentContext({ authorization: "Bearer token", "x-api-key": "key" })).toBeUndefined();
    expect(parseAgentContext()).toBeUndefined();
    expect(parseAgentContext({ "x-claude-code-session-id": "" })).toBeUndefined();
  });

  it("supports partial attribution (agent id without parent)", () => {
    const parsed = parseAgentContext({ "x-claude-code-agent-id": "main" });
    expect(parsed).toEqual({ agentId: "main" });
  });

  it("produces stable allowlisted pseudonyms and never the raw id", () => {
    const first = agentPseudonym("session-1");
    expect(first).toBe(agentPseudonym("session-1"));
    expect(first).not.toBe("session-1");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(agentPseudonym("session-1")).not.toBe(agentPseudonym("session-2"));
  });

  it("filters empty values from repeated headers", () => {
    const parsed = parseAgentContext({ "x-claude-code-agent-id": ["", "kongming", ""] });
    expect(parsed).toEqual({ agentId: "kongming" });
  });
});

describe("session-scoped execution-context registry (#71)", () => {
  it("records and resolves contexts while the owning lease is active", () => {
    let active = true;
    const registry = new AgentExecutionContextRegistry(() => active);
    const owner = session("lease-1");
    registry.record(owner, context({ agentId: "main-agent", role: "main" }));
    registry.record(owner, context({ agentId: "kongming", parentAgentId: "main-agent", role: "subagent" }));
    expect(registry.resolve(owner, "session-a", "main-agent")?.resolvedModelId).toBe("gpt-5.6-terra");
    expect(registry.resolve(owner, "session-a", "kongming")?.parentAgentId).toBe("main-agent");
    expect(registry.size()).toBe(2);
    active = false;
    expect(registry.resolve(owner, "session-a", "main-agent")).toBeUndefined();
    expect(registry.mainContext(owner, "session-a")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("keeps sessions and agents isolated (no context leakage)", () => {
    const registry = new AgentExecutionContextRegistry();
    const owner = session("lease-1");
    const other = session("lease-2");
    registry.record(owner, context({ claudeSessionId: "session-a", agentId: "kongming", role: "subagent" }));
    registry.record(other, context({ claudeSessionId: "session-b", agentId: "main-agent", role: "main" }));
    expect(registry.resolve(owner, "session-b", "main-agent")).toBeUndefined();
    expect(registry.resolve(other, "session-a", "kongming")).toBeUndefined();
    // Same agent id under a different Claude session stays separate.
    expect(registry.resolve(owner, "session-a", "main-agent")).toBeUndefined();
    expect(registry.contextsForSession(owner, "session-a")).toHaveLength(1);
  });

  it("drops all contexts when the owning lease is revoked", () => {
    const registry = new AgentExecutionContextRegistry();
    const owner = session("lease-1");
    const other = session("lease-2");
    registry.record(owner, context({ agentId: "main-agent", role: "main" }));
    registry.record(other, context({ agentId: "main-agent", role: "main" }));
    registry.dropLease("lease-1");
    expect(registry.size()).toBe(1);
    expect(registry.resolve(owner, "session-a", "main-agent")).toBeUndefined();
    expect(registry.resolve(other, "session-a", "main-agent")?.profileName).toBe("clinepass");
  });

  it("returns the session's main context and per-session listings", () => {
    const registry = new AgentExecutionContextRegistry();
    const owner = session("lease-1");
    registry.record(owner, context({ agentId: "main-agent", role: "main" }));
    registry.record(owner, context({ agentId: "kongming", parentAgentId: "main-agent", role: "subagent" }));
    expect(registry.mainContext(owner, "session-a")?.agentId).toBe("main-agent");
    expect(registry.contextsForSession(owner, "session-a").map((entry) => entry.agentId)).toEqual(["main-agent", "kongming"]);
  });

  it("never records without an active lease and never stores identity", () => {
    const registry = new AgentExecutionContextRegistry(() => false);
    registry.record(session("lease-1"), context({ agentId: "kongming", role: "subagent" }));
    expect(registry.size()).toBe(0);
    const serialized = JSON.stringify(registry.contextsForSession(session("lease-1"), "session-a"));
    expect(serialized).not.toMatch(/accessToken|refreshToken|authorization|token|secret|password|email|prompt|response|identity/i);
  });
});
