import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/decoder.js";
import { describeFidelity } from "../../src/core/fidelity.js";
import { decideRoute, type RouteRecord } from "../../src/core/router.js";
import { redact } from "../../src/observability/redaction.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: true, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const baseRoute: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

describe("opaque continuation artifacts stay out of diagnostics (#119)", () => {
  it("never exposes Anthropic thinking signature values in fidelity summaries", () => {
    const decoded = decodeAnthropicRequest({
      model: "fixture-model",
      max_tokens: 1,
      messages: [
        { role: "user", content: "fixture" },
        { role: "assistant", content: [{ type: "thinking", thinking: "fixture reasoning", signature: "synthetic-thinking-signature-value" }] },
      ],
    });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    if (!envelope) throw new Error("expected envelope");
    expect(JSON.stringify(describeFidelity(envelope))).not.toContain("synthetic-thinking-signature-value");
  });

  it("never exposes OpenAI encrypted reasoning content in fidelity summaries", () => {
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    if (!envelope) throw new Error("expected envelope");
    expect(JSON.stringify(describeFidelity(envelope))).not.toContain("synthetic-encrypted-content-value");
  });

  it("redacts opaque artifact values when a raw diagnostic object is redacted", () => {
    // The fidelity envelope is never a diagnostic, but if it is ever fed to the
    // shared redactor the opaque `value` must be treated as sensitive content.
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    const envelope = decoded.request.fidelity;
    if (!envelope) throw new Error("expected envelope");
    const redacted = redact(envelope);
    expect(JSON.stringify(redacted)).not.toContain("synthetic-encrypted-content-value");
  });

  it("keeps reasoning summary text and opaque values separate", () => {
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    const reasoning = decoded.request.messages[0]?.content[0];
    expect(reasoning).toMatchObject({ type: "reasoning", text: "fixture summary" });
    expect(JSON.stringify(reasoning)).not.toContain("synthetic-encrypted-content-value");
  });

  it("keeps opaque artifact values out of semantic route decisions and traces", () => {
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    // decideRoute receives only the request id; the fidelity envelope never
    // becomes part of the immutable RouteDecision that traces serialize.
    const decision = decideRoute({ requestId: decoded.request.id, route: baseRoute, required: decoded.required, configFingerprint: "a".repeat(64) });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("synthetic-encrypted-content-value");
    expect(serialized).not.toContain("encrypted_content");
    expect(serialized).not.toContain("fidelity");

    const anthropic = decodeAnthropicRequest({
      model: "fixture-model",
      max_tokens: 1,
      messages: [
        { role: "user", content: "fixture" },
        { role: "assistant", content: [{ type: "thinking", thinking: "fixture reasoning", signature: "synthetic-thinking-signature-value" }] },
      ],
    });
    const anthropicDecision = decideRoute({ requestId: anthropic.request.id, route: baseRoute, required: anthropic.required, configFingerprint: "a".repeat(64) });
    expect(JSON.stringify(anthropicDecision)).not.toContain("synthetic-thinking-signature-value");
    expect(JSON.stringify(anthropicDecision)).not.toContain("signature");
  });
});
