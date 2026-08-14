import type { GatewayConfig } from "../config/schema.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import { createCatalogSource } from "../providers/catalog-discovery.js";
import { proposeCatalogDrift, type CatalogProposalReport } from "../registry/catalog-proposal.js";
import { ProposalStore, readDiscoverySnapshotFile } from "../registry/proposal-store.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import {
  issueBootstrapUrl,
  managementBaseUrl,
  managementRequest,
  parseFields,
  printManagementResult,
  readManagementToken,
} from "./management-client.js";

export type AdminCommand = Readonly<{
  command: "admin";
  configPath: string;
  resource: "providers" | "accounts" | "pools" | "profiles" | "credentials" | "ui" | "models";
  action: "list" | "create" | "update" | "pause" | "resume" | "open" | "import" | "login" | "revoke" | "refresh" | "select" | "preview" | "proposals";
  fields: Readonly<Record<string, string>>;
}>;

export function parseAdminArgs(args: readonly string[], configPath: string): AdminCommand | undefined {
  if (args[0] !== "admin") return undefined;
  const resource = args[1];
  if (resource !== "providers" && resource !== "accounts" && resource !== "pools" && resource !== "profiles" && resource !== "credentials" && resource !== "ui" && resource !== "models") {
    throw new Error("admin requires providers, accounts, pools, profiles, credentials, ui, or models");
  }
  if (resource === "ui") return { command: "admin", configPath, resource, action: "open", fields: {} };
  const action = args[2];
  const allowed = resource === "credentials"
    ? ["import", "preview", "login"]
    : resource === "models"
      ? ["refresh", "proposals"]
      : ["list", "create", "update", "pause", "resume", "revoke", "refresh", "select"];
  if (action === undefined || !allowed.includes(action)) {
    throw new Error(`admin action is not valid for ${resource}`);
  }
  return {
    command: "admin",
    configPath,
    resource,
    action: action as AdminCommand["action"],
    fields: parseFields(args.slice(3)),
  };
}

export async function runAdmin(command: AdminCommand, config: GatewayConfig): Promise<number> {
  if ((command.action === "pause" || command.action === "resume") && command.resource !== "accounts") {
    throw new Error("pause and resume apply only to accounts");
  }
  if (command.resource === "models") return runModelsAdmin(command, config);
  const token = await readManagementToken(config);
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: "management is not running" }));
    return 1;
  }
  const baseUrl = managementBaseUrl(config);
  const origin = baseUrl;
  if (command.resource === "ui") {
    const url = await issueBootstrapUrl(baseUrl, token, origin);
    if (!url) {
      console.log(JSON.stringify({ ok: false, error: "bootstrap failed" }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, url }));
    return 0;
  }
  if (command.resource === "credentials") {
    if (command.action === "preview") {
      return requestOk(baseUrl, token, origin, "POST", "/v1/credentials/import/preview", bodyFromFields(command));
    }
    if (command.action === "import") {
      return requestOk(baseUrl, token, origin, "POST", "/v1/credentials/import", bodyFromFields(command));
    }
    const started = await managementRequest(baseUrl, token, origin, "POST", "/v1/credentials/login", bodyFromFields(command));
    if (!started.ok) return 1;
    return requestOk(baseUrl, token, origin, "POST", "/v1/credentials/login/complete", {});
  }
  const path = `/v1/${command.resource}`;
  if (command.action === "list") {
    return requestOk(baseUrl, token, origin, "GET", path);
  }
  if (command.action === "create") {
    return requestOk(baseUrl, token, origin, "POST", path, bodyFromFields(command));
  }
  const id = command.fields["id"];
  const version = command.fields["version"];
  if (id === undefined || version === undefined) throw new Error("update requires --id and --version");
  const payload = bodyFromFields(command);
  if (command.action === "pause") payload["state"] = "paused";
  if (command.action === "resume") payload["state"] = "ready";
  payload["version"] = Number(version);
  if (command.action === "revoke" || command.action === "refresh" || command.action === "select") {
    return requestOk(baseUrl, token, origin, "POST", `${path}/${id}/${command.action}`, payload);
  }
  return requestOk(baseUrl, token, origin, "PATCH", `${path}/${id}`, payload);
}

async function requestOk(
  baseUrl: string,
  token: string,
  origin: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<number> {
  const result = await managementRequest(baseUrl, token, origin, method, path, body);
  printManagementResult(result);
  return result.ok ? 0 : 1;
}

function bodyFromFields(command: AdminCommand): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const fields = command.fields;
  copyString(body, fields, "name");
  copyString(body, fields, "pseudonym");
  copyString(body, fields, "provider-id", "providerId");
  copyString(body, fields, "pool-id", "poolId");
  copyString(body, fields, "credential-handle", "credentialHandle");
  copyString(body, fields, "mode", "integrationMode");
  copyString(body, fields, "strategy");
  copyString(body, fields, "harness");
  copyString(body, fields, "pause-reason", "pauseReason");
  copyString(body, fields, "terms", "termsRevision");
  copyString(body, fields, "provenance", "provenanceRef");
  copyString(body, fields, "source", "sourcePath");
  copyString(body, fields, "source-fingerprint", "sourceFingerprint");
  copyString(body, fields, "endpoint", "endpointPolicy");
  if (fields["disable"] === "true") body["enabled"] = false;
  if (fields["enable"] === "true") body["enabled"] = true;
  if (fields["retry-budget"] !== undefined) body["retryBudget"] = Number(fields["retry-budget"]);
  if (fields["roles"] !== undefined) body["modelRoles"] = JSON.parse(fields["roles"]) as unknown;
  if (fields["accounts"] !== undefined) body["accountIds"] = fields["accounts"].split(",").filter(Boolean);
  return body;
}

function copyString(body: Record<string, unknown>, fields: Readonly<Record<string, string>>, from: string, to = from): void {
  const value = fields[from];
  if (value !== undefined) body[to] = value;
}

// ---------------------------------------------------------------------------
// Propose-only catalog refresh (#23 / BL-042)
//
// `rly admin models refresh` runs the discovery → normalize → compare → drift
// pipeline locally and persists the proposal artifact SEPARATE from trusted
// evidence. It never touches the management API, the trusted #67 registry,
// profile tier mappings, or `/v1/models` projections. `rly admin models
// proposals` surfaces persisted proposals with a `trusted: false` marker so
// they are never presented as selectable/usable models.
// ---------------------------------------------------------------------------

function controlPlaneDirectoryFor(config: GatewayConfig, fields: Readonly<Record<string, string>>): string {
  return fields["control-plane"] ?? config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
}

/** Resolves an approved env credential ref for a provider from the configured routes, if any. */
function credentialRefForProvider(config: GatewayConfig, providerId: string): ReturnType<typeof parseCredentialRef> | undefined {
  for (const role of ["primary", "fast", "reasoning"] as const) {
    const route = config.routes[role];
    if (route !== undefined && route.provider === providerId) return parseCredentialRef(route.credential);
  }
  return undefined;
}

function applyFamilyFilter(report: CatalogProposalReport, family: string): CatalogProposalReport {
  const matches = (identity: { modelFamily?: string }): boolean => identity.modelFamily === family;
  return {
    ...report,
    unchanged: report.unchanged,
    new: report.new.filter((entry) => matches(entry.identity)),
    changed: report.changed.filter((entry) => matches(entry.identity)),
    removed: report.removed.filter((entry) => matches(entry.identity)),
  };
}

async function runModelsAdmin(command: AdminCommand, config: GatewayConfig): Promise<number> {
  const directory = controlPlaneDirectoryFor(config, command.fields);
  const store = new ProposalStore(directory);
  if (command.action === "proposals") {
    const proposals = await store.list();
    console.log(JSON.stringify({ ok: true, trusted: false, proposals }));
    return 0;
  }

  const providerId = command.fields["provider"];
  if (providerId === undefined) throw new Error("models refresh requires --provider <name>");
  const sourceKind = command.fields["source"];
  if (sourceKind !== undefined && sourceKind !== "api" && sourceKind !== "static") {
    throw new Error("--source must be api or static");
  }
  const snapshotPath = command.fields["snapshot"];
  const snapshot = snapshotPath === undefined ? undefined : await readDiscoverySnapshotFile(snapshotPath);
  const credentialRef = credentialRefForProvider(config, providerId);
  const catalogSource = createCatalogSource(providerId, {
    ...(sourceKind === undefined ? {} : { source: sourceKind }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
  const discovered = await catalogSource.discover(new AbortController().signal);
  const report = proposeCatalogDrift(discovered, providerId);
  const artifactPath = await store.write(report);
  const family = command.fields["family"];
  const printed = family === undefined ? report : applyFamilyFilter(report, family);
  console.log(JSON.stringify({ ok: true, trusted: false, artifactPath, report: printed }));
  return 0;
}
