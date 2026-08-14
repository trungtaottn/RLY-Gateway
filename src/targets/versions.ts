import { spawn } from "node:child_process";

/**
 * Installed client version probing (#24).
 *
 * Binary presence is `found`, never `compatible`. The exact semantic/version
 * string is read from the client's own `--version` output; it is never
 * inferred from file timestamps, package directories, or PATH location. When
 * the executable does not answer or its output has no version token, the
 * result is `unknown` — a new/unknown client version is never treated as a
 * tested baseline.
 */

export type VersionSource = "cli-output" | "unknown";

export type VersionProbe = Readonly<{
  /** Exact semantic/version token reported by the client, when parseable. */
  version?: string;
  source: VersionSource;
  /** Redacted reason when the probe could not read a version. Never a secret. */
  error?: string;
}>;

export const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** Extracts the first semver-ish token (`2.1.229`, `0.147.0-alpha.6.5`). */
export function parseVersionToken(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0];
}

/**
 * Runs `<executable> --version` with a bounded timeout and parses the exact
 * version token from stdout (falling back to stderr). Always resolves; a
 * failed or silent probe reports `unknown` and never throws.
 */
export function probeClientVersion(
  executable: string,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<VersionProbe> {
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (probe: VersionProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; the result is still unknown.
      }
      finish({ source: "unknown", error: "version probe timed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      finish({ source: "unknown", error: "version probe failed" });
      void error;
    });
    child.once("close", () => {
      const version = parseVersionToken(stdout) ?? parseVersionToken(stderr);
      finish(version === undefined ? { source: "unknown" } : { version, source: "cli-output" });
    });
  });
}
