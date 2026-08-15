import { randomBytes, timingSafeEqual } from "node:crypto";
import { RUNTIME_VERSION } from "../gateway-attestation.js";
import { inspectRuntimeGateway, runtimeDirectory, type RuntimeInspection } from "../gateway-lifecycle.js";
import { RuntimeStore } from "../runtime-store.js";
import { createIdentityProof } from "../gateway-server.js";
import type { ServiceManagerAdapter, ServiceDefinitionInput } from "../../service-manager/types.js";
import type { GatewayConfig } from "../../config/schema.js";
import {
  migrationPreflight,
  stateVersionsCompatible,
} from "./policy.js";
import { recoverUpdateState, UpdateStateStore } from "./store.js";
import type { CandidateInstaller, UpdateStateRecord } from "./types.js";

export type UpdateRunResult = Readonly<{
  outcome: "installed" | "activated" | "pending" | "rolled-back" | "failed" | "no-candidate";
  state: UpdateStateRecord["state"];
  currentVersion: string;
  pendingVersion?: string;
  message?: string;
}>;

export type UpdateRuntimeDependencies = Readonly<{
  config: GatewayConfig;
  controlPlaneDirectory: string;
  installer: CandidateInstaller;
  /** Per-user service manager (#33/#34). */
  serviceManager: ServiceManagerAdapter;
  /**
   * Service definition re-registered before the controlled restart so the
   * manager points at the activated candidate entrypoint. When omitted the
   * lifecycle still restarts the registered service (entrypoint unchanged).
   */
  serviceDefinition?: ServiceDefinitionInput;
  /** Verified candidate to install; omitted resumes/reports the pending state. */
  candidate?: Readonly<{ version: string; sourceDirectory: string }>;
  /** Explicit destructive/force path: skip the session-drain wait. */
  force?: boolean;
  runtimeDirectory?: string;
  fetch?: typeof fetch;
  updateStore?: UpdateStateStore;
  cliRuntimeVersion?: string;
  /** Durable state/schema version the CLI understands. */
  cliStateVersion?: number;
  /** Bounded wait for active sessions to drain (ms). */
  drainTimeoutMs?: number;
  drainPollMs?: number;
  /** Bounded wait for the restarted runtime to come up attested (ms). */
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
}>;

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_POLL_MS = 500;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_READINESS_POLL_MS = 250;

export class UpdateRuntimeError extends Error {
  override name = "UpdateRuntimeError";
}

/**
 * Safe zero-downtime update coordinator (#73). Separates candidate
 * installation from activation, drains launch sessions (not TCP counts),
 * restarts through the per-user service manager, verifies the new runtime via
 * the attested identity/readiness handshake, and rolls back to the previous
 * known-good version on activation failure. Fails closed everywhere: a foreign
 * or unattested listener is never signaled, launcher-owned instances are never
 * restarted, and the state machine never loops.
 */
export async function runUpdate(dependencies: UpdateRuntimeDependencies): Promise<UpdateRunResult> {
  const request = dependencies.fetch ?? fetch;
  const store = dependencies.updateStore ?? new UpdateStateStore(dependencies.controlPlaneDirectory);
  const cliStateVersion = dependencies.cliStateVersion;

  const lock = await store.acquireLock();
  try {
    const recovered = recoverUpdateState(await store.read());
    if (recovered !== undefined && recovered.state !== (await store.read())?.state) {
      await store.write(recovered);
    }

    const runtime = await inspectRuntimeGateway(dependencies.config, dependencies.runtimeDirectory, request);
    const runtimeVersion = runtime.state === "attested-compatible" ? runtime.runtimeVersion ?? RUNTIME_VERSION : undefined;
    const record = recovered;

    // No candidate and nothing pending: report the current state.
    if (dependencies.candidate === undefined && (record === undefined || record.state === "idle" || record.state === "active")) {
      return {
        outcome: "no-candidate",
        state: record?.state ?? "idle",
        currentVersion: runtimeVersion ?? record?.currentVersion ?? RUNTIME_VERSION,
        ...(record?.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }),
        message: "no update candidate provided; nothing to activate",
      };
    }

    // Existing pending state resumes activation (crash/reboot recovery, or a
    // previous `rly update` that exited pending while sessions drained).
    const resuming = dependencies.candidate === undefined && record !== undefined && record.state === "pending-activation";
    if (resuming) {
      const verified = await dependencies.installer.verifyCandidate();
      if (!verified.ok) {
        const failed = { ...record, state: "failed" as const, failureReason: `installed candidate failed verification: ${verified.reason ?? "unknown"}; run rly doctor` };
        await store.write(failed);
        return {
          outcome: "failed",
          state: "failed",
          currentVersion: record.currentVersion,
          ...(record.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }),
          message: failed.failureReason,
        };
      }
      return await activate(dependencies, store, record, { runtime, request });
    }

    if (dependencies.candidate === undefined) {
      const message = `update state is ${record?.state ?? "idle"}; a candidate artifact is required for activation (see rly update --help; distribution is #35)`;
      return {
        outcome: record?.state === "rollback-required" ? "failed" : "no-candidate",
        state: record?.state ?? "idle",
        currentVersion: runtimeVersion ?? record?.currentVersion ?? RUNTIME_VERSION,
        ...(record?.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }),
        message,
      };
    }

    // A candidate was requested: separate installation from activation.
    assertUpdateableRuntime(runtime);
    const candidateVersion = dependencies.candidate.version;
    const previousVersion = runtimeVersion ?? record?.currentVersion ?? RUNTIME_VERSION;
    const installing = await store.transitionUnderLock(["none", "idle", "active", "failed", "rollback-required", "pending-activation"], (current) => ({
      schemaVersion: 1 as const,
      state: "installing" as const,
      currentVersion: current?.currentVersion ?? previousVersion,
      pendingVersion: candidateVersion,
      ...(current?.previousVersion === undefined ? {} : { previousVersion: current.previousVersion }),
      updatedAt: new Date().toISOString(),
      ...(current?.lastActivationResult === undefined ? {} : { lastActivationResult: current.lastActivationResult }),
      ...(current?.lastRollbackResult === undefined ? {} : { lastRollbackResult: current.lastRollbackResult }),
    }));

    let installed: { version: string; artifactId: string; previousVersion?: string; previousArtifactId?: string };
    try {
      installed = await dependencies.installer.installCandidate(dependencies.candidate);
    } catch (error) {
      const message = `candidate installation failed: ${errorMessage(error)}; the previous version keeps serving`;
      await store.write({ ...installing, state: "failed", failureReason: message, updatedAt: new Date().toISOString() });
      return { outcome: "failed", state: "failed", currentVersion: installing.currentVersion, pendingVersion: candidateVersion, message };
    }

    const pending: UpdateStateRecord = {
      ...installing,
      state: "pending-activation",
      currentVersion: installing.currentVersion,
      pendingVersion: candidateVersion,
      ...(installed.previousVersion === undefined ? {} : { previousVersion: installed.previousVersion }),
      pendingArtifactId: installed.artifactId,
      ...(installed.previousArtifactId === undefined ? {} : { previousArtifactId: installed.previousArtifactId }),
      updatedAt: new Date().toISOString(),
    };
    await store.write(pending);

    // Preflight migration BEFORE destructive activation: a forward-only
    // candidate must not be activated; the previous version keeps serving.
    // Staging never changed the `active` reference (#92), so there is no
    // install-time reference to restore; the staged deployment remains on
    // disk for diagnosis until a later install replaces it.
    const manifest = await dependencies.installer.readManifest().catch(() => undefined);
    if (manifest !== undefined) {
      const blocker = migrationPreflight(pending, manifest.migrationForwardOnly);
      if (blocker !== undefined) {
        const failed: UpdateStateRecord = { ...pending, state: "failed", failureReason: blocker, updatedAt: new Date().toISOString() };
        await store.write(failed);
        return { outcome: "failed", state: "failed", currentVersion: pending.currentVersion, pendingVersion: candidateVersion, message: blocker };
      }
      if (cliStateVersion !== undefined && !stateVersionsCompatible(cliStateVersion, manifest.stateVersion)) {
        const message = `candidate ${candidateVersion} requires durable state schema ${String(manifest.stateVersion)} but this RLY understands ${String(cliStateVersion)}; update is blocked before activation`;
        await store.write({ ...pending, state: "failed", failureReason: message, updatedAt: new Date().toISOString() });
        return { outcome: "failed", state: "failed", currentVersion: pending.currentVersion, pendingVersion: candidateVersion, message };
      }
    }

    return await activate(dependencies, store, pending, { runtime, request });
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function activate(
  dependencies: UpdateRuntimeDependencies,
  store: UpdateStateStore,
  record: UpdateStateRecord,
  context: Readonly<{
    runtime: RuntimeInspection;
    request: typeof fetch;
  }>,
): Promise<UpdateRunResult> {
  const activating = await store.transitionUnderLock(["pending-activation"], (current) => ({
    ...(current ?? record),
    state: "activating" as const,
    updatedAt: new Date().toISOString(),
  }));

  // Drain: wait for launch sessions (not TCP counts) to reach zero unless the
  // user explicitly requested the destructive/force path. Existing sessions
  // always keep running on the old process while the update waits.
  const alreadyDown = context.runtime.state === "not-running" || context.runtime.state === "stale-record";
  if (!alreadyDown && !dependencies.force) {
    const drained = await waitForSessionDrain(dependencies, context.request);
    if (!drained.drained) {
      // Activation stays pending; sessions keep running. Re-run `rly update`
      // (or `--force`) once the user is ready.
      const pending = await store.transitionUnderLock(["activating"], (current) => ({
        ...(current ?? activating),
        state: "pending-activation" as const,
        updatedAt: new Date().toISOString(),
      }));
      return {
        outcome: "pending",
        state: "pending-activation",
        currentVersion: pending.currentVersion,
        ...(pending.pendingVersion === undefined ? {} : { pendingVersion: pending.pendingVersion }),
        message: `update installed; activation pending drain (${String(drained.activeSessions)} session(s) active). Existing sessions keep running; re-run rly update when they end, or use --force`,
      };
    }
  }

  // Once activation begins, the old runtime must refuse new launch-session
  // issuance before the service-manager restart (best-effort on an attested
  // resident runtime; the restart itself is the bounded close).
  await beginDrain(dependencies, context.request);

  try {
    // INSTALL != ACTIVATE (#92): the atomic `active` ref switch happens here,
    // immediately before the restart that boots the staged deployment. #93
    // will gate this transition transactionally (drain/fence/probation); this
    // track supplies the atomic reference primitive.
    try {
      await dependencies.installer.activateStaged();
    } catch (error) {
      return await rollback(dependencies, store, activating, { restarted: false, reason: `activation reference switch failed: ${errorMessage(error)}`, request: context.request });
    }

    const restarted = await controlledRestart(dependencies, context.request);
    if (!restarted.ok) {
      return await rollback(dependencies, store, activating, { restarted: restarted.restarted, reason: restarted.reason, request: context.request });
    }

    const verified = await verifyCandidateRuntime(dependencies, context.request, activating.pendingVersion);
    if (!verified.ok) {
      return await rollback(dependencies, store, activating, { restarted: true, reason: verified.reason, request: context.request });
    }

    const active = await store.transitionUnderLock(["activating"], (current) => ({
      ...(current ?? activating),
      state: "active" as const,
      currentVersion: activating.pendingVersion ?? (current?.currentVersion ?? activating.currentVersion),
      pendingVersion: undefined,
      ...(activating.pendingArtifactId === undefined ? {} : { currentArtifactId: activating.pendingArtifactId }),
      pendingArtifactId: undefined,
      updatedAt: new Date().toISOString(),
      lastActivationResult: { ok: true, attemptedAt: new Date().toISOString() },
      failureReason: undefined,
    }));
    return {
      outcome: "activated",
      state: "active",
      currentVersion: active.currentVersion,
      message: `runtime activated at version ${active.currentVersion}`,
    };
  } catch (error) {
    return await rollback(dependencies, store, activating, { restarted: true, reason: errorMessage(error), request: context.request });
  }
}

async function waitForSessionDrain(
  dependencies: UpdateRuntimeDependencies,
  request: typeof fetch,
): Promise<{ drained: boolean; activeSessions: number }> {
  const deadline = Date.now() + (dependencies.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  const pollMs = dependencies.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
  for (;;) {
    const activeSessions = await currentActiveSessions(dependencies, request);
    if (activeSessions === 0) return { drained: true, activeSessions: 0 };
    if (Date.now() >= deadline) return { drained: false, activeSessions };
    await sleep(pollMs);
  }
}

async function currentActiveSessions(dependencies: UpdateRuntimeDependencies, request: typeof fetch): Promise<number> {
  const identity = await readRuntimeIdentity(dependencies, request);
  return identity?.activeSessions ?? 0;
}

/** Attested in-process drain request: refuses new issuance on the old runtime. */
async function beginDrain(dependencies: UpdateRuntimeDependencies, request: typeof fetch): Promise<boolean> {
  const state = await inspectRuntimeGateway(dependencies.config, dependencies.runtimeDirectory, request);
  if (state.state !== "attested-compatible" || !state.resident) return false;
  const store = new RuntimeStore(dependencies.runtimeDirectory ?? runtimeDirectoryFor(dependencies));
  const secret = await store.readInstanceSecret();
  if (secret === undefined) return false;
  const baseUrl = `http://${dependencies.config.gateway.host}:${String(dependencies.config.gateway.port)}`;
  const response = await request(`${baseUrl}/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(750),
  });
  return response.ok || response.status === 409;
}

async function controlledRestart(
  dependencies: UpdateRuntimeDependencies,
  request: typeof fetch,
): Promise<{ ok: boolean; restarted: boolean; reason: string }> {
  const state = await inspectRuntimeGateway(dependencies.config, dependencies.runtimeDirectory, request);
  const running = state.state === "attested-compatible" && state.resident;
  if (dependencies.serviceDefinition !== undefined) {
    try {
      await dependencies.serviceManager.register(dependencies.serviceDefinition);
    } catch (error) {
      return { ok: false, restarted: false, reason: `service definition registration failed: ${errorMessage(error)}` };
    }
  }
  try {
    if (running) {
      await dependencies.serviceManager.restart();
    } else {
      await dependencies.serviceManager.start();
    }
  } catch (error) {
    return { ok: false, restarted: running, reason: `service restart failed: ${errorMessage(error)}` };
  }
  return { ok: true, restarted: running, reason: "service restarted" };
}

/**
 * Verifies the activated candidate: attested identity + authenticated
 * readiness + state/schema compatibility + the serving runtime version equals
 * the pending candidate version (never the package version on disk alone).
 */
async function verifyCandidateRuntime(
  dependencies: UpdateRuntimeDependencies,
  request: typeof fetch,
  pendingVersion: string | undefined,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + (dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  const pollMs = dependencies.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
  for (;;) {
    const state = await inspectRuntimeGateway(dependencies.config, dependencies.runtimeDirectory, request);
    if (state.state === "occupied-foreign") {
      return { ok: false, reason: "configured gateway port is owned by a foreign listener after restart; RLY will not signal it (fail closed)" };
    }
    if (state.state === "attested-incompatible") {
      return { ok: false, reason: "restarted runtime is attested but incompatible with the current configuration" };
    }
    if (state.state === "attested-compatible") {
      const identity = await readRuntimeIdentity(dependencies, request);
      if (identity === undefined) {
        return { ok: false, reason: "restarted runtime identity could not be attested" };
      }
      if (pendingVersion !== undefined && identity.runtimeVersion !== pendingVersion) {
        return { ok: false, reason: `serving runtime version ${identity.runtimeVersion ?? "unknown"} does not match the pending candidate ${pendingVersion}` };
      }
      if (dependencies.cliStateVersion !== undefined && !stateVersionsCompatible(dependencies.cliStateVersion, identity.stateVersion)) {
        return { ok: false, reason: `serving runtime state/schema version ${String(identity.stateVersion)} is not compatible with this RLY (${String(dependencies.cliStateVersion)})` };
      }
      const ready = await authenticatedReadiness(dependencies, request);
      if (!ready) return { ok: false, reason: "restarted runtime readiness check failed (management/state open)" };
      return { ok: true, reason: "candidate runtime verified" };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `restarted runtime did not become attested-compatible within the bounded window (state: ${state.state})` };
    }
    await sleep(pollMs);
  }
}

async function authenticatedReadiness(dependencies: UpdateRuntimeDependencies, request: typeof fetch): Promise<boolean> {
  const store = new RuntimeStore(dependencies.runtimeDirectory ?? runtimeDirectoryFor(dependencies));
  const secret = await store.readInstanceSecret();
  if (secret === undefined) return false;
  const baseUrl = `http://${dependencies.config.gateway.host}:${String(dependencies.config.gateway.port)}`;
  try {
    const response = await request(`${baseUrl}/readyz`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readRuntimeIdentity(
  dependencies: UpdateRuntimeDependencies,
  request: typeof fetch,
): Promise<{ runtimeVersion?: string; stateVersion?: number; activeSessions?: number } | undefined> {
  const store = new RuntimeStore(dependencies.runtimeDirectory ?? runtimeDirectoryFor(dependencies));
  const secret = await store.readInstanceSecret();
  if (secret === undefined) return undefined;
  const baseUrl = `http://${dependencies.config.gateway.host}:${String(dependencies.config.gateway.port)}`;
  const challenge = cryptoRandomChallenge();
  try {
    const response = await request(`${baseUrl}/identity?challenge=${challenge}`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return undefined;
    const payload = await response.json() as {
      instanceId?: string;
      configFingerprint?: string;
      runtimeVersion?: string;
      stateVersion?: number;
      activeSessions?: number;
      proof?: string;
    };
    if (payload.proof === undefined || payload.instanceId === undefined || payload.configFingerprint === undefined) return undefined;
    const expected = createIdentityProof(secret, challenge, payload.instanceId, payload.configFingerprint);
    if (!safeHexEqual(payload.proof, expected)) return undefined;
    return {
      ...(payload.runtimeVersion === undefined ? {} : { runtimeVersion: payload.runtimeVersion }),
      ...(payload.stateVersion === undefined ? {} : { stateVersion: payload.stateVersion }),
      ...(payload.activeSessions === undefined ? {} : { activeSessions: payload.activeSessions }),
    };
  } catch {
    return undefined;
  }
}

async function rollback(
  dependencies: UpdateRuntimeDependencies,
  store: UpdateStateStore,
  record: UpdateStateRecord,
  input: Readonly<{ restarted: boolean; reason: string; request: typeof fetch }>,
): Promise<UpdateRunResult> {
  const rolledBack: UpdateStateRecord = {
    ...record,
    state: "rollback-required",
    updatedAt: new Date().toISOString(),
    failureReason: `activation failed: ${input.reason}`,
  };
  await store.write(rolledBack);
  try {
    const restored = await dependencies.installer.restorePrevious();
    if (input.restarted) {
      await dependencies.serviceManager.restart();
      const verified = await verifyCandidateRuntime(dependencies, input.request, restored.version);
      if (!verified.ok) throw new Error(`rollback runtime verification failed: ${verified.reason}`);
    }
    const active = await store.transitionUnderLock(["rollback-required"], (current) => ({
      ...(current ?? rolledBack),
      state: "active" as const,
      currentVersion: restored.version,
      pendingVersion: undefined,
      currentArtifactId: restored.artifactId,
      ...(restored.previousArtifactId === undefined ? {} : { previousArtifactId: restored.previousArtifactId }),
      updatedAt: new Date().toISOString(),
      lastActivationResult: { ok: false, attemptedAt: new Date().toISOString(), reason: input.reason },
      lastRollbackResult: { ok: true, attemptedAt: new Date().toISOString() },
      failureReason: undefined,
    }));
    return {
      outcome: "rolled-back",
      state: "active",
      currentVersion: active.currentVersion,
      message: `activation failed (${input.reason}); rolled back to previous known-good version ${active.currentVersion}`,
    };
  } catch (error) {
    const failed: UpdateStateRecord = {
      ...rolledBack,
      state: "failed",
      updatedAt: new Date().toISOString(),
      failureReason: `activation and rollback both failed: ${input.reason}; ${errorMessage(error)}; run rly doctor`,
    };
    await store.write(failed);
    return {
      outcome: "failed",
      state: "failed",
      currentVersion: rolledBack.currentVersion,
      ...(rolledBack.pendingVersion === undefined ? {} : { pendingVersion: rolledBack.pendingVersion }),
      message: failed.failureReason ?? "activation and rollback both failed; run rly doctor",
    };
  }
}

/** Only attested resident runtimes may be updated/restarted. */
function assertUpdateableRuntime(
  runtime: RuntimeInspection,
): void {
  if (runtime.state === "occupied-foreign") {
    throw new UpdateRuntimeError("configured gateway or management port is owned by a foreign listener; refusing to update it (fail closed). Run rly doctor");
  }
  if (runtime.state === "attested-incompatible") {
    throw new UpdateRuntimeError("configured gateway listener is attested but incompatible; align the configuration before updating");
  }
  if (runtime.state === "attested-compatible" && !runtime.resident) {
    throw new UpdateRuntimeError("an active launcher-owned instance holds the gateway; RLY update only restarts attested resident runtimes, so it is left untouched");
  }
  // not-running/stale-record proceeds: a registered-but-down service activates
  // via `start()`; the CLI layer rejects unregistered homes before this point.
}

function runtimeDirectoryFor(dependencies: UpdateRuntimeDependencies): string {
  return runtimeDirectory(dependencies.config.gateway.port);
}

function cryptoRandomChallenge(): string {
  return randomBytes(32).toString("base64url");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
