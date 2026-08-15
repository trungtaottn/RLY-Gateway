import type { ReasoningRequest } from "./reasoning.js";
import type { LogicalTier } from "../routing/model-tiers/types.js";
import type { AgentContext } from "./agent-context.js";
import type { FidelityEnvelope } from "./fidelity.js";

export type ModelRole = "primary" | "fast" | "reasoning" | LogicalTier | "unknown";

export type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; content: CanonicalContent[]; isError: boolean }
  | { type: "reasoning"; text: string; id?: string }
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
    /** Source-mode view (legacy); kept for compatibility. #70 uses `reasoning`. */
    thinking?: "disabled" | "enabled" | "adaptive";
    /** Provider-neutral reasoning intent plus source fidelity (#70). */
    reasoning?: ReasoningRequest;
  }>;
  metadata: Readonly<{
    beta?: readonly string[];
    cacheControl?: readonly Readonly<{ scope: "system" | "message"; index: number }> [];
  }>;
  continuation?: Readonly<{ previousResponseId: string }>;
  /** Claude Code agent attribution context (#71). Runtime data; never authorization. */
  agent?: AgentContext;
  /**
   * Versioned fidelity/continuation envelope (#119): opaque continuation
   * artifacts (signatures, encrypted content) and translation provenance.
   * Never diagnostics; never serialized into route traces.
   */
  fidelity?: FidelityEnvelope;
}>;
