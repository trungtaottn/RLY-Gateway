import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { LaunchPolicy } from "../profiles/schema.js";

export type ClaudeTarget = Readonly<{ found: boolean; executable: string }>;
export type CodexTarget = ClaudeTarget;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookupOnPath(name: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function detectHarnessTarget(
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  launchPolicy: LaunchPolicy,
): ClaudeTarget {
  const configured = launchPolicy.executable;
  if (configured !== undefined) {
    const found = isAbsolute(configured)
      ? isExecutable(configured)
      : lookupOnPath(configured, environment["PATH"]) !== undefined;
    return { found, executable: configured };
  }
  const found = lookupOnPath(name, environment["PATH"]);
  return { found: found !== undefined, executable: found ?? name };
}

/** Detects the Claude harness binary without mutating global client config. */
export function detectClaudeTarget(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  launchPolicy: LaunchPolicy = {},
): ClaudeTarget {
  return detectHarnessTarget("claude", environment, launchPolicy);
}

/** Detects the Codex harness binary without mutating global client config. */
export function detectCodexTarget(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  launchPolicy: LaunchPolicy = {},
): CodexTarget {
  return detectHarnessTarget("codex", environment, launchPolicy);
}
