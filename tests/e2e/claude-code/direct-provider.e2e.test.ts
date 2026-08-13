import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env["AGENT_GATEWAY_CLAUDE_E2E"] === "1";
const timeoutMs = 45_000;
let provider: FastifyInstance | undefined;
const directories: string[] = [];
const processes: RunningProcess[] = [];

afterEach(async () => {
  const active = processes.splice(0);
  for (const process of active) process.stop();
  await Promise.all(active.map((process) => process.completion.catch(() => undefined)));
  await provider?.close();
  provider = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-claude-e2e-"));
  directories.push(directory);
  return directory;
}

type RunningProcess = Readonly<{ completion: Promise<{ code: number | null; output: string }>; stop: () => void }>;
type Diagnostic = Readonly<{ at: number; event: string; label: string; detail?: string }>;

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, label = "single", diagnostics: Diagnostic[] = []): RunningProcess {
  const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const processId = child.pid;
  if (processId === undefined) throw new Error("E2E child did not receive a process ID");
  diagnostics.push({ at: Date.now(), event: "outer-spawn", label, detail: `pid=${String(processId)}` });
  const completion = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); diagnostics.push({ at: Date.now(), event: "outer-stdout", label, detail: `bytes=${String(chunk.length)}` }); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); diagnostics.push({ at: Date.now(), event: "outer-stderr", label, detail: `bytes=${String(chunk.length)}` }); });
    child.once("error", reject);
    child.once("close", (code) => { diagnostics.push({ at: Date.now(), event: "outer-close", label, detail: `code=${String(code)}` }); resolve({ code, output }); });
  });
  const running = { completion, stop: () => { diagnostics.push({ at: Date.now(), event: "outer-stop", label }); try { process.kill(-processId, "SIGTERM"); } catch { child.kill("SIGTERM"); } } };
  processes.push(running);
  return running;
}

async function completesWithin(process: RunningProcess, diagnostics: readonly Diagnostic[], timeout = 10_000): Promise<{ code: number | null; output: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([process.completion, new Promise<{ code: number | null; output: string }>((_resolve, reject) => { timer = setTimeout(() => { process.stop(); void process.completion.catch(() => undefined); reject(new Error(`E2E process did not exit within the required bound; diagnostic=${JSON.stringify(diagnostics)}`)); }, timeout); })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe.skipIf(!enabled)("Claude Code fake direct-provider E2E", () => {
  it("pins an explicit configured route through the real launcher and fake upstream", async () => {
    let receivedModel: string | undefined;
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown; stream?: unknown };
      receivedModel = typeof body.model === "string" ? body.model : undefined;
      expect(request.headers.authorization).toBe("Bearer fixture-key");
      expect(body.stream).toBe(true);
      return new Response([
        'data: {"id":"fixture-e2e","choices":[{"delta":{"content":"FAKE_CLAUDE_E2E_OK"}}]}\n\n',
        'data: {"id":"fixture-e2e","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const config = join(directory, "gateway.toml");
    await writeFile(config, [
      "schemaVersion = 1",
      "[gateway]",
      "port = 17871",
      'logLevel = "silent"',
      "[routes.primary]",
      'provider = "openrouter"',
      'model = "nvidia/nemotron-3.5-lightning:free"',
      'credential = "env:OPENROUTER_API_KEY"',
      `baseUrl = "${baseUrl}"`,
    ].join("\n"), "utf8");
    const result = await run(process.execPath, [
      "dist/cli/main.js", "run", "claude", "--config", config,
      "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--",
      "-p", "Reply with the fixture marker.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }).completion;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("FAKE_CLAUDE_E2E_OK");
    expect(receivedModel).toBe("nvidia/nemotron-3.5-lightning:free");
  }, timeoutMs);

  it("completes a real Claude tool round-trip through the direct adapter", async () => {
    let toolResultReceived = false;
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { messages?: unknown };
      const serialized = JSON.stringify(body.messages);
      toolResultReceived ||= serialized.includes('"role":"tool"');
      const response = toolResultReceived
        ? 'data: {"id":"fixture-tool-final","choices":[{"delta":{"content":"TOOL_ROUNDTRIP_OK"}}]}\n\ndata: {"id":"fixture-tool-final","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
        : 'data: {"id":"fixture-tool-call","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bash","function":{"name":"Bash","arguments":"{\\"command\\":\\"printf fixture-tool\\"}"}}]}}]}\n\ndata: {"id":"fixture-tool-call","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
      return new Response(response, { headers: { "content-type": "text/event-stream" } });
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const config = join(directory, "gateway.toml");
    await writeFile(config, `schemaVersion = 1\n[gateway]\nport = 17871\nlogLevel = "silent"\n[routes.primary]\nprovider = "openrouter"\nmodel = "nvidia/nemotron-3.5-lightning:free"\ncredential = "env:OPENROUTER_API_KEY"\nbaseUrl = "${baseUrl}"\n`, "utf8");
    const diagnostics: Diagnostic[] = [];
    const result = await completesWithin(run(process.execPath, ["dist/cli/main.js", "run", "claude", "--config", config, "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--", "-p", "Use the Bash tool once, then report completion.", "--dangerously-skip-permissions"], { ...process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }, "tool", diagnostics), diagnostics);
    expect(result.code, result.output).toBe(0);
    expect(toolResultReceived).toBe(true);
    expect(result.output).toContain("TOOL_ROUNDTRIP_OK");
  }, timeoutMs);

  it("keeps explicit primary, fast, and reasoning routes mapped to their configured upstream models", async () => {
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response('data: {"id":"fixture-role","choices":[{"delta":{"content":"ROLE_OK"}}]}\n\ndata: {"id":"fixture-role","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const config = join(directory, "gateway.toml");
    await writeFile(config, `schemaVersion = 1\n[gateway]\nport = 17871\nlogLevel = "silent"\n[routes.primary]\nprovider = "openrouter"\nmodel = "nvidia/nemotron-3.5-lightning:free"\ncredential = "env:OPENROUTER_API_KEY"\nbaseUrl = "${baseUrl}"\n[routes.fast]\nprovider = "openrouter"\nmodel = "nvidia/nemotron-nano-12b-v2-vl:free"\ncredential = "env:OPENROUTER_API_KEY"\nbaseUrl = "${baseUrl}"\n[routes.reasoning]\nprovider = "deepseek"\nmodel = "deepseek-v4-flash"\ncredential = "env:DEEPSEEK_API_KEY"\nbaseUrl = "${baseUrl}"\n`, "utf8");
    const diagnostics: Diagnostic[] = [];
    const routes = ["openrouter/nvidia/nemotron-3.5-lightning:free", "openrouter/nvidia/nemotron-nano-12b-v2-vl:free"];
    for (const route of routes) {
      const result = await completesWithin(run(process.execPath, ["dist/cli/main.js", "run", "claude", "--config", config, "--route", route, "--", "-p", "Reply with the role marker.", "--dangerously-skip-permissions"], { ...process.env, HOME: await temporaryDirectory(), OPENROUTER_API_KEY: "fixture-key", DEEPSEEK_API_KEY: "fixture-key" }, route, diagnostics), diagnostics);
      expect(result.code, `${route}: ${result.output}`).toBe(0);
      expect(result.output).toContain("ROLE_OK");
    }
    expect([...new Set(received)].sort()).toEqual(["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-nano-12b-v2-vl:free"]);
  }, timeoutMs);

  it("forwards outer termination to an aborted fake provider request", async () => {
    let notify: (() => void) | undefined;
    const received = new Promise<void>((resolve) => { notify = resolve; });
    let closed = false;
    provider = Fastify();
    provider.post("/chat/completions", (request, reply) => {
      notify?.();
      request.raw.once("close", () => { closed = true; });
      return reply.hijack();
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const config = join(directory, "gateway.toml");
    await writeFile(config, `schemaVersion = 1\n[gateway]\nport = 17871\nlogLevel = "silent"\n[routes.primary]\nprovider = "openrouter"\nmodel = "nvidia/nemotron-3.5-lightning:free"\ncredential = "env:OPENROUTER_API_KEY"\nbaseUrl = "${baseUrl}"\n`, "utf8");
    const diagnostics: Diagnostic[] = [];
    const outer = run(globalThis.process.execPath, ["dist/cli/main.js", "run", "claude", "--config", config, "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--", "-p", "SLOW", "--dangerously-skip-permissions"], { ...globalThis.process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }, "slow", diagnostics);
    await received;
    outer.stop();
    const result = await completesWithin(outer, diagnostics);
    expect(result.code).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  }, timeoutMs);

  it("runs two real print sessions concurrently without hanging or cross-route state", async () => {
    const diagnostics: Diagnostic[] = [];
    const markers: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown; stream?: unknown; messages?: unknown };
      const serialized = JSON.stringify(body.messages);
      const label = serialized.includes("SESSION_A") ? "A" : serialized.includes("SESSION_B") ? "B" : "unknown";
      markers.push(label);
      diagnostics.push({ at: Date.now(), event: "provider-inbound", label, detail: `model=${typeof body.model === "string" ? body.model : "invalid"};stream=${String(body.stream)};messages=${Array.isArray(body.messages) ? String(body.messages.length) : "invalid"}` });
      diagnostics.push({ at: Date.now(), event: "provider-response", label });
      return new Response(`data: {"id":"fixture-${label}","choices":[{"delta":{"content":"${label}_OK"}}]}\n\ndata: {"id":"fixture-${label}","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const config = join(directory, "gateway.toml");
    await writeFile(config, `schemaVersion = 1\n[gateway]\nport = 17871\nlogLevel = "silent"\n[routes.primary]\nprovider = "openrouter"\nmodel = "nvidia/nemotron-3.5-lightning:free"\ncredential = "env:OPENROUTER_API_KEY"\nbaseUrl = "${baseUrl}"\n`, "utf8");
    const command = ["dist/cli/main.js", "run", "claude", "--config", config, "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--", "-p"];
    const leftProcess = run(globalThis.process.execPath, [...command, "SESSION_A", "--session-id", randomUUID(), "--dangerously-skip-permissions"], { ...globalThis.process.env, HOME: await temporaryDirectory(), OPENROUTER_API_KEY: "fixture-key" }, "A", diagnostics);
    const rightProcess = run(globalThis.process.execPath, [...command, "SESSION_B", "--session-id", randomUUID(), "--dangerously-skip-permissions"], { ...globalThis.process.env, HOME: await temporaryDirectory(), OPENROUTER_API_KEY: "fixture-key" }, "B", diagnostics);
    let left: { code: number | null; output: string };
    let right: { code: number | null; output: string };
    try {
      [left, right] = await Promise.all([completesWithin(leftProcess, diagnostics), completesWithin(rightProcess, diagnostics)]);
    } catch (error) {
      leftProcess.stop();
      rightProcess.stop();
      await Promise.all([leftProcess.completion.catch(() => undefined), rightProcess.completion.catch(() => undefined)]);
      throw error;
    }
    expect(left.code, left.output).toBe(0); expect(right.code, right.output).toBe(0);
    expect(markers.sort()).toEqual(["A", "B"]);
  }, timeoutMs);
});
