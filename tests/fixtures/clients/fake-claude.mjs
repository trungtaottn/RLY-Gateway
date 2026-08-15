#!/usr/bin/env node
// Deterministic fake Claude Code black-box client (Layer B runner tests).
// Reads the child-only environment set by the installed-client runner
// (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CONFIG_DIR plus the
// RLY_BLACKBOX_* gate metadata) and drives the controlled fixture server the
// way a real Claude Code print session would, so the runner logic is fully
// testable without a real binary. Prints the fixture marker on success and
// exits 0; failures print FAKE_CLIENT_FAIL and exit 1. Never stores prompts.
import { readFileSync } from "node:fs";
import process from "node:process";

const baseUrl = process.env.ANTHROPIC_BASE_URL ?? process.env.RLY_BLACKBOX_FIXTURE_URL;
const gate = process.env.RLY_BLACKBOX_GATE ?? "text";
const sessionId = process.env.RLY_BLACKBOX_SESSION_ID ?? "session-synthetic-0001";
const configDir = process.env.RLY_BLACKBOX_CONFIG_DIR ?? "";
const MARKER = "blackbox fixture marker OK";
if (!baseUrl) {
  process.stderr.write("FAKE_CLIENT_FAIL: missing base url\n");
  process.exit(1);
}

function headers(overrides = {}) {
  const base = {
    authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN ?? "fixture-token-blackbox"}`,
    "content-type": "application/json",
    "x-claude-code-session-id": sessionId,
    "x-claude-code-agent-id": `agent-${sessionId.slice(-8)}`,
    "x-claude-code-parent-agent-id": "parent-synthetic-0001",
    ...overrides,
  };
  if (gate === "drop-session-header") {
    delete base["x-claude-code-session-id"];
    delete base["x-claude-code-agent-id"];
    delete base["x-claude-code-parent-agent-id"];
  }
  return base;
}

async function post(body) {
  const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`fixture status ${String(response.status)}`);
  return text;
}

async function postJson(body) {
  const text = await post(body);
  return JSON.parse(text);
}

function textFromPayload(payload) {
  for (const block of Array.isArray(payload.content) ? payload.content : []) {
    if (block && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function toolUsesFromPayload(payload) {
  return Array.isArray(payload.content) ? payload.content.filter((block) => block && block.type === "tool_use") : [];
}

function toolResultMessage(toolUses) {
  return {
    role: "user",
    content: toolUses.map((toolUse) => ({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: "fixture tool output",
    })),
  };
}

function sseText(responseText) {
  const blocks = responseText.split("\n\n");
  let text = "";
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.type === "content_block_delta" && parsed.delta && parsed.delta.type === "text_delta" && typeof parsed.delta.text === "string") {
            text += parsed.delta.text;
          }
        } catch {
          // ignore non-JSON SSE frames
        }
      }
    }
  }
  return text;
}

const model = (() => {
  if (gate === "config-overlay" && configDir) {
    try {
      const settings = JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"));
      if (typeof settings.model === "string") return settings.model;
    } catch {
      // fall through to default
    }
  }
  return "claude-sonnet-4-5";
})();

const textPrompt = `Reply with the exact text: ${MARKER}.`;
const toolPrompt = "Use the Bash tool and report the output.";
const baseBody = (stream = false) => ({ model, max_tokens: 64, stream, messages: [{ role: "user", content: textPrompt }] });

async function run() {
  switch (gate) {
    case "streaming": {
      const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(baseBody(true)),
      });
      const text = await response.text();
      if (!response.ok || !sseText(text).includes(MARKER)) throw new Error("stream marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "cancellation": {
      const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(baseBody(true)),
      });
      const reader = response.body.getReader();
      await reader.read();
      reader.releaseLock();
      process.stdout.write(`${MARKER}\n`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 60_000));
      return;
    }
    case "tools-single":
    case "reasoning-tools": {
      const first = await postJson({ ...baseBody(false), messages: [{ role: "user", content: toolPrompt }], tools: [{ name: "Bash", description: "synthetic tool", input_schema: { type: "object", properties: { command: { type: "string" } } } }], ...(gate === "reasoning-tools" ? { thinking: { type: "enabled" } } : {}) });
      const toolUses = toolUsesFromPayload(first);
      if (toolUses.length === 0) throw new Error("no tool_use");
      const final = await postJson({ ...baseBody(false), messages: [{ role: "user", content: toolPrompt }, toolResultMessage(toolUses)] });
      if (!textFromPayload(final).includes(MARKER)) throw new Error("final marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "tools-multi": {
      let messages = [{ role: "user", content: toolPrompt }];
      for (let turn = 0; turn < 3; turn += 1) {
        const payload = await postJson({ ...baseBody(false), messages, tools: [{ name: "Bash", description: "synthetic tool", input_schema: { type: "object", properties: { command: { type: "string" } } } }] });
        const toolUses = toolUsesFromPayload(payload);
        if (toolUses.length === 0) {
          if (!textFromPayload(payload).includes(MARKER)) throw new Error("final marker missing");
          process.stdout.write(`${MARKER}\n`);
          return;
        }
        messages = [...messages, { role: "assistant", content: toolUses }, toolResultMessage(toolUses)];
      }
      throw new Error("tool loop did not terminate");
    }
    case "tools-parallel": {
      const first = await postJson({ ...baseBody(false), messages: [{ role: "user", content: toolPrompt }], tools: [{ name: "Bash", description: "synthetic tool", input_schema: { type: "object", properties: { command: { type: "string" } } } }] });
      const toolUses = toolUsesFromPayload(first);
      if (toolUses.length < 2) throw new Error("parallel tool_use missing");
      const final = await postJson({ ...baseBody(false), messages: [{ role: "user", content: toolPrompt }, toolResultMessage(toolUses)] });
      if (!textFromPayload(final).includes(MARKER)) throw new Error("final marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "reasoning":
    case "effort-signal": {
      const payload = await postJson({ ...baseBody(false), thinking: { type: "enabled" }, effort: "high" });
      if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "model-discovery": {
      const discovery = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { method: "GET", headers: headers() });
      const discovered = await discovery.json();
      const id = Array.isArray(discovered.data) && discovered.data.length > 0 ? discovered.data[0].id : undefined;
      if (typeof id !== "string") throw new Error("no discovered model");
      const payload = await postJson({ ...baseBody(false), model: id });
      if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "session-attribution":
    case "subagent-routing":
    case "subagent-parallel":
    case "config-overlay":
    case "long-running-session": {
      let count = gate === "long-running-session" ? 3 : 1;
      for (let index = 0; index < count; index += 1) {
        const payload = await postJson({ ...baseBody(false), model: gate === "subagent-routing" ? "fable" : model });
        if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      }
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    default: {
      const payload = await postJson(baseBody(false));
      if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
  }
}

run().catch((error) => {
  process.stderr.write(`FAKE_CLIENT_FAIL: ${String(error.message)}\n`);
  process.exit(1);
});
