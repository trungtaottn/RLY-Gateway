import { describe, expect, it } from "vitest";
import { activateProfile } from "../../src/profiles/activate.js";
import { ProfileActivationError } from "../../src/profiles/errors.js";
import { helperRoleFor, resolveProfileRole } from "../../src/profiles/helper-map.js";
import { parseLaunchPolicy } from "../../src/profiles/schema.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import type { ProfileRecord } from "../../src/control-plane/types.js";

const capabilities = {
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate" as const,
};

function profile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "work",
    harness: "claude",
    providerId: "00000000-0000-4000-8000-000000000002",
    poolId: "00000000-0000-4000-8000-000000000003",
    modelRoles: {
      primary: "nvidia/nemotron-3.5-lightning:free",
      fast: "nvidia/nemotron-nano-12b-v2-vl:free",
    },
    capabilityPolicy: undefined,
    launchPolicy: undefined,
    version: 1,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("profile activation", () => {
  it("maps helper models onto profile roles without selecting an account", () => {
    expect(helperRoleFor("claude-haiku-4-5")).toBe("fast");
    expect(resolveProfileRole("claude-sonnet-5", profile().modelRoles)).toEqual({
      role: "primary",
      modelId: "nvidia/nemotron-3.5-lightning:free",
    });
    const activated = activateProfile([profile()], {
      name: "work",
      requestedModel: "claude-haiku-4-5",
      required: ["tools"],
      baseCapabilities: capabilities,
    });
    expect(activated.poolId).toBe(profile().poolId);
    expect(activated.role).toBe("fast");
    expect(activated.modelId).toBe("nvidia/nemotron-nano-12b-v2-vl:free");
    expect(activated).not.toHaveProperty("accountId");
  });

  it("activates a pre-resolved logical tier target without the role helper (#69)", () => {
    const clinepass = profile({
      name: "clinepass",
      modelRoles: { primary: "gpt-5.6-terra", fable: "gpt-5.6-sol" },
    });
    const activated = activateProfile([clinepass], {
      name: "clinepass",
      requestedModel: "fable",
      required: [],
      baseCapabilities: capabilities,
      resolved: { role: "fable", modelId: "gpt-5.6-sol" },
    });
    expect(activated.role).toBe("fable");
    expect(activated.modelId).toBe("gpt-5.6-sol");
    // Capability policy still applies on the pre-resolved path.
    expect(() => activateProfile([profile({ capabilityPolicy: { tools: false } })], {
      name: "work",
      requestedModel: "fable",
      required: ["tools"],
      baseCapabilities: capabilities,
      resolved: { role: "fable", modelId: "gpt-5.6-sol" },
    })).toThrow(ProfileActivationError);
  });

  it("rejects missing pool, unknown helper, and capability overflow", () => {
    expect(() => activateProfile([profile({ poolId: undefined })], {
      name: "work", requestedModel: "primary", required: [], baseCapabilities: capabilities,
    })).toThrow(ProfileActivationError);
    expect(() => activateProfile([profile()], {
      name: "work", requestedModel: "claude-haiku-unknown", required: [], baseCapabilities: capabilities,
    })).toThrow(ProfileActivationError);
    expect(() => activateProfile([profile({ capabilityPolicy: { tools: false } })], {
      name: "work", requestedModel: "primary", required: ["tools"], baseCapabilities: capabilities,
    })).toThrow(ProfileActivationError);
  });

  it("maps Claude helpers onto Codex model roles without remapping unknown shortcuts", () => {
    const codex = profile({
      name: "codex",
      modelRoles: { primary: "gpt-5.4", fast: "gpt-5.4" },
    });
    expect(resolveProfileRole("claude-haiku-4-5", codex.modelRoles)).toEqual({ role: "fast", modelId: "gpt-5.4" });
    expect(resolveProfileRole("gpt-5.4", codex.modelRoles)).toEqual({ role: "primary", modelId: "gpt-5.4" });
    expect(resolveProfileRole("claude-haiku-unknown", codex.modelRoles)).toBeUndefined();
    expect(() => activateProfile([codex], {
      name: "codex",
      requestedModel: "primary",
      required: ["images"],
      baseCapabilities: { ...capabilities, images: false },
    })).toThrow(ProfileActivationError);
  });

  it("maps Claude helpers onto ClinePass model roles without remapping unknown shortcuts", () => {
    const clinepass = profile({
      name: "clinepass",
      modelRoles: { primary: "claude-sonnet-4-5", fast: "claude-sonnet-4-5" },
    });
    expect(resolveProfileRole("claude-haiku-4-5", clinepass.modelRoles)).toEqual({ role: "fast", modelId: "claude-sonnet-4-5" });
    expect(resolveProfileRole("claude-sonnet-4-5", clinepass.modelRoles)).toEqual({ role: "primary", modelId: "claude-sonnet-4-5" });
    expect(resolveProfileRole("claude-haiku-unknown", clinepass.modelRoles)).toBeUndefined();
    expect(() => activateProfile([clinepass], {
      name: "clinepass",
      requestedModel: "primary",
      required: ["images"],
      baseCapabilities: { ...capabilities, images: false },
    })).toThrow(ProfileActivationError);
  });

  it("keeps launch sessions lease-scoped and account-free", () => {
    const active = new Set(["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"]);
    const registry = new LaunchSessionRegistry((leaseId) => active.has(leaseId));
    const tokenA = registry.issue({ profileId: "p1", profileName: "alpha", leaseId: "00000000-0000-4000-8000-000000000011" });
    const tokenB = registry.issue({ profileId: "p2", profileName: "beta", leaseId: "00000000-0000-4000-8000-000000000012" });
    expect(() => registry.issue({ profileId: "p3", profileName: "dead", leaseId: "00000000-0000-4000-8000-000000000099" })).toThrow("lease-not-active");
    expect(registry.resolve(tokenA)?.profileName).toBe("alpha");
    expect(registry.resolve(tokenB)?.profileName).toBe("beta");
    expect(registry.resolve(tokenA)).not.toHaveProperty("accountId");
    active.delete("00000000-0000-4000-8000-000000000011");
    expect(registry.resolve(tokenA)).toBeUndefined();
    expect(registry.resolve(tokenB)?.profileName).toBe("beta");
    expect(parseLaunchPolicy({ executable: "claude" })).toEqual({ executable: "claude" });
  });
});
