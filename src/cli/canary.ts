import { loadConfig } from "../config/load-config.js";
import { CanaryStore, ClaimEvidenceStore } from "../canary/artifact.js";
import { canaryStatusSummary, runCanary } from "../canary/run.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";

/**
 * `rly canary run|status` (#24 / BL-043, evidence v2 by #122).
 *
 * `run` executes the deterministic fake matrix over the reviewed registry
 * access paths (Layer A evidence), probes the installed Claude Code / Codex
 * CLI versions, persists a secret-free evidence artifact under
 * `<control-plane>/canary/`, and appends feature-scoped Compatibility Claim +
 * Evidence v2 documents under `<control-plane>/claims/`. The fake matrix never
 * fabricates live evidence: the `RLY_LIVE_CANARY` switch may enable an opt-in
 * runner (#123), but it can never stand in for an evidence artifact, so a run
 * never classifies any path VERIFIED — fake-only Layer A evidence is
 * `EXPERIMENTAL` at most. `status` prints the tested baselines, latest
 * per-path verdicts, and claim/evidence schema status. The canary never
 * mutates trusted registry evidence.
 */

export type CanaryAction = "run" | "status";

export async function runCanaryCommand(action: CanaryAction, configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const store = new CanaryStore(controlPlaneDirectory);
  const claimStore = new ClaimEvidenceStore(controlPlaneDirectory);
  if (action === "status") {
    const summaries = await store.list();
    const claims = await claimStore.summary();
    console.log(JSON.stringify({ ...canaryStatusSummary(summaries), claimEvidence: claims }));
    return summaries.length > 0 ? 0 : 1;
  }
  const summary = await runCanary({ environment: process.env });
  const artifactPath = await store.write(summary);
  await claimStore.appendRun(summary, { ref: artifactPath });
  console.log(JSON.stringify({ ...summary, artifactPath }));
  return summary.ok ? 0 : 1;
}
