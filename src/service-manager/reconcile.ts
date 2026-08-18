import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServiceDefinitionInput, ServiceManagerAdapter } from "./types.js";

/**
 * Service-definition reconciliation (#94). Detects missing, stale, or
 * path-drifted launchd/systemd definitions and repairs them idempotently
 * through the platform adapter, so re-running `rly init` or `rly doctor`
 * heals a service that points at an obsolete executable/module path without
 * touching provider/account configuration. A definition is "stale" when it
 * differs from the RLY-owned expected definition; a legacy definition (one
 * pointing at `dist/cli/init.js`, an incidental Node binary, or a direct
 * `runtime/refs/...` deployment path) is migrated to the stable bootstrap
 * contract. The RLY-owned definition NEVER encodes a deployment path — it
 * points at the stable bootstrap, which resolves only the committed `active`
 * deployment and refuses staged/deleted targets.
 */

export type DefinitionReconciliationState = "ok" | "missing" | "stale" | "repaired" | "unsupported" | "failed";

export type DefinitionReconciliation = Readonly<{
  status: DefinitionReconciliationState;
  /** On-disk definition path (platform-specific). */
  definitionPath?: string;
  /** sha256 of the current on-disk definition; absent when missing. */
  revision?: string;
  /** sha256 of the RLY-owned expected definition. */
  expectedRevision: string;
  /** True when the on-disk definition differed from the expected one. */
  changed: boolean;
  /** True when a legacy (node/init.js/direct-refs) definition was replaced. */
  migrated?: boolean;
  message?: string;
}>;

/** Renders the RLY-owned expected definition content for a platform adapter. */
export function renderExpectedDefinition(
  manager: ServiceManagerAdapter,
  expected: ServiceDefinitionInput,
): string | undefined {
  const renderer = manager as ServiceManagerAdapter & { renderDefinition?: (input: ServiceDefinitionInput) => string };
  return typeof renderer.renderDefinition === "function" ? renderer.renderDefinition(expected) : undefined;
}

/**
 * Detects the current definition state without mutating anything: compares the
 * on-disk definition with the rendered expected content. When the adapter has
 * no renderer (test doubles), presence of the definition is treated as ok.
 */
export async function detectDefinition(
  manager: ServiceManagerAdapter,
  expected: ServiceDefinitionInput,
): Promise<DefinitionReconciliation> {
  const definitionPath = (manager as ServiceManagerAdapter & { definitionPath?: string }).definitionPath;
  const expectedContent = renderExpectedDefinition(manager, expected);
  const expectedRevision = hash(expectedContent ?? JSON.stringify(expected));
  if (!manager.isSupported()) {
    return { status: "unsupported", expectedRevision, changed: false };
  }
  let current: string | undefined;
  if (definitionPath !== undefined) {
    current = await readFile(definitionPath, "utf8").catch(() => undefined);
  } else if (await manager.isRegistered()) {
    current = "";
  }
  if (current === undefined) {
    return { status: "missing", expectedRevision, changed: true, ...(definitionPath === undefined ? {} : { definitionPath }) };
  }
  if (expectedContent !== undefined && current !== expectedContent) {
    const migrated = isLegacyDefinition(current);
    return {
      status: "stale",
      ...(definitionPath === undefined ? {} : { definitionPath }),
      ...(current === "" ? {} : { revision: hash(current) }),
      expectedRevision,
      changed: true,
      ...(migrated ? { migrated: true } : {}),
    };
  }
  return {
    status: "ok",
    ...(definitionPath === undefined ? {} : { definitionPath }),
    ...(current === "" ? {} : { revision: hash(current) }),
    expectedRevision,
    changed: false,
  };
}

/**
 * Detects and idempotently repairs a missing/stale/path-drifted definition via
 * the platform adapter's `register()` (atomic rewrite + change-only reload).
 * Never duplicates the definition and never touches provider/account config.
 */
export async function reconcileDefinition(
  manager: ServiceManagerAdapter,
  expected: ServiceDefinitionInput,
): Promise<DefinitionReconciliation> {
  const before = await detectDefinition(manager, expected);
  if (before.status === "ok" || before.status === "unsupported") return before;
  try {
    await manager.register(expected);
  } catch (error) {
    return {
      status: "failed",
      ...(before.definitionPath === undefined ? {} : { definitionPath: before.definitionPath }),
      ...(before.revision === undefined ? {} : { revision: before.revision }),
      expectedRevision: before.expectedRevision,
      changed: true,
      message: error instanceof Error ? error.message : "service definition repair failed",
    };
  }
  const after = await detectDefinition(manager, expected);
  return {
    ...after,
    status: "repaired",
    ...(before.migrated === undefined ? {} : { migrated: before.migrated }),
  };
}

/**
 * True when a definition still encodes a legacy execution identity: a direct
 * module entrypoint (`dist/cli/init.js`, `dist/cli/main.js`), an incidental
 * Node binary executable, or a direct `runtime/refs/...` deployment path.
 * RLY-owned definitions reference only the stable bootstrap script.
 */
export function isLegacyDefinition(content: string): boolean {
  return /dist[/\\]cli[/\\]init\.js/.test(content)
    || /dist[/\\]cli[/\\]main\.js/.test(content)
    || /runtime[/\\]refs[/\\]/.test(content)
    || /(^|\/|\\)node(\.exe)?([\s"<]|$)/.test(content);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
