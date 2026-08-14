import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";
import { probeClientVersion } from "../targets/versions.js";
import { CLAUDE_CODE_FIXTURE_BASELINE, CODEX_CLI_OBSERVED_VERSION } from "./client-fixtures.js";
import type { ClientKind, InstalledClient } from "./types.js";

/**
 * Installed client detection + exact version probe (#24). Binary presence is
 * `found`, never `compatible`: an unknown/newly installed version reports
 * `versionSource: "unknown"` and is never silently treated as the tested
 * baseline.
 */

export async function detectInstalledClients(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<{ claude: InstalledClient; codex: InstalledClient }> {
  const claudeTarget = detectClaudeTarget(environment);
  const codexTarget = detectCodexTarget(environment);
  const claudeProbe = claudeTarget.found ? await probeClientVersion(claudeTarget.executable) : undefined;
  const codexProbe = codexTarget.found ? await probeClientVersion(codexTarget.executable) : undefined;
  return {
    claude: Object.freeze({
      kind: "claude-code" as const,
      found: claudeTarget.found,
      executable: claudeTarget.executable,
      ...(claudeProbe?.version === undefined ? {} : { version: claudeProbe.version }),
      versionSource: claudeTarget.found ? (claudeProbe?.source ?? "unknown") : "unknown",
    }),
    codex: Object.freeze({
      kind: "codex-cli" as const,
      found: codexTarget.found,
      executable: codexTarget.executable,
      ...(codexProbe?.version === undefined ? {} : { version: codexProbe.version }),
      versionSource: codexTarget.found ? (codexProbe?.source ?? "unknown") : "unknown",
    }),
  };
}

/** Tested-baseline record for one client kind (observed ≠ tested). */
export function testedBaselineFor(kind: ClientKind): Readonly<{ baseline: string; observed?: string }> {
  return kind === "claude-code"
    ? Object.freeze({ baseline: CLAUDE_CODE_FIXTURE_BASELINE })
    : Object.freeze({ baseline: "codex-cli-observed", observed: CODEX_CLI_OBSERVED_VERSION });
}
