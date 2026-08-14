import { describe, it } from "vitest";

describe("codex oauth live smoke", () => {
  it.skipIf(process.env["AGENT_GATEWAY_LIVE_CODEX_OAUTH"] !== "1")("opt-in live smoke is disabled unless explicitly requested", () => {
    // Live smoke must never record secrets, prompts, or response bodies.
  });
});
