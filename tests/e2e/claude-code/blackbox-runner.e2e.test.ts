import { describe, expect, it } from "vitest";
import { runInstalledClientMatrix } from "../../../src/canary/installed-runner.js";
import { detectInstalledClients } from "../../../src/canary/installed.js";
import { CLAUDE_CODE_CONTRACT } from "../../../src/canary/client-fixtures.js";
import type { ClaimFeature } from "../../../src/canary/claim.js";

/**
 * Layer B real-binary sentinel E2E (#123). Runs the ACTUAL installed Claude
 * Code binary through the black-box runner against the controlled local
 * fixture server. Opt-in via `RLY_CLAUDE_E2E=1` (skipped ≠ pass — an unrun
 * gate never appears as PASS). The exact observed client version is recorded
 * separately from the reviewed supported baseline and evidence is keyed to the
 * observed version; a changed client behavior yields a typed gate failure.
 *
 * Reasoning/effort gates may report `not-run` when the installed client does
 * not send a reasoning/effort config for the default print invocation — that
 * is honest evidence (never PASS), not a skipped scenario.
 */
const enabled = process.env["RLY_CLAUDE_E2E"] === "1";
const timeoutMs = 300_000;

describe.skipIf(!enabled)("Layer B installed-client runner with the real Claude Code binary (#123)", () => {
  it("runs the black-box matrix against the actual installed binary and records exact versions separately", async () => {
    const installed = await detectInstalledClients(process.env);
    if (!installed.claude.found || installed.claude.version === undefined) {
      throw new Error("RLY_CLAUDE_E2E=1 requires an installed claude binary with a probeable version");
    }
    const summary = await runInstalledClientMatrix({
      client: "claude-code",
      executable: installed.claude.executable,
      observedVersion: installed.claude.version,
      supportedBaseline: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      environment: process.env,
      timeoutMs,
    });
    // Exact observed version is the evidence identity; the reviewed baseline
    // is recorded separately and never implied.
    expect(summary.observedVersion).toBe(installed.claude.version);
    expect(summary.supportedBaseline).toBe(CLAUDE_CODE_CONTRACT.baseline);
    expect(summary.gates.length).toBeGreaterThan(0);
    for (const record of summary.evidence) {
      expect(record.layer).toBe("B");
      expect(record.kind).toBe("installed-client");
      expect(record.claimKey.split("|")[2]).toBe(installed.claude.version);
      expect(record.claimKey.split("|")[2]).not.toBe(CLAUDE_CODE_CONTRACT.baseline);
    }
    // text/streaming/tools/cancellation/discovery must hold for the real
    // binary — these are the behaviors RLY relies on for the supported surface.
    const requiredPassing: readonly ClaimFeature[] = ["text", "streaming", "cancellation", "tools-single", "model-discovery", "session-attribution", "long-running-session", "config-overlay"];
    for (const gate of requiredPassing) {
      const result = summary.gates.find((candidate) => candidate.gate === gate);
      expect(result, `gate ${gate}`).toBeDefined();
      expect(result?.result, `gate ${gate} = ${JSON.stringify(result)}`).toBe("passed");
    }
    // A changed client behavior is a typed gate failure keyed to this version,
    // never a silent pass.
    for (const gate of summary.gates) {
      if (gate.result === "failed") {
        expect(gate.failureReason).toMatch(/^(client-contract-drift|missing-agent-header|malformed-continuation|timeout-cancel-failure|effort-signal-lost|environment-inability)$/);
      }
    }
    // No secrets in any artifact the runner produced.
    const serialized = JSON.stringify({ gates: summary.gates, evidence: summary.evidence });
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}|OPENROUTER_API_KEY|api[_-]?key\s*[:=]/i);
  }, timeoutMs + 30_000);
});
