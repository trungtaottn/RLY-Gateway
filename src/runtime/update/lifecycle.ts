import { randomBytes, timingSafeEqual } from "node:crypto";
import { RUNTIME_VERSION } from "../gateway-attestation.js";
import type { BuildIdentity } from "../build-identity.js";
import { inspectRuntimeGateway, runtimeDirectory, type RuntimeInspection } from "../gateway-lifecycle.js";
import { RuntimeStore } from "../runtime-store.js";
import { createIdentityProof } from "../gateway-server.js";
import type { ServiceManagerAdapter, ServiceDefinitionInput } from "../../service-manager/types.js";
import type { GatewayConfig } from "../../config/schema.js";
import {
  migrationClassOf,
  migrationPreflight,
  RUNTIME_PROTOCOL_VERSION,
  stateVersionsCompatible,
} from "./policy.js";
import { recoverUpdateState, UpdateStateStore } from "./store.js";
import type { CandidateInstaller, UpdateStateRecord, UpdateTransaction } from "./types.js";

export type UpdateRunResult = Readonly<{
  outcome: "installed" | "activated" | "pending" | "rolled-back" | "failed" | "no-candidate";
  state: UpdateStateRecord["state"];
  /** Durable activation-transaction phase (#93), when one is in progress. */
  phase?: UpdateTransaction["phase"];
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
 * Safe zero-downtime update coordinator (#73/#93). Separates candidate
 * installation from activation, runs activation as a DURABLE TRANSACTION
 * (staged → draining → switching → probation → committing → committed, with
 * bounded rollback and an explicit recovery-required terminal), drains launch
 * sessions behind a strong new-launch fence, restarts through the per-user
 * service manager, verifies the new runtime via the attested identity/
 * readiness/state-open handshake, and rolls back to the previous known-good
 * deployment on failure. Fails closed everywhere: a foreign or unattested
 * listener is never signaled, launcher-owned instances are never restarted,
 * crash recovery never guesses that a candidate committed, and the state
 * machine never loops.
 */
export async function runUpdate(dependencies: UpdateRuntimeDependencies): Promise<UpdateRunResult> {
  const request = dependencies.fetch ?? fetch;
  const store = dependencies.updateStore ?? new UpdateStateStore(dependencies.controlPlaneDirectory);
  const cliStateVersion = dependencies.cliStateVersion;

  const lock = await store.acquireLock();
  try {
    const current = await store.read();
    const recovered = recoverUpdateState(current);
    if (recovered !== undefined && JSON.stringify(recovered) !== JSON.stringify(current)) {
      await store.write(recovered);
    }

    const runtime = await inspectRuntimeGateway(dependencies.config, dependencies.runtimeDirectory, request);
    const runtimeVersion = runtime.state === "attested-compatible" ? runtime.runtimeVersion ?? RUNTIME_VERSION : undefined;
    const record = recovered;

    // Terminal gate (#93): recovery-required is never retried automatically —
    // an actionable `rly doctor` path only, never an infinite restart loop.
    if (record?.state === "recovery-required") {
      return {
        outcome: "failed",
        state: "recovery-required",
        ...(record.transaction === undefined ? {} : { phase: record.transaction.phase }),
        currentVersion: runtimeVersion ?? record.currentVersion,
        ...(record.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }),
        message: record.failureReason ?? "the update transaction requires manual recovery; run rly doctor",
      };
    }

    // A crashed/aborted transaction that recovery mapped to rollback-required
    // completes its single bounded rollback before any new work (deterministic
    // post-crash choice — never guess the candidate committed).
    if (record?.state === "rollback-required") {
      const targetVersion = record.currentVersion;
      const restartNeeded = runtime.state === "attested-compatible"
        && runtime.resident
        && (runtime.runtimeVersion ?? RUNTIME_VERSION) !== targetVersion;
      return await rollback(dependencies, store, record, {
        restarted: restartNeeded,
        reason: record.failureReason ?? "activation transaction was interrupted; rolling back to the previous known-good version",
        request,
      });
    }

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
        outcome: "no-candidate",
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
    const installing = await store.transitionUnderLock(["none", "idle", "active", "failed", "pending-activation"], (current) => ({
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

    // The durable transaction journal opens at STAGED (#93) with the immutable
    // deployment evidence needed for deterministic crash recovery. Staging
    // never changed the serving `active` reference (#92).
    const transaction: UpdateTransaction = {
      schemaVersion: 1,
      phase: "staged",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateVersion,
      candidateArtifactId: installed.artifactId,
      ...(installed.previousVersion === undefined ? {} : { previousVersion: installed.previousVersion }),
      ...(installed.previousArtifactId === undefined ? {} : { previousArtifactId: installed.previousArtifactId }),
      rollbackAttempts: 0,
    };
    const pending: UpdateStateRecord = {
      ...installing,
      state: "pending-activation",
      currentVersion: installing.currentVersion,
      pendingVersion: candidateVersion,
      ...(installed.previousVersion === undefined ? {} : { previousVersion: installed.previousVersion }),
      pendingArtifactId: installed.artifactId,
      ...(installed.previousArtifactId === undefined ? {} : { previousArtifactId: installed.previousArtifactId }),
      transaction,
      updatedAt: new Date().toISOString(),
    };
    await store.write(pending);

    // Migration preflight BEFORE destructive activation (#93): a forward-only
    // candidate must not be activated; the previous version keeps serving. The
    // staged deployment remains on disk for diagnosis until a later install.
    const manifest = await dependencies.installer.readManifest().catch(() => undefined);
    const migrationClass = migrationClassOf(manifest);
    if (manifest !== undefined) {
      const blocker = migrationPreflight(pending, migrationClass);
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

/**
 * Runs the activation half of the transaction (#93):
 *
 *   STAGED → DRAINING (fence) → SWITCHING (ref) → restart → PROBATION
 *   → COMMITTING → COMMITTED | ROLLING_BACK → COMMITTED | RECOVERY_REQUIRED
 *
 * The journal phase is written durably BEFORE the action it fences, so a crash
 * at any boundary leaves the evidence needed to make one deterministic choice.
 */
async function activate(
  dependencies: UpdateRuntimeDependencies,
  store: UpdateStateStore,
  record: UpdateStateRecord,
  context: Readonly<{
    runtime: RuntimeInspection;
    request: typeof fetch;
  }>,
): Promise<UpdateRunResult> {
  const request = context.request;
  const tx = await transactionFor(dependencies, record);
  const activating = await store.transitionUnderLock(["pending-activation", "activating"], (current) => ({
    ...(current ?? record),
    state: "activating" as const,
    transaction: { ...tx, phase: "draining" as const, updatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }));

  // Strong new-launch fence FIRST (#93): before the serving ref switch, the
  // old generation refuses new launch-session issuance. Existing sessions
  // complete naturally on the old process; in-flight streams/tool loops are
  // never replayed or moved. Best-effort on an attested resident runtime; the
  // bounded service-manager restart closes the window.
  await beginDrain(dependencies, request);

  // Drain: wait for launch sessions (not TCP counts) to reach zero unless the
  // user explicitly requested the destructive/force path.
  const alreadyDown = context.runtime.state === "not-running" || context.runtime.state === "stale-record";
  if (!alreadyDown && !dependencies.force) {
    const drained = await waitForSessionDrain(dependencies, request);
    if (!drained.drained) {
      // Activation stays pending; sessions keep running. Re-run `rly update`
      // (or `--force`) once the user is ready.
      const pending = await store.transitionUnderLock(["activating"], (current) => ({
        ...(current ?? activating),
        state: "pending-activation" as const,
        transaction: { ...tx, phase: "draining" as const, updatedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      }));
      return {
        outcome: "pending",
        state: "pending-activation",
        ...(pending.transaction === undefined ? {} : { phase: pending.transaction.phase }),
        currentVersion: pending.currentVersion,
        ...(pending.pendingVersion === undefined ? {} : { pendingVersion: pending.pendingVersion }),
        message: `update installed; activation pending drain (${String(drained.activeSessions)} session(s) active). Existing sessions keep running; re-run rly update when they end, or use --force`,
      };
    }
  }

  // Durable SWITCHING boundary immediately before the atomic active-ref switch.
  const switching = await store.transitionUnderLock(["activating"], (current) => ({
    ...(current ?? activating),
    transaction: { ...tx, phase: "switching" as const, updatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }));

  try {
    // INSTALL != ACTIVATE (#92): the atomic `active` ref switch happens here,
    // immediately before the restart that boots the staged deployment, and the
    // displaced known-good is recorded as `previous` first (#93 crash safety).
    try {
      await dependencies.installer.activateStaged();
    } catch (error) {
      return await rollback(dependencies, store, switching, { restarted: false, reason: `activation reference switch failed: ${errorMessage(error)}`, request });
    }

    const restarted = await controlledRestart(dependencies, request);
    if (!restarted.ok) {
      return await rollback(dependencies, store, switching, { restarted: restarted.restarted, reason: restarted.reason, request });
    }

    // Durable PROBATION boundary: candidate activation is provisional until
    // exact runtime identity + management/data protocol + authenticated
    // readiness/state-open verification.
    const probation = await store.transitionUnderLock(["activating"], (current) => ({
      ...(current ?? switching),
      transaction: { ...tx, phase: "probation" as const, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    }));

    const verified = await verifyCandidateRuntime(dependencies, request, probation.transaction?.candidateVersion ?? probation.pendingVersion, probation.transaction?.candidateArtifactId ?? probation.pendingArtifactId);
    if (!verified.ok) {
      return await rollback(dependencies, store, probation, { restarted: true, reason: verified.reason, request });
    }

    // Durable COMMITTING boundary: probation passed; the next write IS the
    // commit. A crash before COMMITTED always rolls back — never silently
    // commits a candidate that was never durably accepted.
    const committing = await store.transitionUnderLock(["activating"], (current) => ({
      ...(current ?? probation),
      transaction: { ...tx, phase: "committing" as const, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    }));

    const transaction = committing.transaction ?? tx;
    const active = await store.transitionUnderLock(["activating"], (current) => ({
      ...(current ?? committing),
      state: "active" as const,
      currentVersion: transaction.candidateVersion,
      pendingVersion: undefined,
      currentArtifactId: transaction.candidateArtifactId,
      pendingArtifactId: undefined,
      ...(transaction.previousVersion === undefined ? {} : { previousVersion: transaction.previousVersion }),
      ...(transaction.previousArtifactId === undefined ? {} : { previousArtifactId: transaction.previousArtifactId }),
      transaction: { ...transaction, phase: "committed" as const, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
      lastActivationResult: { ok: true, attemptedAt: new Date().toISOString() },
      failureReason: undefined,
    }));
    return {
      outcome: "activated",
      state: "active",
      phase: "committed",
      currentVersion: active.currentVersion,
      message: `runtime activated at version ${active.currentVersion}`,
    };
  } catch (error) {
    return await rollback(dependencies, store, activating, { restarted: true, reason: errorMessage(error), request });
  }
}

/**
 * Returns the durable transaction journal for an activation, synthesizing one
 * from a legacy #73 pending record when no journal exists (pre-#93 crash
 * resume). The candidate's immutable artifact identity is required evidence;
 * activation fails closed when it cannot be established.
 */
async function transactionFor(
  dependencies: UpdateRuntimeDependencies,
  record: UpdateStateRecord,
): Promise<UpdateTransaction> {
  if (record.transaction !== undefined) return record.transaction;
  const verified = await dependencies.installer.verifyCandidate();
  if (!verified.ok) {
    throw new UpdateRuntimeError(`cannot resume activation: staged candidate failed verification: ${verified.reason ?? "unknown"}; run rly doctor`);
  }
  if (verified.artifactId === undefined) {
    throw new UpdateRuntimeError("cannot resume activation: the staged candidate's immutable artifact identity is unavailable; re-run rly update");
  }
  return {
    schemaVersion: 1,
    phase: "draining",
    startedAt: record.updatedAt,
    updatedAt: new Date().toISOString(),
    candidateVersion: record.pendingVersion ?? verified.version,
    candidateArtifactId: verified.artifactId,
    ...(record.previousVersion === undefined ? {} : { previousVersion: record.previousVersion }),
    ...(record.previousArtifactId === undefined ? {} : { previousArtifactId: record.previousArtifactId }),
    rollbackAttempts: 0,
  };
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
 * Verifies the activated candidate (#93/#94 probation): attested identity +
 * exact serving runtime version equals the pending candidate (never the
 * package version on disk alone) + management/data protocol compatibility +
 * durable state/schema compatibility + authenticated readiness
 * (management/state open). Since #94 probation ALSO requires the exact build
 * identity: the serving runtime's build identity must match the candidate's
 * declared identity (commit/build/channel when declared) AND the serving
 * artifact digest must equal the candidate's immutable deployment identity —
 * so a same-semantic-version-different-artifact candidate can never pass.
 */
async function verifyCandidateRuntime(
  dependencies: UpdateRuntimeDependencies,
  request: typeof fetch,
  pendingVersion: string | undefined,
  pendingArtifactId: string | undefined,
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
      if (identity.protocolVersion !== undefined && identity.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        return { ok: false, reason: `restarted runtime management/data protocol ${String(identity.protocolVersion)} is not compatible with this RLY (${String(RUNTIME_PROTOCOL_VERSION)})` };
      }
      if (pendingVersion !== undefined && identity.runtimeVersion !== pendingVersion) {
        return { ok: false, reason: `serving runtime version ${identity.runtimeVersion ?? "unknown"} does not match the pending candidate ${pendingVersion}` };
      }
      if (pendingArtifactId !== undefined) {
        if (identity.build?.artifactId !== pendingArtifactId) {
          return {
            ok: false,
            reason: `serving runtime artifact digest ${identity.build?.artifactId ?? "<none>"} does not match the pending candidate deployment ${pendingArtifactId}; same semantic version, different artifact`,
          };
        }
        if (identity.build !== undefined && identity.build.semanticVersion !== pendingVersion) {
          return { ok: false, reason: `serving build identity version ${identity.build.semanticVersion} does not match the pending candidate ${String(pendingVersion)}` };
        }
        if (identity.build !== undefined && identity.build.controlProtocolVersion !== RUNTIME_PROTOCOL_VERSION) {
          return { ok: false, reason: `serving build control protocol ${String(identity.build.controlProtocolVersion)} is not compatible (${String(RUNTIME_PROTOCOL_VERSION)})` };
        }
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
): Promise<{ runtimeVersion?: string; stateVersion?: number; activeSessions?: number; protocolVersion?: number; build?: BuildIdentity } | undefined> {
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
      protocolVersion?: number;
      build?: BuildIdentity;
      proof?: string;
    };
    if (payload.proof === undefined || payload.instanceId === undefined || payload.configFingerprint === undefined) return undefined;
    const expected = createIdentityProof(secret, challenge, payload.instanceId, payload.configFingerprint);
    if (!safeHexEqual(payload.proof, expected)) return undefined;
    return {
      ...(payload.runtimeVersion === undefined ? {} : { runtimeVersion: payload.runtimeVersion }),
      ...(payload.stateVersion === undefined ? {} : { stateVersion: payload.stateVersion }),
      ...(payload.activeSessions === undefined ? {} : { activeSessions: payload.activeSessions }),
      ...(payload.protocolVersion === undefined ? {} : { protocolVersion: payload.protocolVersion }),
      ...(payload.build === undefined ? {} : { build: payload.build }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Bounded rollback (#93): at most ONE rollback attempt ever. The refs are
 * re-established from the durable transaction journal (recovery-grade, safe
 * even when an interrupted switch left refs mid-transition) or through the
 * installer's previous ref for legacy records; the service restarts once when
 * the displaced runtime is serving; rollback verification uses the same
 * attested probation checks. Failure terminates in RECOVERY_REQUIRED.
 */
async function rollback(
  dependencies: UpdateRuntimeDependencies,
  store: UpdateStateStore,
  record: UpdateStateRecord,
  input: Readonly<{ restarted: boolean; reason: string; request: typeof fetch }>,
): Promise<UpdateRunResult> {
  const tx = record.transaction;
  const attempts = tx?.rollbackAttempts ?? 0;
  if (attempts >= 1) {
    return await enterRecoveryRequired(
      store,
      record,
      `rollback already attempted; activation failure is not automatically recoverable (${input.reason}); run rly doctor`,
    );
  }
  const rolledBack: UpdateStateRecord = {
    ...record,
    state: "rollback-required",
    ...(tx === undefined
      ? {}
      : {
          transaction: {
            ...tx,
            phase: "rolling-back" as const,
            rollbackAttempts: 1,
            lastRollbackOutcome: { ok: false, attemptedAt: new Date().toISOString(), reason: input.reason },
            updatedAt: new Date().toISOString(),
          },
        }),
    updatedAt: new Date().toISOString(),
    failureReason: `activation failed: ${input.reason}`,
  };
  await store.write(rolledBack);
  try {
    let restored: { version: string; artifactId: string; previousVersion?: string; previousArtifactId?: string };
    if (tx?.previousArtifactId !== undefined) {
      // Recovery-grade restore from durable journal evidence: re-establish the
      // known-good active ref and record the aborted candidate as previous.
      await dependencies.installer.setActiveReferences({
        activeArtifactId: tx.previousArtifactId,
        previousArtifactId: tx.candidateArtifactId,
      });
      restored = {
        version: tx.previousVersion ?? record.currentVersion,
        artifactId: tx.previousArtifactId,
        previousVersion: tx.candidateVersion,
        previousArtifactId: tx.candidateArtifactId,
      };
    } else {
      // Legacy #73 rollback through the installer's preserved previous ref.
      restored = await dependencies.installer.restorePrevious();
    }
    if (input.restarted) {
      await dependencies.serviceManager.restart();
      const verified = await verifyCandidateRuntime(dependencies, input.request, restored.version, restored.artifactId);
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
      ...(tx === undefined
        ? {}
        : { transaction: { ...tx, phase: "committed" as const, lastRollbackOutcome: { ok: true, attemptedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() } }),
      failureReason: undefined,
    }));
    return {
      outcome: "rolled-back",
      state: "active",
      ...(active.transaction === undefined ? {} : { phase: active.transaction.phase }),
      currentVersion: active.currentVersion,
      message: `activation failed (${input.reason}); rolled back to previous known-good version ${active.currentVersion}`,
    };
  } catch (error) {
    return await enterRecoveryRequired(
      store,
      rolledBack,
      `activation and rollback both failed: ${input.reason}; ${errorMessage(error)}; run rly doctor`,
    );
  }
}

/** Terminal #93 state: actionable `rly doctor` path, never an auto-retry loop. */
async function enterRecoveryRequired(
  store: UpdateStateStore,
  record: UpdateStateRecord,
  reason: string,
): Promise<UpdateRunResult> {
  const failed: UpdateStateRecord = {
    ...record,
    state: "recovery-required",
    ...(record.transaction === undefined
      ? {}
      : { transaction: { ...record.transaction, phase: "recovery-required" as const, recoveryReason: reason, updatedAt: new Date().toISOString() } }),
    updatedAt: new Date().toISOString(),
    failureReason: reason,
  };
  await store.write(failed);
  return {
    outcome: "failed",
    state: "recovery-required",
    ...(failed.transaction === undefined ? {} : { phase: failed.transaction.phase }),
    currentVersion: record.currentVersion,
    ...(record.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }),
    message: reason,
  };
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
