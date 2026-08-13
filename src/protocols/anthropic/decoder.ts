import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityRequirement } from "../../core/capabilities.js";
import type { CanonicalContent, CanonicalRequest, CanonicalToolChoice } from "../../core/canonical-request.js";

const cacheControl = z.object({ type: z.literal("ephemeral") }).optional();
const textBlock = z.object({ type: z.literal("text"), text: z.string(), cache_control: cacheControl });
const imageBlock = z.object({ type: z.literal("image"), source: z.object({ type: z.literal("base64"), media_type: z.string().min(1), data: z.string().min(1) }), cache_control: cacheControl });
const toolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown() });
const toolResultBlock = z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1), content: z.union([z.string(), z.array(z.unknown())]).optional(), is_error: z.boolean().optional(), cache_control: cacheControl });
const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: z.string() });
const redactedThinkingBlock = z.object({ type: z.literal("redacted_thinking"), data: z.string() });
const contentBlock = z.discriminatedUnion("type", [textBlock, imageBlock, toolUseBlock, toolResultBlock, thinkingBlock, redactedThinkingBlock]);
const content = z.union([z.string(), z.array(contentBlock)]);
const tool = z.object({ name: z.string().min(1), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()) });
const rawSchema = z.object({
  model: z.string().min(1), max_tokens: z.number().int().positive(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content })),
  system: z.union([z.string(), z.array(textBlock)]).optional(), tools: z.array(tool).optional(),
  tool_choice: z.union([z.object({ type: z.enum(["auto", "any", "none"]) }), z.object({ type: z.literal("tool"), name: z.string().min(1) })]).optional(),
  stream: z.boolean().optional(), temperature: z.number().min(0).max(1).optional(), top_p: z.number().min(0).max(1).optional(), stop_sequences: z.array(z.string()).optional(),
  thinking: z.object({ type: z.enum(["enabled", "disabled", "adaptive"]) }).optional(), metadata: z.object({}).loose().optional(),
}).loose();

export class AnthropicProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = "AnthropicProtocolError"; }
}

export type DecodedAnthropicRequest = Readonly<{ request: CanonicalRequest; required: readonly CapabilityRequirement[]; ignoredAdditiveFields: readonly string[] }>;

function blocks(value: z.infer<typeof content>): CanonicalContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return value.map((block): CanonicalContent => {
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "image": return { type: "image", mediaType: block.source.media_type, data: block.source.data };
      case "tool_use": return { type: "tool-call", id: block.id, name: block.name, input: block.input };
      case "thinking": return { type: "reasoning", text: block.thinking };
      case "redacted_thinking": return { type: "redacted-reasoning", data: block.data };
      case "tool_result": return { type: "tool-result", toolCallId: block.tool_use_id, content: typeof block.content === "string" ? blocks(block.content) : Array.isArray(block.content) ? blocks(contentBlock.array().parse(block.content)) : [], isError: block.is_error ?? false };
    }
  });
}

export function decodeAnthropicRequest(raw: unknown, headers: Record<string, string | string[] | undefined> = {}): DecodedAnthropicRequest {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) throw new AnthropicProtocolError("invalid_request_error", "Request does not match the supported Messages contract");
  const value = parsed.data;
  const beta = headers["anthropic-beta"];
  const betaValues = typeof beta === "string" ? beta.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const system = value.system === undefined ? [] : typeof value.system === "string" ? [{ type: "text", text: value.system } satisfies CanonicalContent] : value.system.map((block) => ({ type: "text", text: block.text } satisfies CanonicalContent));
  const messages = value.messages.map((message) => ({ role: message.role, content: blocks(message.content) }));
  const input = messages.flatMap((message) => message.content);
  const required: CapabilityRequirement[] = [];
  if (value.stream) required.push("streaming");
  if (value.tools?.length) required.push("tools");
  if (input.some((item) => item.type === "image")) required.push("images");
  if (input.some((item) => item.type === "reasoning")) required.push("reasoning");
  if (input.some((item) => item.type === "redacted-reasoning")) required.push("redactedReasoning");
  if (value.thinking?.type === "enabled" || value.thinking?.type === "adaptive") required.push("reasoning");
  const choice: CanonicalToolChoice | undefined = value.tool_choice;
  const recognized = new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "stream", "temperature", "top_p", "stop_sequences", "thinking", "metadata"]);
  const ignored = Object.keys(value).filter((key) => !recognized.has(key));
  const cacheControl = [
    ...(value.system && typeof value.system !== "string" ? value.system.flatMap((item, index) => item.cache_control ? [{ scope: "system" as const, index }] : []) : []),
    ...value.messages.flatMap((message, index) => typeof message.content === "string" || !JSON.stringify(message.content).includes("\"cache_control\"") ? [] : [{ scope: "message" as const, index }]),
  ];
  return {
    request: {
      id: randomUUID(), source: { protocol: "anthropic-messages", ...(typeof headers["anthropic-version"] === "string" ? { protocolVersion: headers["anthropic-version"] } : {}) }, requestedModel: value.model, modelRole: "unknown",
      system, input, messages, tools: (value.tools ?? []).map((item) => ({ name: item.name, ...(item.description === undefined ? {} : { description: item.description }), inputSchema: item.input_schema })), ...(choice === undefined ? {} : { toolChoice: choice }),
      stream: value.stream ?? false, inference: { maxOutputTokens: value.max_tokens, ...(value.temperature === undefined ? {} : { temperature: value.temperature }), ...(value.top_p === undefined ? {} : { topP: value.top_p }), ...(value.stop_sequences === undefined ? {} : { stopSequences: value.stop_sequences }), ...(value.thinking?.type === undefined ? {} : { thinking: value.thinking.type }) },
      metadata: { ...(betaValues.length === 0 ? {} : { beta: betaValues }), ...(cacheControl.length === 0 ? {} : { cacheControl }) },
    }, required, ignoredAdditiveFields: ignored,
  };
}
