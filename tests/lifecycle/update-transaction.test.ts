import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { startResidentRuntime, type ResidentRuntimeHandle } from "../../src/runtime/resident-runtime.js";
import { acquireGateway, inspectRuntimeGateway } from "../../src/runtime/gateway-lifecycle.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { runUpdate } from "../../src/runtime/update/lifecycle.js";
import { LocalCandidateInstaller, computeArtifactId } from "../../src/runtime/update/installer.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import type { CandidateManifest, UpdateStateRecord, UpdateTransaction } from "../../src/runtime/update/types.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { ServiceManagerAdapter, ServiceStatus } from "../../src/service-manager/types.js";
import { SCHEMA_V2_VERSION } from "../../src/storage/schema-v2.js";

const directories: string[] = [];
const servers: Server[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function config(port: number, managementPort: number, controlPlaneDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port, managementPort, logLevel: "silent" },
    controlPlane: { dataDirectory: controlPlaneDirectory },
    routes: {},
  });
}

/** Seeds one provider/account/pool/profile so launch sessions can be issued. */
async function seedControlPlane(directory: string): Promise<void> {
  const store = await ControlPlaneStore.open(directory);
  const created = store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: "loopback" }, "cli");
  const first = store.createAccount({ pseudonym: "acct-txn-a", providerId: created.id, credentialHandle: "env:OPENROUTER_API_KEY" }, "cli");
  const ready = store.bindCredential(first.id, first.version, { credentialHandle: "env:OPENROUTER_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
  const pool = store.createPool({ name: "txn-pool", providerId: created.id, strategy: "fill-first", retryBudget: 1, accountIds: [ready.id] }, "cli");
  store.createProfile({ name: "work", harness: "claude", providerId: created.id, poolId: pool.id, modelRoles: { primary: "openrouter/model-a" } }, "cli");
  store.close();
}

function serverFor(version: string) {
  return (options: Parameters<typeof createGatewayServer>[0]) => createGatewayServer({ ...options, runtimeVersion: version });
}

/** Builds a real immutable candidate directory for the LocalCandidateInstaller. */
async function candidateDir(root: string, version: string, migrationClass = "backward-compatible-expand"): Promise<string> {
  const source = join(root, `candidate-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true, mode: 0o700 });
  await chmod(source, 0o700);
  await chmod(join(source, "dist"), 0o700);
  await chmod(join(source, "dist", "cli"), 0o700);
  await writeFile(join(source, "dist", "cli", "main.js"), `// rly ${version}\n`, "utf8");
  await writeFile(join(source, "rly.json"), `${JSON.stringify({ product: "rly-gateway", version, stateVersion: 2, migrationClass })}\n`, "utf8");
  return source;
}

class FakeServiceManager implements ServiceManagerAdapter {
  platform = "linux" as const;
  serviceName = "rly-gateway";
  restarts = 0;
  starts = 0;
  registers = 0;

  constructor(private readonly onRestart: () => Promise<void>) {}

  isSupported(): boolean { return true; }
  isRegistered(): Promise<boolean> { return Promise.resolve(true); }
  register(): Promise<void> { this.registers += 1; return Promise.resolve(); }
  unregister(): Promise<void> { return Promise.resolve(); }
  start(): Promise<void> { this.starts += 1; return this.onRestart(); }
  restart(): Promise<void> { this.restarts += 1; return this.onRestart(); }
  stop(): Promise<void> { return Promise.resolve(); }
  status(): Promise<ServiceStatus> { return Promise.resolve("running"); }
}

type RuntimeHarness = Readonly<{
  current: ResidentRuntimeHandle;
  restartTo: (version: string) => Promise<void>;
  versionOf: () => Promise<string>;
}>;

async function startHarness(port: number, managementPort: number, runtimeDir: string, controlPlaneDir: string, version = RUNTIME_VERSION): Promise<RuntimeHarness> {
  let current = await startResidentRuntime({
    config: config(port, managementPort, controlPlaneDir),
    runtimeDirectory: runtimeDir,
    controlPlaneDirectory: controlPlaneDir,
    heartbeatMs: 5,
    createServer: serverFor(version),
  });
  const restartTo = async (nextVersion: string): Promise<void> => {
    const old = current;
    await old.shutdown();
    await old.stopped;
    current = await startResidentRuntime({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
      createServer: serverFor(nextVersion),
    });
  };
  const versionOf = async (): Promise<string> => {
    const state = await inspectRuntimeGateway(config(port, managementPort, controlPlaneDir), runtimeDir);
    return state.state === "attested-compatible" ? state.runtimeVersion ?? RUNTIME_VERSION : "down";
  };
  return { current, restartTo, versionOf };
}

async function issueLaunchSession(port: number, managementPort: number, controlPlaneDir: string, runtimeDir: string): Promise<{ token: string; release: () => Promise<void> }> {
  const launcher = await acquireGateway({
    config: config(port, managementPort, controlPlaneDir),
    runtimeDirectory: runtimeDir,
    controlPlaneDirectory: controlPlaneDir,
    heartbeatMs: 5,
  });
  const response = await fetch(`${launcher.baseUrl}/v1/launch-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${launcher.authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ profileName: "work", leaseId: launcher.leaseId }),
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as { token?: string };
  if (typeof payload.token !== "string") throw new Error("launch session did not issue a token");
  return { token: payload.token, release: () => launcher.release() };
}

function tx(phase: UpdateTransaction["phase"], overrides: Partial<UpdateTransaction> = {}): UpdateTransaction {
  return {
    schemaVersion: 1,
    phase,
    startedAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:01.000Z",
    candidateVersion: "2.0.0",
    candidateArtifactId: createHash("sha256").update("2.0.0").digest("hex"),
    previousVersion: "0.1.0",
    previousArtifactId: createHash("sha256").update("0.1.0").digest("hex"),
    rollbackAttempts: 0,
    ...overrides,
  };
}

function record(state: UpdateStateRecord["state"], transaction: UpdateTransaction | undefined, overrides: Partial<UpdateStateRecord> = {}): UpdateStateRecord {
  return {
    schemaVersion: 1,
    state,
    currentVersion: "0.1.0",
    pendingVersion: "2.0.0",
    previousVersion: "0.1.0",
    pendingArtifactId: createHash("sha256").update("2.0.0").digest("hex"),
    previousArtifactId: createHash("sha256").update("0.1.0").digest("hex"),
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...(transaction === undefined ? {} : { transaction }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * #93: the transactional activation journal must make ONE deterministic
 * recovery choice per durable boundary, never guess a candidate committed, and
 * preserve previous/staged/active reference integrity at every crash window.
 */
describe("transactional activation crash recovery (#93, real refs)", () => {
  it("crash before the fence (STAGED) resumes activation without touching refs", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id2 = await computeArtifactId(src2);
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);

    // Crash artifact: STAGED phase, refs untouched (active still the old id).
    await store.write(record("pending-activation", tx("staged", { candidateArtifactId: id2 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("activated");
    expect(result.state).toBe("active");
    expect(await harness.versionOf()).toBe("2.0.0");
    expect(manager.restarts).toBe(1);
    await harness.current.shutdown();
  });

  it("crash mid-switching with refs NOT switched: restores known-good refs with no restart loop", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);

    // Crash artifact: SWITCHING journaled but the ref switch never ran
    // (active still points at the known-good). The old runtime keeps serving.
    await store.write(record("activating", tx("switching", { candidateArtifactId: id2, previousArtifactId: id1 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("0.1.0");
    // The running old runtime already matches the restored known-good: no restart.
    expect(manager.restarts).toBe(0);
    // Reference integrity: active restored to the known-good, aborted candidate
    // preserved as previous (never lost, never silently committed).
    expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id2}`);
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${id2}`);
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);
    await harness.current.shutdown();
  });

  it("crash mid-switching with refs switched: one bounded restart restores the known-good", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    // Crash AFTER the ref switch: active already points at the candidate, the
    // candidate process is serving (probation never verified), and the journal
    // never reached probation/commit.
    await installer.activateStaged();
    await harness.restartTo("2.0.0");
    const manager = new FakeServiceManager(async () => { await harness.restartTo("0.1.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    await store.write(record("activating", tx("switching", { candidateArtifactId: id2, previousArtifactId: id1 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(manager.restarts).toBe(1);
    expect(await harness.versionOf()).toBe("0.1.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id2}`);
    await harness.current.shutdown();
  });

  it("crash during PROBATION while the candidate serves: rolls back, never commits", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    // Crash AFTER the restart: the candidate process is serving (probation
    // never verified) and the refs point at the candidate.
    await installer.activateStaged();
    await harness.restartTo("2.0.0");
    const manager = new FakeServiceManager(async () => { await harness.restartTo("0.1.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    await store.write(record("activating", tx("probation", { candidateArtifactId: id2, previousArtifactId: id1 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("0.1.0");
    // One bounded rollback restart (never a loop); candidate never committed.
    expect(manager.restarts).toBe(1);
    const final = await store.read();
    expect(final?.currentVersion).toBe("0.1.0");
    expect(final?.lastActivationResult?.ok).toBe(false);
    expect(final?.lastRollbackResult?.ok).toBe(true);
    expect(final?.pendingVersion).toBeUndefined();
    expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id2}`);
    await harness.current.shutdown();
  });

  it("crash during COMMITTING rolls back deterministically and never silently commits", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    await installer.activateStaged();
    await harness.restartTo("2.0.0");
    const manager = new FakeServiceManager(async () => { await harness.restartTo("0.1.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    await store.write(record("activating", tx("committing", { candidateArtifactId: id2, previousArtifactId: id1 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("0.1.0");
    const final = await store.read();
    // The candidate is NEVER silently committed: activation result is false.
    expect(final?.lastActivationResult?.ok).toBe(false);
    expect(final?.pendingVersion).toBeUndefined();
    expect(final?.currentVersion).toBe("0.1.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
    await harness.current.shutdown();
  });

  it("a COMMITTED journal is durable evidence: recovery promotes to active without rollback", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id2 = await computeArtifactId(src2);
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const committed = record("active", tx("committed", { candidateArtifactId: id2 }), { currentVersion: "2.0.0", currentArtifactId: id2, pendingVersion: undefined });
    await store.write(committed);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    // Durable commit ⇒ nothing to do; no rollback, no restart.
    expect(result.outcome).toBe("no-candidate");
    expect(result.state).toBe("active");
    expect(manager.restarts).toBe(0);
    await harness.current.shutdown();
  });

  it("rollback failure terminates in RECOVERY_REQUIRED and never loops", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    // Crash mid-probation with the candidate serving; the rollback restart
    // itself fails (the bounded single attempt). Foreign-listener rollback
    // failure is covered by the runtime-update foreign test; here the crash-
    // recovery terminal state and the no-loop guarantee are the contract.
    await installer.activateStaged();
    await harness.restartTo("2.0.0");
    const manager = new FakeServiceManager(async () => {
      throw new Error("service restart failed (simulated crash of the rollback restart)");
    });
    const store = new UpdateStateStore(controlPlaneDir);
    await store.write(record("activating", tx("probation", { candidateArtifactId: id2, previousArtifactId: id1 })));
    const first = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(first.outcome).toBe("failed");
    expect(first.state).toBe("recovery-required");
    expect(first.message).toContain("doctor");
    expect(first.message).toContain("both failed");

    // A second invocation must be terminal: no additional restarts, no loop.
    const before = manager.restarts;
    const second = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(second.outcome).toBe("failed");
    expect(second.state).toBe("recovery-required");
    expect(manager.restarts).toBe(before);
    const final = await store.read();
    expect(final?.state).toBe("recovery-required");
    expect(final?.transaction?.phase).toBe("recovery-required");
    expect(final?.failureReason).toContain("doctor");
    await harness.current.shutdown();
  });

  it("an interrupted ROLLING_BACK after the bounded attempt is terminal recovery-required", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    const manager = new FakeServiceManager(async () => { await harness.restartTo("0.1.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    // Crash artifact: a rollback was in flight with the bounded attempt already
    // consumed (rollbackAttempts=1) ⇒ a second rollback is never started.
    await store.write(record("rollback-required", tx("rolling-back", { candidateArtifactId: id2, previousArtifactId: id1, rollbackAttempts: 1 })));
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("failed");
    expect(result.state).toBe("recovery-required");
    expect(result.message).toContain("doctor");
    expect(manager.restarts).toBe(0);
    await harness.current.shutdown();
  });

  it("preserves known-good refs across an interrupted activation and a full recovery cycle", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    const id2 = await computeArtifactId(src2);
    // Mid-switch crash state: active points at the candidate, previous at the
    // known-good (activateStaged completed) — the displaced known-good must
    // never be lost before commit.
    await installer.activateStaged();
    const store = new UpdateStateStore(controlPlaneDir);
    await store.write(record("activating", tx("switching", { candidateArtifactId: id2, previousArtifactId: id1 })));
    // A reader at this boundary sees a valid active ref (candidate) and a
    // valid previous ref (known-good) — never a missing/gapped state.
    expect(await readlink(installer.activePath)).toBe(`../versions/${id2}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id1}`);
    // Recovery rolls back and the known-good deployment is intact.
    const manager = new FakeServiceManager(async () => { await harness.restartTo("0.1.0"); });
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id2}`);
    // A subsequent update with a healthy candidate activates normally.
    const src3 = await candidateDir(root, "3.0.0");
    await installer.installCandidate({ version: "3.0.0", sourceDirectory: src3 });
    const id3 = await computeArtifactId(src3);
    const manager2 = new FakeServiceManager(async () => { await harness.restartTo("3.0.0"); });
    const again = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager2,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      candidate: { version: "3.0.0", sourceDirectory: src3 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(again.outcome).toBe("activated");
    expect(await harness.versionOf()).toBe("3.0.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${id3}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${id1}`);
    await harness.current.shutdown();
  });
});

/**
 * #93: migration compatibility classes gate activation BEFORE any destructive
 * state change; the fence refuses new issuance once draining begins while
 * existing sessions complete on the old runtime.
 */
describe("transactional activation gates (#93)", () => {
  const runWithManifest = async (migrationClass: CandidateManifest["migrationClass"], expected: string): Promise<void> => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const id1 = await computeArtifactId(src1);
    const src2 = await candidateDir(root, "2.0.0", migrationClass ?? "backward-compatible-expand");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id2 = await computeArtifactId(src2);
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    if (expected === "blocked") {
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("forward-only");
      // Preflight blocks BEFORE any destructive activation: active ref and the
      // serving runtime are untouched.
      expect(await readlink(installer.activePath)).toBe(`../versions/${id1}`);
      expect(await readlink(installer.stagedPath)).toBe(`../versions/${id2}`);
      expect(manager.restarts).toBe(0);
      expect(await harness.versionOf()).toBe(RUNTIME_VERSION);
    } else {
      expect(result.outcome).toBe("activated");
      expect(await harness.versionOf()).toBe("2.0.0");
    }
    await harness.current.shutdown();
  };

  it("blocks a forward-only migration before destructive activation", async () => {
    await runWithManifest("forward-only", "blocked");
  });

  it("activates a backward-compatible-expand migration", async () => {
    await runWithManifest("backward-compatible-expand", "activated");
  });

  it("activates a transactional-replace migration", async () => {
    await runWithManifest("transactional-replace", "activated");
  });

  it("activates a none migration", async () => {
    await runWithManifest("none", "activated");
  });

  it("activates a legacy binary migrationForwardOnly:false candidate (legacy class mapping)", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    const root = await temporaryDirectory("rly-txn-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    // Rewrite the manifest with only the legacy signal (no migrationClass).
    await writeFile(join(src2, "rly.json"), `${JSON.stringify({ product: "rly-gateway", version: "2.0.0", stateVersion: 2, migrationForwardOnly: false })}\n`, "utf8");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(result.outcome).toBe("activated");
    await harness.current.shutdown();
  });

  it("the fence refuses new launch issuance once draining begins while existing sessions complete", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-txn-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-txn-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const session = await issueLaunchSession(port, managementPort, controlPlaneDir, runtimeDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const root = await temporaryDirectory("rly-txn-candidates-");
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    // Activation begins: the fence is established BEFORE the drain wait.
    const pending = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      drainTimeoutMs: 300,
      drainPollMs: 50,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(pending.outcome).toBe("pending");
    expect(pending.phase).toBe("draining");
    expect(manager.restarts).toBe(0);
    // Fence: a NEW launch session is refused with the actionable policy error.
    const launcher = await acquireGateway({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
    });
    const refused = await fetch(`${launcher.baseUrl}/v1/launch-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${launcher.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ profileName: "work", leaseId: launcher.leaseId }),
    });
    expect(refused.status).toBe(409);
    // The existing session keeps working on the old runtime (authorized).
    const roundTrip = await fetch(`http://127.0.0.1:${String(port)}/v1/route-traces`, {
      headers: { "x-api-key": session.token },
      signal: AbortSignal.timeout(2_000),
    });
    expect(roundTrip.status).toBe(200);
    await launcher.release();
    await session.release();
    // Drain completes ⇒ the transaction activates.
    const activated = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: { serviceName: "rly-gateway", executable: "/usr/bin/node", entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"), configPath: "/work/gateway.config.toml" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V2_VERSION,
    });
    expect(activated.outcome).toBe("activated");
    expect(activated.phase).toBe("committed");
    // The old session token is never replayed onto the new runtime.
    const oldToken = await fetch(`http://127.0.0.1:${String(port)}/v1/route-traces`, {
      headers: { "x-api-key": session.token },
      signal: AbortSignal.timeout(2_000),
    });
    expect(oldToken.status).toBe(401);
    await harness.current.shutdown();
  });
});

/**
 * #93: a second live updater can never reclaim a lock held by a live process
 * with the same real OS process-start identity; only a proven stale/dead owner
 * is reclaimed — never from PID or wall-clock evidence alone.
 */
describe("update lock ownership (#93)", () => {
  it("records the real process-start identity and keeps a same-process holder alive", async () => {
    const controlPlaneDir = await temporaryDirectory("rly-txn-lock-");
    const fixedStart = "2026-08-13T00:00:00.000Z";
    const store = new UpdateStateStore(controlPlaneDir, async () => ({ processStartedAt: fixedStart }));
    const lock = await store.acquireLock();
    const contents = await (await import("node:fs/promises")).readFile(join(controlPlaneDir, "update.lock"), "utf8");
    const parsed = JSON.parse(contents) as { owner: { pid: number; processStartedAt: string; identityVerified?: boolean } };
    expect(parsed.owner.pid).toBe(process.pid);
    expect(parsed.owner.processStartedAt).toBe(fixedStart);
    expect(parsed.owner.identityVerified).toBe(true);
    // A second acquire in the same process cannot reclaim the live lock.
    await expect(store.acquireLock()).rejects.toThrow(/already in progress/);
    await lock.release();
    const status = await store.lockStatus();
    expect(status.held).toBe(false);
  });

  it("never reclaims a live foreign lock whose identity matches, regardless of pid", async () => {
    const controlPlaneDir = await temporaryDirectory("rly-txn-lock-");
    const start = "2026-08-13T00:00:00.000Z";
    const store = new UpdateStateStore(controlPlaneDir, async (pid) => (pid === 42_424 ? { processStartedAt: start } : undefined));
    const { writePrivateTextAtomically } = await import("../../src/storage/private-files.js");
    await writePrivateTextAtomically(join(controlPlaneDir, "update.lock"), `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000093",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 42_424, processStartedAt: start, identityVerified: true },
    })}\n`);
    // The owner process is alive with the SAME start identity ⇒ held.
    await expect(store.acquireLock()).rejects.toThrow(/already in progress/);
  });

  it("reclaims only a lock whose owner identity is proven stale/dead", async () => {
    const controlPlaneDir = await temporaryDirectory("rly-txn-lock-");
    const store = new UpdateStateStore(controlPlaneDir, async (pid) => (pid === 42_424 ? undefined : { processStartedAt: "2026-08-13T00:00:00.000Z" }));
    const { writePrivateTextAtomically } = await import("../../src/storage/private-files.js");
    // Dead owner: the pid is no longer in the process table ⇒ reclaimable.
    await writePrivateTextAtomically(join(controlPlaneDir, "update.lock"), `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000093",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 42_424, processStartedAt: "2020-01-01T00:00:00.000Z", identityVerified: true },
    })}\n`);
    const lock = await store.acquireLock();
    await lock.release();
    // An unverifiable (wall-clock fallback) owner is conservatively held and
    // never reclaimed from a mismatched timestamp alone.
    await writePrivateTextAtomically(join(controlPlaneDir, "update.lock"), `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000093",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 42_424, processStartedAt: "2020-01-01T00:00:00.000Z", identityVerified: false },
    })}\n`);
    await expect(store.acquireLock()).rejects.toThrow(/already in progress/);
  });
});
