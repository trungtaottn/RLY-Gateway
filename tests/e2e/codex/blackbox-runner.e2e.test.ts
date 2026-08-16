import { describe, expect, it } from "vitest";
import { runInstalledClientMatrix } from "../../../src/canary/installed-runner.js";
import { detectInstalledClients } from "../../../src/canary/installed.js";
import { CODEX_CLI_CONTRACT } from "../../../src/canary/client-fixtures.js";

/**
 * Layer B real-binary sentinel E2E (#123) for the Codex CLI. Runs the ACTUAL
 * installed `codex` binary through the black-box runner against the controlled
 * local OpenAI Responses fixture server. Opt-in via `RLY_CODEX_E2E=1`
 * (skipped ≠ pass). Evidence is keyed to the exact observed client version and
 * the observed provisional Codex target is never a supported baseline.
 *
 * This is a drift-surveillance sentinel, not a pass gate: the installed Codex
 * binary may legitimately not route through a configurable base URL (e.g. the
 * observed 0.147.0 binary hardcodes the OpenAI websocket endpoint and ignores
 * `OPENAI_BASE_URL`). Gates then report typed failures/`not-run` keyed to that
 * exact version — never a silent pass. #124 owns review/promotion.
 */
const enabled = process.env["RLY_CODEX_E2E"] === "1";
const gateTimeoutMs = 25_000;
const timeoutMs = 330_000;

describe.skipIf(!enabled)("Layer B installed-client runner with the real Codex CLI binary (#123)", () => {
  it("runs the black-box matrix against the actual installed codex binary and records typed, version-keyed outcomes", async () => {
    const installed = await detectInstalledClients(process.env);
    if (!installed.codex.found || installed.codex.version === undefined) {
      throw new Error("RLY_CODEX_E2E=1 requires an installed codex binary with a probeable version");
    }
    const summary = await runInstalledClientMatrix({
      client: "codex-cli",
      executable: installed.codex.executable,
      observedVersion: installed.codex.version,
      supportedBaseline: CODEX_CLI_CONTRACT.baseline,
      contract: CODEX_CLI_CONTRACT,
      environment: process.env,
      timeoutMs: gateTimeoutMs,
    });
    expect(summary.observedVersion).toBe(installed.codex.version);
    expect(summary.gates.length).toBeGreaterThan(0);
    for (const record of summary.evidence) {
      expect(record.layer).toBe("B");
      expect(record.kind).toBe("installed-client");
      expect(record.claimKey.split("|")[2]).toBe(installed.codex.version);
    }
    // Every gate produced a typed outcome for the exact observed version.
    for (const gate of summary.gates) {
      expect(["passed", "failed", "not-run"]).toContain(gate.result);
      if (gate.result !== "passed") {
        expect(gate.failureReason).toBeDefined();
        expect(gate.failureReason).toMatch(/^(client-contract-drift|missing-agent-header|malformed-continuation|timeout-cancel-failure|environment-inability|client-did-not-send-reasoning-config|client-did-not-send-effort-signal|effort-signal-lost)$/);
      }
      expect(gate.timingMs).toBeGreaterThan(0);
    }
    // No secrets in any artifact the runner produced.
    const serialized = JSON.stringify({ gates: summary.gates, evidence: summary.evidence });
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}|OPENAI_API_KEY|api[_-]?key\s*[:=]/i);
  }, timeoutMs);
});
