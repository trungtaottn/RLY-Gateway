import { loadConfig } from "../config/load-config.js";
import { CanaryStore, ClaimEvidenceStore } from "../canary/artifact.js";
import { canaryStatusSummary, runCanary, adapterIdForProvider, RLY_LIVE_CANARY_ENV } from "../canary/run.js";
import { appendObservation, emptyClaimDocument, authModeForAdapter, type CompatibilityClaimDocument, type EvidenceArtifactV2 } from "../canary/claim.js";
import { CLAUDE_CODE_CONTRACT, CODEX_CLI_CONTRACT } from "../canary/client-fixtures.js";
import { detectInstalledClients, testedBaselineFor } from "../canary/installed.js";
import { runInstalledClientMatrix } from "../canary/installed-runner.js";
import { runLiveAccessPath } from "../canary/live-runner.js";
import { RunnerResultStore } from "../canary/runner-store.js";
import type { InstalledClientRunSummary, LiveAccessPathSummary, RunnerGateObservation } from "../canary/runner-types.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import { providerContract } from "../providers/catalog.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import type { GatewayConfig } from "../config/schema.js";

/**
 * `rly canary run|status|run-b|run-c` (#24 / BL-043, evidence v2 by #122,
 * Layer B/C runners by #123).
 *
 * - `run` executes the deterministic fake matrix over the reviewed registry
 *   access paths (Layer A evidence), probes installed Claude Code / Codex CLI
 *   versions, persists a secret-free evidence artifact under
 *   `<control-plane>/canary/`, and appends feature-scoped Compatibility Claim
 *   + Evidence v2 documents under `<control-plane>/claims/`. A run never
 *   classifies any path VERIFIED — fake-only Layer A evidence is
 *   `EXPERIMENTAL` at most.
 * - `run-b` executes the Layer B installed-client black-box matrix with the
 *   ACTUAL installed Claude Code / Codex CLI binaries against controlled
 *   local fixtures, keyed to the exact observed client version (observed ≠
 *   reviewed baseline; no auto-promotion). Requires the binaries to be
 *   installed; a missing binary emits no evidence (exit 1), never PASS.
 * - `run-c` executes the Layer C live access-path matrix over each configured
 *   route (exact provider/auth/endpoint/model path) through the RLY gateway
 *   translation stack. Explicit opt-in ONLY: refuses to run unless
 *   `RLY_LIVE_CANARY=1`; a missing credential env emits `not-run` evidence
 *   (`authentication-credentials-unavailable`), never PASS. Never spends
 *   quota during normal test execution.
 * - `status` prints the tested baselines, latest per-path verdicts, and
 *   claim/evidence schema status.
 *
 * Exit codes: `run` is 1 when a path is BROKEN; `run-b`/`run-c` return 0 when
 * the runner executed and emitted evidence (gate results are observations for
 * #124 review, not enforcement) and 1 when nothing could run (refused, no
 * binaries, no routes, no credentials).
 */

export type CanaryAction = "run" | "status" | "run-b" | "run-c";

function claimEvidenceView(summary: Readonly<{ claims: readonly CompatibilityClaimDocument[] }>): Readonly<{
  claimCount: number;
  recordCount: number;
  layers: readonly ("A" | "B" | "C")[];
  passed: number;
  failed: number;
  notRun: number;
}> {
  const records = summary.claims.flatMap((claim) => claim.records);
  return Object.freeze({
    claimCount: summary.claims.length,
    recordCount: records.length,
    layers: Object.freeze([...new Set(records.map((record) => record.layer))].sort()),
    passed: records.filter((record) => record.result === "passed").length,
    failed: records.filter((record) => record.result === "failed").length,
    notRun: records.filter((record) => record.result === "not-run").length,
  });
}

function gatesView(gates: readonly RunnerGateObservation[]): readonly Readonly<{ gate: string; result: string; reason?: string; detail?: string; timingMs?: number }>[] {
  return Object.freeze(gates.map((gate) => Object.freeze({
    gate: gate.gate,
    result: gate.result,
    ...(gate.failureReason === undefined ? {} : { reason: gate.failureReason }),
    ...(gate.detail === undefined ? {} : { detail: gate.detail }),
    ...(gate.timingMs === undefined ? {} : { timingMs: gate.timingMs }),
  })));
}

async function persistRunnerClaims(
  claimStore: ClaimEvidenceStore,
  summary: Readonly<{ claims: readonly CompatibilityClaimDocument[] }>,
  ref: string,
): Promise<void> {
  for (const claim of summary.claims) {
    let doc = await claimStore.loadClaim(claim.claimKey) ?? emptyClaimDocument(claim.claimIdentity, claim.feature);
    for (const record of claim.records) {
      const withRef: EvidenceArtifactV2 = Object.freeze({ ...record, ref });
      doc = appendObservation(doc, withRef);
    }
    await claimStore.writeClaim(doc);
  }
}

async function runLayerB(controlPlaneDirectory: string): Promise<number> {
  const installed = await detectInstalledClients(process.env);
  const resultStore = new RunnerResultStore(controlPlaneDirectory);
  const claimStore = new ClaimEvidenceStore(controlPlaneDirectory);
  const executed: InstalledClientRunSummary[] = [];
  const skipped: readonly Readonly<{ client: string; found: boolean; executable: string; error: string }>[] = Object.freeze(
    [installed.claude, installed.codex].flatMap((candidate) => {
      if (!candidate.found) {
        return [{ client: candidate.kind, found: false, executable: candidate.executable, error: "client-not-installed" }];
      }
      if (candidate.version === undefined) {
        return [{ client: candidate.kind, found: true, executable: candidate.executable, error: "version-probe-failed" }];
      }
      return [];
    }),
  );
  for (const candidate of [installed.claude, installed.codex]) {
    if (!candidate.found || candidate.version === undefined) continue;
    const contract = candidate.kind === "claude-code" ? CLAUDE_CODE_CONTRACT : CODEX_CLI_CONTRACT;
    const summary = await runInstalledClientMatrix({
      client: candidate.kind,
      executable: candidate.executable,
      observedVersion: candidate.version,
      supportedBaseline: testedBaselineFor(candidate.kind).baseline,
      contract,
      environment: process.env,
    });
    const ref = await resultStore.write(
      `installed-${candidate.kind}-${candidate.version.replace(/[^A-Za-z0-9._-]/g, "-")}`,
      Object.freeze({
        runner: "installed-client",
        runnerVersion: "rly-installed-client-runner/1.0",
        client: candidate.kind,
        executable: candidate.executable,
        observedVersion: candidate.version,
        supportedBaseline: testedBaselineFor(candidate.kind).baseline,
        fixtureRevision: summary.fixtureRevision,
        gates: gatesView(summary.gates),
        checkedAt: summary.environment,
      }),
    );
    await persistRunnerClaims(claimStore, summary, ref);
    executed.push(summary);
  }
  const output = Object.freeze({
    layer: "B",
    executed: executed.map((summary) => Object.freeze({
      client: summary.client,
      executable: summary.executable,
      observedVersion: summary.observedVersion,
      supportedBaseline: summary.supportedBaseline,
      fixtureRevision: summary.fixtureRevision,
      gates: gatesView(summary.gates),
      evidence: claimEvidenceView(summary),
    })),
    skipped,
    note: "Layer B evidence is keyed to the exact observed client version; observed never equals the reviewed supported baseline and is never auto-promoted (#123/#124).",
  });
  console.log(JSON.stringify(output));
  return executed.length > 0 ? 0 : 1;
}

type LiveRouteSpec = Readonly<{
  role: string;
  provider: string;
  model: string;
  credentialEnvName?: string;
  baseUrl: string;
  error?: string;
}>;

function liveRouteSpecs(config: GatewayConfig): readonly LiveRouteSpec[] {
  const specs: LiveRouteSpec[] = [];
  for (const [role, route] of Object.entries(config.routes)) {
    if (route === undefined) continue;
    const contract = providerContract(route.provider);
    const baseUrl = route.baseUrl ?? contract?.defaultEndpoint ?? "";
    if (contract === undefined) {
      specs.push({ role, provider: route.provider, model: route.model, baseUrl, error: "unsupported-provider" });
      continue;
    }
    let credentialEnvName: string | undefined;
    try {
      const parsed = parseCredentialRef(route.credential);
      if (parsed.kind !== "env") {
        specs.push({ role, provider: route.provider, model: route.model, baseUrl, error: "credential-not-env" });
        continue;
      }
      credentialEnvName = parsed.name;
    } catch {
      specs.push({ role, provider: route.provider, model: route.model, baseUrl, error: "credential-invalid" });
      continue;
    }
    specs.push({ role, provider: route.provider, model: route.model, credentialEnvName, baseUrl });
  }
  return Object.freeze(specs);
}

async function runLayerC(configPath: string, controlPlaneDirectory: string): Promise<number> {
  if (process.env[RLY_LIVE_CANARY_ENV] !== "1") {
    console.log(JSON.stringify({
      layer: "C",
      ok: false,
      error: "live-runner-not-opted-in",
      note: `set ${RLY_LIVE_CANARY_ENV}=1 to allow live access-path runs; a skipped run never produces PASS evidence`,
    }));
    return 1;
  }
  const config = await loadConfig(configPath);
  const resultStore = new RunnerResultStore(controlPlaneDirectory);
  const claimStore = new ClaimEvidenceStore(controlPlaneDirectory);
  const executed: LiveAccessPathSummary[] = [];
  const skipped: readonly Readonly<{ role: string; provider: string; model: string; error: string }>[] = Object.freeze(
    liveRouteSpecs(config).flatMap((spec) => {
      if (spec.error !== undefined) {
        return [{ role: spec.role, provider: spec.provider, model: spec.model, error: spec.error }];
      }
      return [];
    }),
  );
  for (const spec of liveRouteSpecs(config)) {
    if (spec.error !== undefined || spec.credentialEnvName === undefined) continue;
    const adapterId = adapterIdForProvider(spec.provider);
    const summary = await runLiveAccessPath({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId,
      accessProviderId: spec.provider,
      authMode: authModeForAdapter(adapterId),
      endpointContract: "anthropic-messages",
      physicalModelId: spec.model,
      providerBaseUrl: spec.baseUrl,
      credentialEnvName: spec.credentialEnvName,
      environment: process.env,
    });
    const ref = await resultStore.write(
      `live-${spec.provider}-${spec.model.replace(/[^A-Za-z0-9._-]/g, "-")}`,
      Object.freeze({
        runner: "live-access-path",
        runnerVersion: "rly-live-access-path-runner/1.0",
        role: spec.role,
        provider: spec.provider,
        model: spec.model,
        credentialEnvName: spec.credentialEnvName,
        baseUrl: spec.baseUrl,
        gates: gatesView(summary.gates),
      }),
    );
    await persistRunnerClaims(claimStore, summary, ref);
    executed.push(summary);
  }
  const output = Object.freeze({
    layer: "C",
    executed: executed.map((summary) => Object.freeze({
      claimIdentity: summary.claimIdentity,
      gates: gatesView(summary.gates),
      evidence: claimEvidenceView(summary),
      ...(summary.error === undefined ? {} : { error: summary.error }),
    })),
    skipped,
    note: "Layer C runs only on explicit opt-in (RLY_LIVE_CANARY=1) with available credentials; missing credentials or skipped runs never appear as PASS.",
  });
  console.log(JSON.stringify(output));
  return executed.length > 0 ? 0 : 1;
}

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
  if (action === "run-b") return runLayerB(controlPlaneDirectory);
  if (action === "run-c") return runLayerC(configPath, controlPlaneDirectory);
  const summary = await runCanary({ environment: process.env });
  const artifactPath = await store.write(summary);
  await claimStore.appendRun(summary, { ref: artifactPath });
  console.log(JSON.stringify({ ...summary, artifactPath }));
  return summary.ok ? 0 : 1;
}
