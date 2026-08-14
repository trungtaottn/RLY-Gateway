import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import type { GatewayConfig } from "../config/schema.js";
import { loadConfig } from "../config/load-config.js";
import { managementOrigin } from "../management/origin.js";
import { inspectRuntimeGateway, runtimeDirectory } from "../runtime/gateway-lifecycle.js";
import { RuntimeStore } from "../runtime/runtime-store.js";
import { createServiceManager } from "../service-manager/index.js";
import { serviceDetail } from "../service-manager/types.js";
import { readInstallation } from "../storage/installation.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";

const EMPTY_PROFILES = { total: 0, missingPool: 0 };

function isPlaceholderModel(model: string): boolean {
  return model.startsWith("replace-with-");
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireConfig(path: string, missing: unknown): Promise<GatewayConfig | undefined> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify(missing));
    return undefined;
  }
  return loadConfig(path);
}

async function existingRuntimeStore(config: GatewayConfig): Promise<RuntimeStore | undefined> {
  const directory = runtimeDirectory(config.gateway.port);
  if (!(await canRead(directory))) return undefined;
  return new RuntimeStore(directory);
}

async function requireToken(
  config: GatewayConfig,
  read: (store: RuntimeStore) => Promise<string | undefined>,
  missing: unknown,
): Promise<string | undefined> {
  const store = await existingRuntimeStore(config);
  if (!store) {
    console.log(JSON.stringify(missing));
    return undefined;
  }
  const token = await read(store);
  if (token) return token;
  console.log(JSON.stringify(missing));
  return undefined;
}

async function readJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; payload: unknown }> {
  const response = await fetch(url, { headers });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid-response" }));
  return { ok: response.ok, payload };
}

async function profileInventory(config: GatewayConfig): Promise<{ total: number; missingPool: number }> {
  const extras = await secretFreeInventory(config);
  const profiles = extras["profiles"];
  if (typeof profiles === "number") return { total: profiles, missingPool: 0 };
  return EMPTY_PROFILES;
}

export async function runDoctor(path: string): Promise<number> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify({ ok: false, config: "missing", path }));
    return 1;
  }
  try {
    const config = await loadConfig(path);
    const placeholderRoutes = Object.entries(config.routes)
      .filter(([, route]) => route !== undefined && isPlaceholderModel(route.model))
      .map(([role]) => role);
    const target = detectClaudeTarget(process.env);
    const codex = detectCodexTarget(process.env);
    console.log(JSON.stringify({
      ok: true,
      syntaxValid: true,
      operationalReady: placeholderRoutes.length === 0,
      schemaVersion: config.schemaVersion,
      host: config.gateway.host,
      port: config.gateway.port,
      managementPort: config.gateway.managementPort,
      routes: Object.keys(config.routes).length,
      placeholderRoutes,
      claudeTarget: { found: target.found },
      codexTarget: { found: codex.found },
      profiles: await profileInventory(config),
    }));
    return 0;
  } catch {
    console.log(JSON.stringify({
      ok: false,
      config: "invalid",
      error: "Configuration validation failed; inspect the file locally",
    }));
    return 1;
  }
}

export async function runStatus(path: string): Promise<number> {
  const config = await requireConfig(path, { configured: false, running: false });
  if (!config) return 1;
  const state = await inspectRuntimeGateway(config);
  const running = state.state === "attested-compatible";
  const extras = running ? await secretFreeInventory(config) : {};
  const installation = await readInstallation(config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory());
  // macOS: service label/load state/pid are reported separately from runtime
  // readiness and only when an installation record exists (never runs launchctl
  // against a fresh home).
  const detail = installation?.platform === "darwin"
    ? await serviceDetail(createServiceManager({ home: homedir() }))
    : undefined;
  console.log(JSON.stringify({
    configured: true,
    running,
    state: state.state,
    ...(state.state === "attested-compatible"
      ? { runtimeVersion: state.runtimeVersion, resident: state.resident, instanceId: state.instanceId }
      : {}),
    service: installation === undefined
      ? { registered: false }
      : {
          registered: true,
          platform: installation.platform,
          serviceName: installation.serviceName,
          ...(detail === undefined
            ? {}
            : {
                label: detail.label,
                loadState: detail.loaded ? (detail.running ? "running" : "stopped") : "not-loaded",
                ...(detail.pid === undefined ? {} : { pid: detail.pid }),
              }),
        },
    host: config.gateway.host,
    port: config.gateway.port,
    managementPort: config.gateway.managementPort,
    ...extras,
  }));
  return running ? 0 : 1;
}

export async function runQuota(path: string): Promise<number> {
  return managementGet(path, "/v1/accounts", (body) => {
    const items = asItems(body).map((item) => ({
      pseudonym: item["pseudonym"],
      quotaClass: item["quotaClass"],
    }));
    console.log(JSON.stringify({ accounts: items }));
  });
}

export async function runRouteTrace(path: string): Promise<number> {
  const config = await requireConfig(path, { ok: false, error: "config missing" });
  if (!config) return 1;
  const token = await requireToken(config, (store) => store.readInstanceSecret(), { ok: false, error: "gateway is not running" });
  if (!token) return 1;
  const { ok, payload } = await readJson(`http://${config.gateway.host}:${String(config.gateway.port)}/v1/route-traces`, {
    authorization: `Bearer ${token}`,
  });
  console.log(JSON.stringify({ traces: projectRouteTraces(payload) }));
  return ok ? 0 : 1;
}

async function secretFreeInventory(config: GatewayConfig): Promise<Record<string, unknown>> {
  try {
    const store = await existingRuntimeStore(config);
    const token = store === undefined ? undefined : await store.readManagementSecret();
    if (!token) return {};
    const origin = managementOrigin(config.gateway.host, config.gateway.managementPort);
    const { ok, payload } = await readJson(`${origin}/v1/policy`, {
      authorization: `Bearer ${token}`,
      origin,
    });
    if (!ok) return {};
    const policy = payload as {
      revision?: number;
      profiles?: unknown[];
      pools?: unknown[];
      accounts?: { state?: string }[];
    };
    const accounts = policy.accounts ?? [];
    return {
      policyRevision: policy.revision ?? 0,
      profiles: policy.profiles?.length ?? 0,
      pools: policy.pools?.length ?? 0,
      accounts: {
        total: accounts.length,
        ready: accounts.filter((item) => item.state === "ready").length,
        paused: accounts.filter((item) => item.state === "paused").length,
      },
    };
  } catch {
    return {};
  }
}

async function managementGet(
  path: string,
  route: string,
  write: (body: unknown) => void,
): Promise<number> {
  const config = await requireConfig(path, { ok: false, error: "config missing" });
  if (!config) return 1;
  const token = await requireToken(config, (store) => store.readManagementSecret(), { ok: false, error: "management is not running" });
  if (!token) return 1;
  const origin = managementOrigin(config.gateway.host, config.gateway.managementPort);
  const { ok, payload } = await readJson(`${origin}${route}`, {
    authorization: `Bearer ${token}`,
    origin,
  });
  if (!ok) {
    console.log(JSON.stringify(payload));
    return 1;
  }
  write(payload);
  return 0;
}

function asItems(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

function projectRouteTraces(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const traces = (value as { traces?: unknown }).traces;
  if (!Array.isArray(traces)) return [];
  return traces.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const selected = record["selected"];
    const selectedRecord = selected !== null && typeof selected === "object" ? selected as Record<string, unknown> : undefined;
    return [{
      profileName: record["profileName"],
      sourceRule: record["sourceRule"],
      selectedPseudonym: selectedRecord?.["accountPseudonym"],
    }];
  });
}
