#!/usr/bin/env node
// Deterministic fake Codex CLI black-box client (Layer B runner tests).
// Reads the child-only environment set by the installed-client runner
// (OPENAI_BASE_URL / OPENAI_API_KEY / CODEX_HOME plus RLY_BLACKBOX_* gate
// metadata) and drives the controlled OpenAI Responses fixture server so the
// Layer B runner logic is fully testable without a real binary. Prints the
// fixture marker on success and exits 0; failures print FAKE_CLIENT_FAIL and
// exit 1. Never stores prompts.
import { readFileSync } from "node:fs";
import process from "node:process";

const baseUrl = process.env.OPENAI_BASE_URL ?? process.env.RLY_BLACKBOX_FIXTURE_URL;
const gate = process.env.RLY_BLACKBOX_GATE ?? "text";
const configDir = process.env.RLY_BLACKBOX_CONFIG_DIR ?? "";
const MARKER = "blackbox fixture marker OK";
if (!baseUrl) {
  process.stderr.write("FAKE_CLIENT_FAIL: missing base url\n");
  process.exit(1);
}

function headers() {
  return {
    authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "fixture-token-blackbox"}`,
    "content-type": "application/json",
  };
}

async function post(body) {
  const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`fixture status ${String(response.status)}`);
  return text;
}

async function postJson(body) {
  return JSON.parse(await post(body));
}

function textFromPayload(payload) {
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block && block.type === "output_text" && typeof block.text === "string") return block.text;
      }
    }
  }
  return "";
}

function toolCallsFromPayload(payload) {
  return Array.isArray(payload.output) ? payload.output.filter((item) => item && item.type === "function_call") : [];
}

function toolResultInput(toolCalls) {
  return toolCalls.map((call) => ({ type: "function_call_output", call_id: call.call_id, output: "fixture tool output" }));
}

function sseText(responseText) {
  const blocks = responseText.split("\n\n");
  let text = "";
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
            text += parsed.delta;
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
      const config = readFileSync(`${configDir}/.codex/config.toml`, "utf8");
      const match = config.match(/model\s*=\s*"([^"]+)"/);
      if (match && match[1]) return match[1];
    } catch {
      // fall through to default
    }
  }
  return "gpt-5.4";
})();

const textPrompt = `Reply with the exact text: ${MARKER}.`;
const toolPrompt = "Use the Bash tool and report the output.";
const toolDefinitions = [{ type: "function", name: "Bash", description: "synthetic tool", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const baseBody = (stream = false) => ({ model, input: textPrompt, stream });

async function run() {
  switch (gate) {
    case "streaming": {
      const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/responses`, {
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
      const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/responses`, {
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
      const first = await postJson({ model, input: toolPrompt, tools: toolDefinitions, ...(gate === "reasoning-tools" ? { reasoning: { effort: "medium" } } : {}) });
      const calls = toolCallsFromPayload(first);
      if (calls.length === 0) throw new Error("no function_call");
      const final = await postJson({ model, input: [...calls.map((call) => ({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments })), ...toolResultInput(calls)] });
      if (!textFromPayload(final).includes(MARKER)) throw new Error("final marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "tools-multi": {
      let input = toolPrompt;
      for (let turn = 0; turn < 3; turn += 1) {
        const payload = await postJson({ model, input, tools: toolDefinitions });
        const calls = toolCallsFromPayload(payload);
        if (calls.length === 0) {
          if (!textFromPayload(payload).includes(MARKER)) throw new Error("final marker missing");
          process.stdout.write(`${MARKER}\n`);
          return;
        }
        input = [...(Array.isArray(input) ? input : []), ...calls.map((call) => ({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments })), ...toolResultInput(calls)];
      }
      throw new Error("tool loop did not terminate");
    }
    case "tools-parallel": {
      const first = await postJson({ model, input: toolPrompt, tools: toolDefinitions });
      const calls = toolCallsFromPayload(first);
      if (calls.length < 2) throw new Error("parallel function_call missing");
      const final = await postJson({ model, input: [...calls.map((call) => ({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments })), ...toolResultInput(calls)] });
      if (!textFromPayload(final).includes(MARKER)) throw new Error("final marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "reasoning":
    case "effort-signal": {
      const payload = await postJson({ model, input: textPrompt, reasoning: { effort: gate === "effort-signal" ? "high" : "medium" } });
      if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "model-discovery": {
      const discovery = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { method: "GET", headers: headers() });
      const discovered = await discovery.json();
      const id = Array.isArray(discovered.data) && discovered.data.length > 0 ? discovered.data[0].id : undefined;
      if (typeof id !== "string") throw new Error("no discovered model");
      const payload = await postJson({ model: id, input: textPrompt });
      if (!textFromPayload(payload).includes(MARKER)) throw new Error("marker missing");
      process.stdout.write(`${MARKER}\n`);
      return;
    }
    case "config-overlay":
    case "long-running-session": {
      let count = gate === "long-running-session" ? 3 : 1;
      for (let index = 0; index < count; index += 1) {
        const payload = await postJson(baseBody(false));
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
