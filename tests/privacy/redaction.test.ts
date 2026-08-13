import { describe, expect, it } from "vitest";
import { redact } from "../../src/observability/redaction.js";

describe("redact", () => {
  it("recursively removes sensitive fields while retaining diagnostics", () => {
    expect(redact({
      requestId: "req-1",
      provider: "example",
      authorization: "hidden",
      nested: { apiKey: "hidden", timingMs: 12, prompt: "hidden" },
      items: [{ accountId: "hidden", status: "ready" }],
    })).toEqual({
      requestId: "req-1",
      provider: "example",
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", timingMs: 12, prompt: "[REDACTED]" },
      items: [{ accountId: "[REDACTED]", status: "ready" }],
    });
  });

  it("redacts canonical content even when nested under ordinary objects", () => {
    expect(redact({
      route: "primary",
      system: [{ type: "text", text: "private system text" }],
      input: [{ type: "text", text: "private user text" }],
      upstream: { payload: { body: "private provider body" } },
    })).toEqual({
      route: "primary",
      system: "[REDACTED]",
      input: "[REDACTED]",
      upstream: { payload: "[REDACTED]" },
    });
  });

  it("handles cyclic values without crashing", () => {
    const value: Record<string, unknown> = { status: "ready" };
    value.self = value;
    expect(redact(value)).toEqual({ status: "ready", self: "[CIRCULAR]" });
  });

  it("redacts standalone canonical event payload fields", () => {
    expect(redact({
      type: "text-delta",
      text: "private text",
      data: "private image data",
      partialJson: "private tool arguments",
      message: "private upstream message",
      sequence: 1,
    })).toEqual({
      type: "text-delta",
      text: "[REDACTED]",
      data: "[REDACTED]",
      partialJson: "[REDACTED]",
      message: "[REDACTED]",
      sequence: 1,
    });
  });
});
