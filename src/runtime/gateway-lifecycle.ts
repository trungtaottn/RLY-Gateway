import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config/schema.js";
import { fingerprintConfig } from "../config/config-fingerprint.js";
import type { createManagementServer } from "../management/server.js";
import {
  attestedIdentities,
  heartbeatRemote,
  listenerExists,
  mutateRemoteLease,
  reusableRecord,
} from "./gateway-attestation.js";
import type { createGatewayServer } from "./gateway-server.js";
import { startOwnedGateway } from "./owned-gateway.js";
import type { OwnershipRecord, ProcessIdentity } from "./ownership-record.js";
import { readProcessIdentity } from "./process-identity.js";
import { RuntimeStore, StartupLockUnavailableError } from "./runtime-store.js";

export type { GatewayCloseTarget } from "./owned-gateway.js";
export { closeGatewayBounded } from "./owned-gateway.js";

export type GatewayLeaseHandle = Readonly<{
  baseUrl: string;
  authToken: string;
  managementBaseUrl: string;
  managementToken: string;
  instanceId: string;
  leaseId: string;
  reused: boolean;
  release: () => Promise<void>;
}>;

export type AcquireGatewayOptions = Readonly<{
  config: GatewayConfig;
  runtimeDirectory?: string;
  controlPlaneDirectory?: string;
  processIdentity?: ProcessIdentity;
  store?: RuntimeStore;
  fetch?: typeof fetch;
  createServer?: typeof createGatewayServer;
  createManagementServer?: typeof createManagementServer;
  heartbeatMs?: number;
}>;

export function runtimeDirectory(port: number): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Gateway lifecycle requires a POSIX uid");
  return join(tmpdir(), `agent-gateway-${String(uid)}-${String(port)}`);
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
  const managementBaseUrl = `http://${options.config.gateway.host}:${String(options.config.gateway.managementPort)}`;
  const configFingerprint = fingerprintConfig(options.config);
  const leaseId = randomUUID();
  try {
    const record = await store.readOwnershipRecord();
    const secret = await store.readInstanceSecret();
    const managementSecret = await store.readManagementSecret();
    if (record && secret && managementSecret) {
      const reused = await tryReuseAttestedGateway({
        request,
        baseUrl,
        managementBaseUrl,
        secret,
        managementSecret,
        record,
        configFingerprint,
        leaseId,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      });
      if (reused) return reused;
    }
    if (await listenerExists(request, baseUrl)) {
      throw new Error("Configured gateway port is occupied by a foreign or unattested listener");
    }
    if (await listenerExists(request, managementBaseUrl)) {
      throw new Error("Configured management port is occupied by a foreign or unattested listener");
    }
    if (record) await store.removeInstanceArtifacts(record.instanceId);
    return await startOwnedGateway({
      options,
      processIdentity,
      store,
      baseUrl,
      managementBaseUrl,
      configFingerprint,
      leaseId,
    });
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
  const managementBaseUrl = `http://${config.gateway.host}:${String(config.gateway.managementPort)}`;
  const record = await store.readOwnershipRecord();
  const secret = await store.readInstanceSecret();
  const managementSecret = await store.readManagementSecret();
  if (record && secret && managementSecret) {
    const attested = await attestedIdentities(request, baseUrl, managementBaseUrl, secret, managementSecret);
    if (attested) {
      const observed = await readProcessIdentity(record.pid);
      return attested.managementIdentity !== undefined
        && reusableRecord(record, attested.identity, fingerprintConfig(config))
        && attested.managementIdentity.instanceId === attested.identity.instanceId
        && observed?.processStartedAt === record.processStartedAt
        ? "attested-compatible"
        : "occupied-foreign";
    }
  }
  if (await listenerExists(request, baseUrl) || await listenerExists(request, managementBaseUrl)) {
    return "occupied-foreign";
  }
  return record ? "stale-record" : "not-running";
}

async function tryReuseAttestedGateway(input: Readonly<{
  request: typeof fetch;
  baseUrl: string;
  managementBaseUrl: string;
  secret: string;
  managementSecret: string;
  record: OwnershipRecord;
  configFingerprint: string;
  leaseId: string;
  heartbeatMs?: number;
}>): Promise<GatewayLeaseHandle | undefined> {
  const attested = await attestedIdentities(
    input.request,
    input.baseUrl,
    input.managementBaseUrl,
    input.secret,
    input.managementSecret,
  );
  if (!attested) return undefined;
  const { identity, managementIdentity } = attested;
  if (!managementIdentity) {
    throw new Error("Configured management port is occupied by a foreign or unattested listener");
  }
  if (!reusableRecord(input.record, identity, input.configFingerprint)
    || managementIdentity.instanceId !== identity.instanceId
    || managementIdentity.configFingerprint !== input.configFingerprint) {
    throw new Error("Configured gateway listener is attested but incompatible");
  }
  const observed = await readProcessIdentity(input.record.pid);
  if (observed?.processStartedAt !== input.record.processStartedAt) {
    throw new Error("Gateway ownership record has stale process identity");
  }
  await mutateRemoteLease(input.request, "POST", input.baseUrl, input.leaseId, input.secret);
  const heartbeat = heartbeatRemote(
    input.request,
    input.baseUrl,
    input.leaseId,
    input.secret,
    input.heartbeatMs,
  );
  return {
    baseUrl: input.baseUrl,
    authToken: input.secret,
    managementBaseUrl: input.managementBaseUrl,
    managementToken: input.managementSecret,
    instanceId: input.record.instanceId,
    leaseId: input.leaseId,
    reused: true,
    release: async () => {
      clearInterval(heartbeat);
      await mutateRemoteLease(input.request, "DELETE", input.baseUrl, input.leaseId, input.secret).catch(() => undefined);
    },
  };
}

async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const identity = await readProcessIdentity(process.pid);
  if (!identity) throw new Error("Unable to read gateway process start identity");
  return identity;
}
