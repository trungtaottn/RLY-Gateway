import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_IDENTITY, parseBridgeUrl } from "../../../../src/providers/bridge/antigravity.js";

const enabled = process.env["AGENT_GATEWAY_LIVE_ANTIGRAVITY"] === "1";
const baseUrl = process.env["AGENT_GATEWAY_LIVE_ANTIGRAVITY_URL"] ?? "http://127.0.0.1:17874";

describe.skipIf(!enabled)("Antigravity bridge live smoke", () => {
  it("probes the attested loopback identity and stays off protected ports", async () => {
    const url = parseBridgeUrl(baseUrl);
    expect(url.hostname).toBe("127.0.0.1");
    const response = await fetch(`${url.origin}/identity`);
    expect(response.ok, "skipped live gate is not a pass; live bridge must answer /identity").toBe(true);
    const body = await response.json() as { product?: unknown };
    expect(body.product).toBe(ANTIGRAVITY_IDENTITY);
  });
});
