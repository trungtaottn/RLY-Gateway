import { createHash } from "node:crypto";

/**
 * Claude Code agent attribution context (#71).
 *
 * Claude Code sends runtime attribution headers on every gateway request:
 * `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, and
 * `X-Claude-Code-Parent-Agent-Id`. These identifiers let the gateway
 * distinguish concurrent/nested subagent requests without inspecting prompt
 * content. They are runtime attribution data, never permission/authentication:
 * authorization continues to come from RLY launch/gateway tokens.
 */

export type AgentContext = Readonly<{
  claudeSessionId?: string;
  agentId?: string;
  parentAgentId?: string;
}>;

const AGENT_HEADERS = [
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
] as const;

type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

function singleValue(headers: HeaderBag, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") return direct === "" ? undefined : direct;
  if (Array.isArray(direct)) {
    return direct.find((item) => item !== "");
  }
  // Case-insensitive fallback: Fastify normalizes to lowercase, but callers
  // may pass exact-case header objects (contract fixtures).
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (match === undefined) return undefined;
  const value = match[1];
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) return value.find((item) => item !== "");
  return undefined;
}

/**
 * Parses Claude Code agent attribution headers into a typed context.
 * Returns `undefined` when none of the supported headers are present, so
 * requests without agent attribution keep the existing resolution path.
 * No prompt/body content is inspected.
 */
export function parseAgentContext(headers: HeaderBag = {}): AgentContext | undefined {
  const claudeSessionId = singleValue(headers, AGENT_HEADERS[0]);
  const agentId = singleValue(headers, AGENT_HEADERS[1]);
  const parentAgentId = singleValue(headers, AGENT_HEADERS[2]);
  if (claudeSessionId === undefined && agentId === undefined && parentAgentId === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(claudeSessionId === undefined ? {} : { claudeSessionId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  });
}

/** Stable allowlisted pseudonym for diagnostics: sha256 prefix, never the raw id. */
export function agentPseudonym(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
