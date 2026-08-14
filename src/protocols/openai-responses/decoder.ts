import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityRequirement } from "../../core/capabilities.js";
import type { CanonicalContent, CanonicalMessage, CanonicalRequest, CanonicalToolChoice } from "../../core/canonical-request.js";

const textPart = z.object({ type: z.enum(["input_text", "output_text", "text"]), text: z.string() });
const imagePart = z.object({
  type: z.enum(["input_image", "image_url"]),
  image_url: z.union([z.string(), z.object({ url: z.string().min(1) })]).optional(),
  source: z.object({ media_type: z.string().min(1), data: z.string().min(1) }).optional(),
});
const functionTool = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
const messageItem = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(z.union([textPart, imagePart, z.object({ type: z.string() }).loose()]))]),
});
const functionCallItem = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string().optional(),
});
const functionOutputItem = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.unknown())]),
});
const reasoningItem = z.object({
  type: z.literal("reasoning"),
  summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).optional(),
});
const knownItem = z.discriminatedUnion("type", [messageItem, functionCallItem, functionOutputItem, reasoningItem]);
const rawSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.unknown())]).optional(),
  instructions: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), name: z.string().min(1) })]).optional(),
  stream: z.boolean().optional(),
  previous_response_id: z.string().min(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  reasoning: z.object({ effort: z.string().optional() }).optional(),
  include: z.array(z.string()).optional(),
  metadata: z.object({}).loose().optional(),
}).loose();

export class ResponsesProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ResponsesProtocolError";
  }
}

export type DecodedResponsesRequest = Readonly<{
  request: CanonicalRequest;
  required: readonly CapabilityRequirement[];
  ignoredAdditiveFields: readonly string[];
}>;

const RECOGNIZED = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "previous_response_id",
  "max_output_tokens", "temperature", "top_p", "reasoning", "include", "metadata", "store",
]);
const SUPPORTED_INCLUDE = new Set(["reasoning.encrypted_content"]);

function parseImage(part: z.infer<typeof imagePart>): CanonicalContent {
  if (part.source) return { type: "image", mediaType: part.source.media_type, data: part.source.data };
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  const match = url?.match(/^data:([^;]+);base64,(.+)$/);
  if (!match?.[1] || !match[2]) throw new ResponsesProtocolError("invalid_request_error", "Image parts must be data URLs or inline source");
  return { type: "image", mediaType: match[1], data: match[2] };
}

function parseMessageContent(content: z.infer<typeof messageItem>["content"]): CanonicalContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      return { type: "text" as const, text: "text" in part ? String(part.text) : "" };
    }
    if (part.type === "input_image" || part.type === "image_url") return parseImage(imagePart.parse(part));
    throw new ResponsesProtocolError("compatibility_unready", `Unsupported required content type: ${part.type}`);
  });
}

function parseJsonOrRaw(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function parseItem(raw: unknown): { role?: "user" | "assistant"; content: CanonicalContent[]; system?: CanonicalContent } {
  const typed = z.object({ type: z.string() }).loose().safeParse(raw);
  if (!typed.success) throw new ResponsesProtocolError("invalid_request_error", "Input item is not an object");
  const parsed = knownItem.safeParse(raw);
  if (!parsed.success) {
    throw new ResponsesProtocolError("compatibility_unready", `Unsupported required input item: ${typed.data.type}`);
  }
  switch (parsed.data.type) {
    case "message": {
      const content = parseMessageContent(parsed.data.content);
      if (parsed.data.role === "system") return content[0] === undefined ? { content: [] } : { system: content[0], content: [] };
      return { role: parsed.data.role, content };
    }
    case "function_call":
      return {
        role: "assistant",
        content: [{
          type: "tool-call",
          id: parsed.data.call_id,
          name: parsed.data.name,
          input: parsed.data.arguments ? parseJsonOrRaw(parsed.data.arguments) : {},
        }],
      };
    case "function_call_output": {
      const text = typeof parsed.data.output === "string" ? parsed.data.output : JSON.stringify(parsed.data.output);
      return { role: "user", content: [{ type: "tool-result", toolCallId: parsed.data.call_id, content: [{ type: "text", text }], isError: false }] };
    }
    case "reasoning":
      return { role: "assistant", content: [{ type: "reasoning", text: parsed.data.summary?.map((item) => item.text).join("\n") ?? "" }] };
  }
}

function parseTools(raw: readonly unknown[] | undefined): CanonicalRequest["tools"] {
  if (!raw?.length) return [];
  return raw.map((item) => {
    const parsed = functionTool.safeParse(item);
    if (!parsed.success) {
      const type = typeof item === "object" && item !== null && "type" in item ? String(item.type) : "unknown";
      throw new ResponsesProtocolError("compatibility_unready", `Unsupported required tool type: ${type}`);
    }
    return { name: parsed.data.name, ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }), inputSchema: parsed.data.parameters ?? {} };
  });
}

function parseToolChoice(value: z.infer<typeof rawSchema>["tool_choice"]): CanonicalToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none") return { type: value };
  if (value === "required") return { type: "any" };
  return { type: "tool", name: value.name };
}

function inputItems(input: z.infer<typeof rawSchema>["input"]): readonly unknown[] {
  if (input === undefined) return [];
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  return input;
}

/** Loss-aware decode of OpenAI Responses into the shared canonical request. */
export function decodeResponsesRequest(raw: unknown, headers: Record<string, string | string[] | undefined> = {}): DecodedResponsesRequest {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "body"))].slice(0, 8);
    throw new ResponsesProtocolError("invalid_request_error", `Request does not match the supported Responses fields: ${paths.join(", ")}`);
  }
  const value = parsed.data;
  for (const include of value.include ?? []) {
    if (!SUPPORTED_INCLUDE.has(include)) {
      throw new ResponsesProtocolError("compatibility_unready", `Unsupported required include: ${include}`);
    }
  }
  const system: CanonicalContent[] = value.instructions === undefined ? [] : [{ type: "text", text: value.instructions }];
  const messages: CanonicalMessage[] = [];
  for (const item of inputItems(value.input)) {
    const decoded = parseItem(item);
    if (decoded.system) system.push(decoded.system);
    if (decoded.role && decoded.content.length > 0) messages.push({ role: decoded.role, content: decoded.content });
  }
  const input = messages.flatMap((message) => message.content);
  const required: CapabilityRequirement[] = [];
  if (value.stream) required.push("streaming");
  if (value.tools?.length) required.push("tools");
  if (input.some((item) => item.type === "image")) required.push("images");
  if (value.reasoning !== undefined || input.some((item) => item.type === "reasoning")) required.push("reasoning");
  const choice = parseToolChoice(value.tool_choice);
  const openaiBeta = headers["openai-beta"];
  const beta = typeof openaiBeta === "string" ? openaiBeta.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return {
    request: {
      id: randomUUID(),
      source: { protocol: "openai-responses", ...(typeof headers["openai-version"] === "string" ? { protocolVersion: headers["openai-version"] } : {}) },
      requestedModel: value.model,
      modelRole: "unknown",
      system,
      input,
      messages,
      tools: parseTools(value.tools),
      ...(choice === undefined ? {} : { toolChoice: choice }),
      stream: value.stream ?? false,
      inference: {
        ...(value.max_output_tokens === undefined ? {} : { maxOutputTokens: value.max_output_tokens }),
        ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
        ...(value.top_p === undefined ? {} : { topP: value.top_p }),
        ...(value.reasoning === undefined ? {} : { thinking: "enabled" as const }),
      },
      metadata: beta.length === 0 ? {} : { beta },
      ...(value.previous_response_id === undefined ? {} : { continuation: { previousResponseId: value.previous_response_id } }),
    },
    required,
    ignoredAdditiveFields: Object.keys(value).filter((key) => !RECOGNIZED.has(key)),
  };
}
