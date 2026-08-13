import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../config/schema.js";
import { fingerprintConfig } from "../config/config-fingerprint.js";
import { createGatewayServer, createIdentityProof, listenGateway } from "./gateway-server.js";
import { LeaseManager } from "./lease-manager.js";
import type { OwnershipRecord, ProcessIdentity } from "./ownership-record.js";
import { readProcessIdentity } from "./process-identity.js";
import { RuntimeStore, StartupLockUnavailableError } from "./runtime-store.js";

const LEASE_TTL_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const IDLE_GRACE_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXECUTABLE_FINGERPRINT = createHash("sha256").update("agent-gateway:0.1.0").digest("hex");

type IdentityResponse = Readonly<{
  product: string;
  instanceId: string;
  configFingerprint: string;
  protocolVersion: number;
  proof: string;
}>;

export type GatewayLeaseHandle = Readonly<{
  baseUrl: string;
  authToken: string;
  instanceId: string;
  leaseId: string;
  reused: boolean;
  release: () => Promise<void>;
}>;

export type AcquireGatewayOptions = Readonly<{
  config: GatewayConfig;
  runtimeDirectory?: string;
  processIdentity?: ProcessIdentity;
  store?: RuntimeStore;
  fetch?: typeof fetch;
  createServer?: typeof createGatewayServer;
  heartbeatMs?: number;
}>;

export type GatewayCloseTarget = Readonly<{
  close: () => Promise<unknown>;
  server: Readonly<{ closeAllConnections?: () => void }>;
}>;

/** Bounds server drain and force-closes only connections owned by this server. */
export async function closeGatewayBounded(
  target: GatewayCloseTarget,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<{ forced: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const forced = await Promise.race([
    target.close().then(() => false, () => true),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (forced) target.server.closeAllConnections?.();
  return { forced };
}

function runtimeDirectory(port: number): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Gateway lifecycle requires a POSIX uid");
  return join(tmpdir(), `agent-gateway-${String(uid)}-${String(port)}`);
}

async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const identity = await readProcessIdentity(process.pid);
  if (!identity) throw new Error("Unable to read gateway process start identity");
  return identity;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function identityChallenge(
  request: typeof fetch,
  baseUrl: string,
  secret: string,
): Promise<IdentityResponse | undefined> {
  const challenge = randomBytes(32).toString("base64url");
  try {
    const response = await request(`${baseUrl}/identity?challenge=${challenge}`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    const identity = await response.json() as IdentityResponse;
    const expected = createIdentityProof(
      secret,
      challenge,
      identity.instanceId,
      identity.configFingerprint,
    );
    return identity.product === "agent-gateway"
      && identity.protocolVersion === 1
      && safeEqual(identity.proof, expected)
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

async function listenerExists(request: typeof fetch, baseUrl: string): Promise<boolean> {
  try {
    await request(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function mutateRemoteLease(
  request: typeof fetch,
  method: "POST" | "PUT" | "DELETE",
  baseUrl: string,
  leaseId: string,
  secret: string,
): Promise<void> {
  const response = await request(`${baseUrl}/leases/${leaseId}`, {
    method,
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(750),
  });
  if (!response.ok) throw new Error(`Gateway lease ${method.toLowerCase()} failed`);
}

function reusableRecord(
  record: OwnershipRecord,
  identity: IdentityResponse,
  configFingerprint: string,
): boolean {
  return record.instanceId === identity.instanceId
    && record.configFingerprint === configFingerprint
    && identity.configFingerprint === configFingerprint
    && record.executableFingerprint === EXECUTABLE_FINGERPRINT;
}

function heartbeatRemote(
  request: typeof fetch,
  baseUrl: string,
  leaseId: string,
  secret: string,
  intervalMs = HEARTBEAT_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void mutateRemoteLease(request, "PUT", baseUrl, leaseId, secret).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Starts or safely reuses the one deterministic, attested loopback gateway. */
async function acquireGatewayOnce(options: AcquireGatewayOptions): Promise<GatewayLeaseHandle> {
  const request = options.fetch ?? fetch;
  const processIdentity = options.processIdentity ?? await currentProcessIdentity();
  const store = options.store ?? new RuntimeStore(
    options.runtimeDirectory ?? runtimeDirectory(options.config.gateway.port),
    { processIdentityLookup: readProcessIdentity },
  );
  const lock = await store.acquireStartupLock(processIdentity, async (candidate) => {
    if (!candidate) return true;
    const observed = await readProcessIdentity(candidate.owner.pid);
    return observed?.processStartedAt !== candidate.owner.processStartedAt;
  });
  const baseUrl = `http://${options.config.gateway.host}:${String(options.config.gateway.port)}`;
  const configFingerprint = fingerprintConfig(options.config);
  const leaseId = randomUUID();
  try {
    const record = await store.readOwnershipRecord();
    const secret = await store.readInstanceSecret();
    if (record && secret) {
      const identity = await identityChallenge(request, baseUrl, secret);
      if (identity) {
        if (!reusableRecord(record, identity, configFingerprint)) {
          throw new Error("Configured gateway listener is attested but incompatible");
        }
        const observed = await readProcessIdentity(record.pid);
        if (observed?.processStartedAt !== record.processStartedAt) {
          throw new Error("Gateway ownership record has stale process identity");
        }
        await mutateRemoteLease(request, "POST", baseUrl, leaseId, secret);
        const heartbeat = heartbeatRemote(request, baseUrl, leaseId, secret, options.heartbeatMs);
        return {
          baseUrl,
          authToken: secret,
          instanceId: record.instanceId,
          leaseId,
          reused: true,
          release: async () => {
            clearInterval(heartbeat);
            await mutateRemoteLease(request, "DELETE", baseUrl, leaseId, secret).catch(() => undefined);
          },
        };
      }
    }
    if (await listenerExists(request, baseUrl)) {
      throw new Error("Configured gateway port is occupied by a foreign or unattested listener");
    }
    if (record) await store.removeInstanceArtifacts(record.instanceId);

    const secretValue = randomBytes(32).toString("base64url");
    const instanceId = randomUUID();
    const appHolder: { app?: FastifyInstance } = {};
    const leases = new LeaseManager({
      ttlMs: LEASE_TTL_MS,
      idleGraceMs: IDLE_GRACE_MS,
      onIdle: async (stillIdle) => {
        if (!stillIdle()) return;
        const cleanupLock = await store.acquireStartupLock(processIdentity, () => false);
        try {
          if (!stillIdle()) return;
          const shutdown = appHolder.app
            ? await closeGatewayBounded(appHolder.app)
            : { forced: false };
          if (shutdown.forced || !stillIdle()) return;
          await store.removeInstanceArtifacts(instanceId);
          leases.dispose();
        } finally {
          await cleanupLock.release();
        }
      },
    });
    await leases.add(leaseId);
    let leaseMutation: Promise<void> = Promise.resolve();
    const serializeLeaseMutation = <T>(work: () => Promise<T>): Promise<T> => {
      const result = leaseMutation.then(work, work);
      leaseMutation = result.then(() => undefined, () => undefined);
      return result;
    };
    const registry = {
      add: (id: string): Promise<void> => serializeLeaseMutation(async () => {
        await leases.add(id);
        try {
          await store.addLease(id, processIdentity, () => false);
        } catch (error) {
          await leases.release(id);
          throw error;
        }
      }),
      renew: (id: string): Promise<void> => leases.renew(id),
      release: (id: string): Promise<void> => serializeLeaseMutation(async () => {
        await store.removeLease(id, processIdentity, () => false);
        await leases.release(id);
      }),
    };
    const app = (options.createServer ?? createGatewayServer)({
      host: options.config.gateway.host,
      port: options.config.gateway.port,
      authToken: secretValue,
      instanceId,
      configFingerprint,
      leases: registry,
    });
    appHolder.app = app;
    try {
      await listenGateway(app, {
        host: options.config.gateway.host,
        port: options.config.gateway.port,
        authToken: secretValue,
        instanceId,
        configFingerprint,
        leases: registry,
      });
      await store.writeInstanceSecret(secretValue);
      await store.writeOwnershipRecord({
        ...processIdentity,
        instanceId,
        port: options.config.gateway.port,
        executableFingerprint: EXECUTABLE_FINGERPRINT,
        configFingerprint,
        nonceHash: createHash("sha256").update(secretValue).digest("hex"),
        ownerLauncherPid: processIdentity.pid,
        leases: [leaseId],
      });
    } catch (error) {
      leases.dispose();
      await closeGatewayBounded(app).catch(() => undefined);
      throw error;
    }
    const heartbeat = setInterval(() => {
      void leases.renew(leaseId).catch(() => undefined);
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref();
    return {
      baseUrl,
      authToken: secretValue,
      instanceId,
      leaseId,
      reused: false,
      release: async () => {
        clearInterval(heartbeat);
        await registry.release(leaseId);
      },
    };
  } finally {
    await lock.release();
  }
}

/** Waits briefly for a concurrent launcher holding the atomic startup lock. */
export async function acquireGateway(options: AcquireGatewayOptions): Promise<GatewayLeaseHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await acquireGatewayOnce(options);
    } catch (error: unknown) {
      if (!(error instanceof StartupLockUnavailableError)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

export async function inspectGateway(
  config: GatewayConfig,
  directory?: string,
  request: typeof fetch = fetch,
): Promise<"not-running" | "attested-compatible" | "occupied-foreign" | "stale-record"> {
  const store = new RuntimeStore(directory ?? runtimeDirectory(config.gateway.port));
  const baseUrl = `http://${config.gateway.host}:${String(config.gateway.port)}`;
  const record = await store.readOwnershipRecord();
  const secret = await store.readInstanceSecret();
  if (record && secret) {
    const identity = await identityChallenge(request, baseUrl, secret);
    if (identity) {
      const observed = await readProcessIdentity(record.pid);
      return reusableRecord(record, identity, fingerprintConfig(config))
        && observed?.processStartedAt === record.processStartedAt
        ? "attested-compatible"
        : "occupied-foreign";
    }
  }
  return await listenerExists(request, baseUrl)
    ? "occupied-foreign"
    : record ? "stale-record" : "not-running";
}
