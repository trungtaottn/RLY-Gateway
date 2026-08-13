import { describe, expect, it } from "vitest";
import { missingCapabilities, type ProviderCapabilities } from "../../src/core/capabilities.js";

const capabilities: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
};

describe("missingCapabilities", () => {
  it("returns only unsupported requirements", () => {
    expect(missingCapabilities(capabilities, ["streaming", "tools", "images"])).toEqual(["images"]);
  });
});

