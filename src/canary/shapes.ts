import type { CanonicalEvent } from "../core/canonical-event.js";
import type { AgentContext } from "../core/agent-context.js";

/**
 * Synthetic, redacted gate fixture shapes (#24). These are clearly synthetic
 * markers — never real prompts, responses, or reasoning text. The canary gates
 * exercise the actual decoder/encoder/parser against these shapes so the
 * protocol contracts are pinned deterministically without any live client.
 */

/** Basic Anthropic Messages text request shape (synthetic marker text). */
export const SYNTHETIC_TEXT_REQUEST = Object.freeze({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "synthetic fixture text" }],
});

/** Streaming Anthropic Messages request shape. */
export const SYNTHETIC_STREAM_REQUEST = Object.freeze({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: true,
  messages: [{ role: "user", content: "synthetic fixture text" }],
});

/** Effort-carrying request shape matching the pinned supported baseline (#70). */
export const SYNTHETIC_EFFORT_REQUEST = Object.freeze({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  thinking: { type: "enabled" },
  effort: "high",
  messages: [{ role: "user", content: "synthetic fixture text" }],
});

/** Tool request shape with a single tool definition. */
export const SYNTHETIC_TOOL_REQUEST = Object.freeze({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  tools: [{ name: "Bash", description: "synthetic tool", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  messages: [{ role: "user", content: "synthetic tool fixture" }],
});

/** Full Claude Code attribution headers as the supported client sends them. */
export const SYNTHETIC_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-claude-code-session-id": "session-synthetic-0001",
  "x-claude-code-agent-id": "agent-synthetic-0001",
  "x-claude-code-parent-agent-id": "parent-synthetic-0001",
});

/** Second subagent attribution set for parallel-subagent isolation checks. */
export const SYNTHETIC_ATTRIBUTION_HEADERS_PARALLEL: Readonly<Record<string, string>> = Object.freeze({
  "x-claude-code-session-id": "session-synthetic-0001",
  "x-claude-code-agent-id": "agent-synthetic-0002",
  "x-claude-code-parent-agent-id": "parent-synthetic-0001",
});

export const SYNTHETIC_AGENT_CONTEXT: Readonly<AgentContext> = Object.freeze({
  claudeSessionId: "session-synthetic-0001",
  agentId: "agent-synthetic-0001",
  parentAgentId: "parent-synthetic-0001",
});

function base(requestId: string, sequence: number, providerId = "synthetic-provider", modelId = "claude-sonnet-4-5"): Omit<CanonicalEvent, "type"> {
  return { requestId, sequence, timestamp: "1970-01-01T00:00:00.000Z", providerId, modelId };
}

/** A deterministic text streaming run as the encoder would see it. */
export function syntheticTextStream(requestId = "req_synthetic_0001"): readonly CanonicalEvent[] {
  return Object.freeze([
    Object.freeze({ ...base(requestId, 0), type: "response-started", responseId: "msg_synthetic_0001" }),
    Object.freeze({ ...base(requestId, 1), type: "content-started", index: 0, contentType: "text" }),
    Object.freeze({ ...base(requestId, 2), type: "text-delta", index: 0, text: "synthetic" }),
    Object.freeze({ ...base(requestId, 3), type: "content-completed", index: 0 }),
    Object.freeze({ ...base(requestId, 4), type: "usage-updated", inputTokens: 2, outputTokens: 1 }),
    Object.freeze({ ...base(requestId, 5), type: "response-completed", stopReason: "end_turn" }),
  ]);
}

/** A deterministic single-tool-call run with a valid JSON argument delta. */
export function syntheticToolRun(requestId = "req_synthetic_0001"): readonly CanonicalEvent[] {
  return Object.freeze([
    Object.freeze({ ...base(requestId, 0), type: "response-started", responseId: "msg_synthetic_0002" }),
    Object.freeze({ ...base(requestId, 1), type: "content-started", index: 0, contentType: "tool-call", toolCallId: "toolcall_synthetic_0001", toolName: "Bash" }),
    Object.freeze({ ...base(requestId, 2), type: "tool-arguments-delta", index: 0, toolCallId: "toolcall_synthetic_0001", partialJson: "{\"command\":" }),
    Object.freeze({ ...base(requestId, 3), type: "tool-arguments-delta", index: 0, toolCallId: "toolcall_synthetic_0001", partialJson: "\"printf fixture\"}" }),
    Object.freeze({ ...base(requestId, 4), type: "content-completed", index: 0 }),
    Object.freeze({ ...base(requestId, 5), type: "response-completed", stopReason: "tool_use" }),
  ]);
}

/** A deterministic multi-tool continuation run (two interleaved tool blocks). */
export function syntheticMultiToolRun(requestId = "req_synthetic_0001"): readonly CanonicalEvent[] {
  return Object.freeze([
    Object.freeze({ ...base(requestId, 0), type: "response-started", responseId: "msg_synthetic_0003" }),
    Object.freeze({ ...base(requestId, 1), type: "content-started", index: 0, contentType: "tool-call", toolCallId: "toolcall_synthetic_0011", toolName: "Bash" }),
    Object.freeze({ ...base(requestId, 2), type: "tool-arguments-delta", index: 0, toolCallId: "toolcall_synthetic_0011", partialJson: "{\"command\":\"a\"}" }),
    Object.freeze({ ...base(requestId, 3), type: "content-started", index: 1, contentType: "tool-call", toolCallId: "toolcall_synthetic_0012", toolName: "Read" }),
    Object.freeze({ ...base(requestId, 4), type: "tool-arguments-delta", index: 1, toolCallId: "toolcall_synthetic_0012", partialJson: "{\"path\":\"b\"}" }),
    Object.freeze({ ...base(requestId, 5), type: "content-completed", index: 0 }),
    Object.freeze({ ...base(requestId, 6), type: "content-completed", index: 1 }),
    Object.freeze({ ...base(requestId, 7), type: "response-completed", stopReason: "tool_use" }),
  ]);
}

/** A deterministic reasoning + tool interleave run (#70 gate D). */
export function syntheticReasoningToolRun(requestId = "req_synthetic_0001"): readonly CanonicalEvent[] {
  return Object.freeze([
    Object.freeze({ ...base(requestId, 0), type: "response-started", responseId: "msg_synthetic_0004" }),
    Object.freeze({ ...base(requestId, 1), type: "content-started", index: 0, contentType: "reasoning" }),
    Object.freeze({ ...base(requestId, 2), type: "reasoning-delta", index: 0, text: "synthetic reasoning marker" }),
    Object.freeze({ ...base(requestId, 3), type: "content-completed", index: 0 }),
    Object.freeze({ ...base(requestId, 4), type: "content-started", index: 1, contentType: "tool-call", toolCallId: "toolcall_synthetic_0021", toolName: "Bash" }),
    Object.freeze({ ...base(requestId, 5), type: "tool-arguments-delta", index: 1, toolCallId: "toolcall_synthetic_0021", partialJson: "{\"command\":\"c\"}" }),
    Object.freeze({ ...base(requestId, 6), type: "content-completed", index: 1 }),
    Object.freeze({ ...base(requestId, 7), type: "response-completed", stopReason: "tool_use" }),
  ]);
}
