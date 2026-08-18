import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../../src/control-plane/store.js";
import { CredentialBroker } from "../../../src/credentials/broker.js";
import { seedCodexClaudeProfile, sseFixture } from "../../helpers/codex-profile-seed.js";

const enabled = process.env["RLY_CLAUDE_E2E"] === "1";
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
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-claude-e2e-"));
  directories.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
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
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, output }); });
  });
  const running = { completion, stop: () => { try { process.kill(-processId, "SIGTERM"); } catch { child.kill("SIGTERM"); } } };
  processes.push(running);
  return running;
}

async function completesWithin(process: RunningProcess, diagnostics: readonly Diagnostic[], timeout = 10_000): Promise<{ code: number | null; output: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      process.completion,
      new Promise<{ code: number | null; output: string }>((_resolve, reject) => {
        timer = setTimeout(() => {
          process.stop();
          void process.completion.catch(() => undefined);
          reject(new Error(`E2E process did not exit within the required bound; diagnostic=${JSON.stringify(diagnostics)}`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function seedAndConfig(directory: string, endpoint: string): Promise<{ config: string; homeFile: string; codexFile: string }> {
  const controlPlane = join(directory, "control-plane");
  const store = await ControlPlaneStore.open(controlPlane);
  const broker = await CredentialBroker.open(controlPlane);
  try {
    await seedCodexClaudeProfile(store, broker, controlPlane, { endpoint, profileName: "codex" });
  } finally {
    await broker.close();
    store.close();
  }
  const port = await availablePort();
  const managementPort = await availablePort();
  const config = join(directory, "gateway.toml");
  await writeFile(config, [
    "schemaVersion = 1",
    "[gateway]",
    `port = ${String(port)}`,
    `managementPort = ${String(managementPort)}`,
    'logLevel = "silent"',
    "[controlPlane]",
    `dataDirectory = "${controlPlane}"`,
  ].join("\n"), "utf8");
  const homeFile = join(directory, ".claude.json");
  const codexDirectory = join(directory, ".codex");
  await mkdir(codexDirectory);
  const codexFile = join(codexDirectory, "config.toml");
  await writeFile(homeFile, "sentinel-claude\n", "utf8");
  await writeFile(codexFile, "sentinel-codex\n", "utf8");
  return { config, homeFile, codexFile };
}

describe.skipIf(!enabled)("Claude Code fake Codex OAuth E2E", () => {
  it("runs text through rly codex without mutating global Claude or Codex files", async () => {
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown; stream?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      expect(body.stream).toBe(true);
      return new Response(sseFixture("codex-e2e", "FAKE_CODEX_CLAUDE_E2E_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const seeded = await seedAndConfig(directory, endpoint);
    const beforeClaude = await digest(seeded.homeFile);
    const beforeCodex = await digest(seeded.codexFile);
    const result = await run(process.execPath, [
      "dist/cli/main.js", "codex", "--config", seeded.config, "--",
      "-p", "Reply with the fixture marker.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory }).completion;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("FAKE_CODEX_CLAUDE_E2E_OK");
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((model) => model === "gpt-5.4")).toBe(true);
    expect(await digest(seeded.homeFile)).toBe(beforeClaude);
    expect(await digest(seeded.codexFile)).toBe(beforeCodex);
  }, timeoutMs);

  it("completes a tool round-trip through Codex OAuth", async () => {
    let toolResultReceived = false;
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { messages?: unknown };
      const serialized = JSON.stringify(body.messages);
      toolResultReceived ||= serialized.includes('"role":"tool"');
      const response = toolResultReceived
        ? sseFixture("codex-tool-final", "TOOL_ROUNDTRIP_OK")
        : [
          'data: {"id":"codex-tool-call","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bash","function":{"name":"Bash","arguments":"{\\"command\\":\\"printf fixture-tool\\"}"}}]}}]}\n\n',
          'data: {"id":"codex-tool-call","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
          "data: [DONE]\n\n",
        ].join("");
      return new Response(response, { headers: { "content-type": "text/event-stream" } });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const seeded = await seedAndConfig(directory, endpoint);
    const diagnostics: Diagnostic[] = [];
    const result = await completesWithin(run(process.execPath, [
      "dist/cli/main.js", "codex", "--config", seeded.config, "--",
      "-p", "Use the Bash tool once, then report completion.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory }, "tool", diagnostics), diagnostics);
    expect(result.code, result.output).toBe(0);
    expect(toolResultReceived).toBe(true);
    expect(result.output).toContain("TOOL_ROUNDTRIP_OK");
  }, timeoutMs);

  it("forwards cancellation to the Codex fake upstream", async () => {
    let notify: (() => void) | undefined;
    const received = new Promise<void>((resolve) => { notify = resolve; });
    let closed = false;
    provider = Fastify();
    provider.post("/chat/completions", (request, reply) => {
      notify?.();
      request.raw.once("close", () => { closed = true; });
      return reply.hijack();
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const seeded = await seedAndConfig(directory, endpoint);
    const diagnostics: Diagnostic[] = [];
    const outer = run(process.execPath, [
      "dist/cli/main.js", "codex", "--config", seeded.config, "--",
      "-p", "SLOW", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory }, "slow", diagnostics);
    await received;
    outer.stop();
    const result = await completesWithin(outer, diagnostics);
    expect(result.code).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  }, timeoutMs);
});
