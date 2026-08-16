import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcquisitionStateStore, MAX_ACQUISITION_LOG_ENTRIES } from "../../src/installer/state.js";
import { stat, readFile } from "node:fs/promises";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-installer-state-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installer acquisition state store (#129)", () => {
  it("starts with no observed channels and a private installer directory", async () => {
    const controlPlane = await directory();
    const store = new AcquisitionStateStore(controlPlane);
    const observed = await store.readObserved();
    expect(observed.schemaVersion).toBe(1);
    expect(observed.channels.beta).toBeUndefined();
    expect(observed.channels.stable).toBeUndefined();
    expect(await store.highestObservedVersion("beta")).toBe(0);
    const details = await stat(store.directory);
    expect(details.mode & 0o777).toBe(0o700);
  });

  it("records monotonic observed versions and never lowers them", async () => {
    const controlPlane = await directory();
    const store = new AcquisitionStateStore(controlPlane);
    await store.recordObserved("beta", 3);
    await store.recordObserved("stable", 1);
    expect(await store.highestObservedVersion("beta")).toBe(3);
    expect(await store.highestObservedVersion("stable")).toBe(1);
    await store.recordObserved("beta", 5);
    await store.recordObserved("beta", 4); // older never lowers
    expect(await store.highestObservedVersion("beta")).toBe(5);
    expect(await store.highestObservedVersion("stable")).toBe(1);
  });

  it("appends secret-free acquisition-log records with a bounded history", async () => {
    const controlPlane = await directory();
    const store = new AcquisitionStateStore(controlPlane);
    const now = new Date().toISOString();
    for (let index = 0; index < MAX_ACQUISITION_LOG_ENTRIES + 5; index += 1) {
      await store.appendAcquisition({
        schemaVersion: 1,
        at: now,
        kind: "update",
        channel: "beta",
        version: `1.0.0-beta.${String(index)}`,
        target: "linux-x64",
        sha256: "a".repeat(64),
        artifactDigest: "b".repeat(64),
        metadataVersion: index + 1,
        verifiedAt: now,
      });
    }
    const log = await store.readLog();
    expect(log.length).toBe(MAX_ACQUISITION_LOG_ENTRIES);
    expect(log[0]?.version).toBe(`1.0.0-beta.${String(MAX_ACQUISITION_LOG_ENTRIES + 5 - MAX_ACQUISITION_LOG_ENTRIES)}`);
  });

  it("records a channel switch explicitly for auditability", async () => {
    const controlPlane = await directory();
    const store = new AcquisitionStateStore(controlPlane);
    const now = new Date().toISOString();
    await store.appendAcquisition({
      schemaVersion: 1,
      at: now,
      kind: "channel-switch",
      channel: "stable",
      previousChannel: "beta",
      version: "1.0.0",
      target: "linux-x64",
      sha256: "a".repeat(64),
      artifactDigest: "b".repeat(64),
      metadataVersion: 2,
      verifiedAt: now,
    });
    const log = await store.readLog();
    expect(log[0]?.kind).toBe("channel-switch");
    expect(log[0]?.previousChannel).toBe("beta");
    expect(log[0]?.channel).toBe("stable");
  });

  it("fails closed to defaults on malformed state files and keeps files private", async () => {
    const controlPlane = await directory();
    const store = new AcquisitionStateStore(controlPlane);
    await store.initialize();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(store.observedPath, "{ not json", { mode: 0o600 });
    expect(await store.readObserved()).toEqual({ schemaVersion: 1, channels: {} });
    await writeFile(store.logPath, "[ { broken }", { mode: 0o600 });
    expect(await store.readLog()).toEqual([]);
    // Valid records are private (0600).
    await store.recordObserved("stable", 1);
    await store.appendAcquisition({
      schemaVersion: 1,
      at: new Date().toISOString(),
      kind: "install",
      channel: "stable",
      version: "1.0.0",
      target: "linux-x64",
      sha256: "a".repeat(64),
      artifactDigest: "b".repeat(64),
      metadataVersion: 1,
      verifiedAt: new Date().toISOString(),
    });
    for (const path of [store.observedPath, store.logPath]) {
      const details = await stat(path);
      expect(details.mode & 0o777).toBe(0o600);
    }
    const contents = await readFile(store.logPath, "utf8");
    expect(contents).not.toMatch(/Bearer|token|api[_-]?key|authorization|@/i);
  });
});
