import { loadConfig } from "../config/load-config.js";
import { CanaryStore } from "../canary/artifact.js";
import { canaryStatusSummary, runCanary } from "../canary/run.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";

/**
 * `rly canary run|status` (#24 / BL-043).
 *
 * `run` executes the deterministic fake matrix over the reviewed registry
 * access paths, probes the installed Claude Code / Codex CLI versions, and
 * persists a secret-free evidence artifact under `<control-plane>/canary/`.
 * The fake matrix never fabricates live evidence: a separate opt-in live gate
 * (see `RLY_LIVE_CANARY`) is required before any access path can be VERIFIED;
 * fake-only evidence classifies EXPERIMENTAL at most. `status` prints the
 * tested baselines and latest per-path verdicts. The canary never mutates
 * trusted registry evidence.
 */

export type CanaryAction = "run" | "status";

export async function runCanaryCommand(action: CanaryAction, configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const store = new CanaryStore(controlPlaneDirectory);
  if (action === "status") {
    const summaries = await store.list();
    console.log(JSON.stringify(canaryStatusSummary(summaries)));
    return summaries.length > 0 ? 0 : 1;
  }
  const summary = await runCanary({ environment: process.env });
  const artifactPath = await store.write(summary);
  console.log(JSON.stringify({ ...summary, artifactPath }));
  return summary.ok ? 0 : 1;
}
