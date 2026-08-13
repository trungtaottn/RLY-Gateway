import { describe, expect, it } from "vitest";
import {
  canReuseInstance,
  matchesProcessIdentity,
  ownershipRecordSchema,
} from "../../src/runtime/ownership-record.js";

const record = ownershipRecordSchema.parse({
  pid: 1234,
  processStartedAt: "2026-08-13T00:00:00.000Z",
  instanceId: "00000000-0000-4000-8000-000000000001",
  port: 17871,
  executableFingerprint: "a".repeat(64),
  configFingerprint: "b".repeat(64),
  nonceHash: "c".repeat(64),
  ownerLauncherPid: 1200,
  leases: [],
});

describe("ownership record", () => {
  it("reuses only an exact attested identity", () => {
    expect(canReuseInstance(record, record)).toBe(true);
    expect(canReuseInstance(record, { ...record, configFingerprint: "d".repeat(64) })).toBe(false);
    expect(canReuseInstance(record, { ...record, processStartedAt: "2026-08-13T00:00:01.000Z" })).toBe(false);
  });

  it("rejects PID reuse when process start evidence differs", () => {
    expect(matchesProcessIdentity(record, { pid: record.pid, processStartedAt: record.processStartedAt })).toBe(true);
    expect(matchesProcessIdentity(record, { pid: record.pid, processStartedAt: "2026-08-13T00:00:01.000Z" })).toBe(false);
    expect(matchesProcessIdentity(record, undefined)).toBe(false);
  });
});
