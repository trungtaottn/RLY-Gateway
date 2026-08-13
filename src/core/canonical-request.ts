export type ModelRole = "primary" | "fast" | "reasoning" | "unknown";

export type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; content: CanonicalContent[]; isError: boolean }
  | { type: "reasoning"; text: string }
  | { type: "redacted-reasoning"; data: string };

export type CanonicalTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type CanonicalToolChoice =
  | { type: "auto" | "any" | "none" }
  | { type: "tool"; name: string };

export type CanonicalMessage = Readonly<{ role: "user" | "assistant"; content: readonly CanonicalContent[] }>;

export type CanonicalRequest = Readonly<{
  id: string;
  source: Readonly<{
    protocol: "anthropic-messages" | "openai-responses";
    protocolVersion?: string;
    clientName?: string;
    clientVersion?: string;
  }>;
  requestedModel: string;
  modelRole: ModelRole;
  system: readonly CanonicalContent[];
  input: readonly CanonicalContent[];
  messages: readonly CanonicalMessage[];
  tools: readonly CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  stream: boolean;
  inference: Readonly<{
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: readonly string[];
    thinking?: "disabled" | "enabled" | "adaptive";
  }>;
  metadata: Readonly<{
    beta?: readonly string[];
    cacheControl?: readonly Readonly<{ scope: "system" | "message"; index: number }> [];
  }>;
}>;
