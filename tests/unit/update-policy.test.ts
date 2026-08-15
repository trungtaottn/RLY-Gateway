import { describe, expect, it } from "vitest";
import {
  launchPolicy,
  majorVersion,
  migrationClassOf,
  migrationPreflight,
  runtimeProtocolCompatible,
  RUNTIME_PROTOCOL_VERSION,
  stateVersionsCompatible,
} from "../../src/runtime/update/policy.js";
import type { UpdateStateRecord } from "../../src/runtime/update/types.js";

function record(state: UpdateStateRecord["state"], pendingVersion?: string): UpdateStateRecord {
  return {
    schemaVersion: 1,
    state,
    currentVersion: "0.1.0",
    ...(pendingVersion === undefined ? {} : { pendingVersion }),
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("update compatibility policy (#73)", () => {
  it("defines the shared management/data protocol version", () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
  });

  it("treats same-major runtime versions as protocol-compatible", () => {
    expect(runtimeProtocolCompatible("0.1.0", "0.1.0")).toBe(true);
    expect(runtimeProtocolCompatible("0.2.0", "0.1.0")).toBe(true);
    expect(runtimeProtocolCompatible("2.5.0", "2.0.1")).toBe(true);
  });

  it("treats different-major versions as incompatible", () => {
    expect(runtimeProtocolCompatible("1.0.0", "0.1.0")).toBe(false);
    expect(runtimeProtocolCompatible("0.1.0", "1.0.0")).toBe(false);
    expect(runtimeProtocolCompatible("3.0.0", "2.9.9")).toBe(false);
  });

  it("parses major version deterministically and rejects garbage", () => {
    expect(majorVersion("2.1.0")).toBe(2);
    expect(majorVersion("2")).toBe(2);
    expect(majorVersion("v3.0.0")).toBe(-1);
    expect(majorVersion("")).toBe(-1);
  });

  it("accepts matching durable state/schema versions", () => {
    expect(stateVersionsCompatible(2, 2)).toBe(true);
    expect(stateVersionsCompatible(2, undefined)).toBe(true); // unknown runtime schema
    expect(stateVersionsCompatible(2, 1)).toBe(false);
  });

  it("allows launches with no update state and outside pending/activating", () => {
    expect(launchPolicy(undefined, "0.1.0", "0.1.0")).toEqual({ allowed: true });
    expect(launchPolicy(record("idle"), "0.1.0", "0.1.0")).toEqual({ allowed: true });
    expect(launchPolicy(record("active"), "0.1.0", "0.1.0")).toEqual({ allowed: true });
    expect(launchPolicy(record("failed"), "1.0.0", "0.1.0")).toEqual({ allowed: true });
  });

  it("allows new launches on a compatible pair while activation is pending", () => {
    expect(launchPolicy(record("pending-activation", "0.2.0"), "0.1.0", "0.1.0")).toEqual({ allowed: true });
    expect(launchPolicy(record("activating", "0.2.0"), "0.1.0", "0.1.0")).toEqual({ allowed: true });
  });

  it("refuses only new launches on an incompatible pair while pending (actionable reason)", () => {
    const decision = launchPolicy(record("pending-activation", "2.0.0"), "2.0.0", "0.1.0");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("update-pending");
    expect(launchPolicy(record("activating", "2.0.0"), "2.0.0", "0.1.0").allowed).toBe(false);
  });

  it("reports runtime-version-mismatch when the CLI version cannot be parsed", () => {
    const decision = launchPolicy(record("pending-activation", "2.0.0"), "unknown", "0.1.0");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("runtime-version-mismatch");
  });

  it("resolves the effective migration class from a manifest (#93)", () => {
    expect(migrationClassOf({ migrationClass: "none" })).toBe("none");
    expect(migrationClassOf({ migrationClass: "backward-compatible-expand" })).toBe("backward-compatible-expand");
    expect(migrationClassOf({ migrationClass: "transactional-replace" })).toBe("transactional-replace");
    expect(migrationClassOf({ migrationClass: "forward-only" })).toBe("forward-only");
    // Legacy binary signal maps to a class: true ⇒ forward-only, false ⇒ backward-compatible-expand.
    expect(migrationClassOf({ migrationForwardOnly: true })).toBe("forward-only");
    expect(migrationClassOf({ migrationForwardOnly: false })).toBe("backward-compatible-expand");
    // Explicit class wins over the legacy signal.
    expect(migrationClassOf({ migrationClass: "none", migrationForwardOnly: true })).toBe("none");
    // Absent signal defaults to the historical rollback-safe class.
    expect(migrationClassOf(undefined)).toBe("backward-compatible-expand");
  });

  it("blocks only forward-only migrations before activation (#93)", () => {
    const blocker = migrationPreflight(record("pending-activation", "2.0.0"), "forward-only");
    expect(blocker).toBeDefined();
    expect(blocker).toContain("forward-only");
    expect(blocker).toContain("2.0.0");
    // Rollback-safe classes pass preflight.
    expect(migrationPreflight(record("pending-activation", "2.0.0"), "none")).toBeUndefined();
    expect(migrationPreflight(record("pending-activation", "2.0.0"), "backward-compatible-expand")).toBeUndefined();
    expect(migrationPreflight(record("pending-activation", "2.0.0"), "transactional-replace")).toBeUndefined();
  });
});
