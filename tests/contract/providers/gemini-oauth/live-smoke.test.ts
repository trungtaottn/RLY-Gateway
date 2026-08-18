import { describe, expect, it } from "vitest";
import { GEMINI_CLIENT_ID_ENV } from "../../../../src/providers/oauth/gemini/protocol.js";

const enabled = process.env["RLY_LIVE_GEMINI_OAUTH"] === "1";

describe.skipIf(!enabled)("Gemini OAuth live smoke", () => {
  it("requires a project-owned client id and never impersonates Gemini CLI or Code Assist", () => {
    expect(process.env[GEMINI_CLIENT_ID_ENV], "set RLY_GEMINI_OAUTH_CLIENT_ID for live smoke").toBeTruthy();
    expect(process.env[GEMINI_CLIENT_ID_ENV]).not.toMatch(/cloudcode-pa|gemini-cli/i);
  });
});
