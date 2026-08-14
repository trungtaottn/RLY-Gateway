import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../../src/control-plane/store.js";

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
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-claude-pool-e2e-"));
  directories.push(directory);
  return directory;
}

type RunningProcess = Readonly<{ completion: Promise<{ code: number | null; output: string }>; stop: () => void }>;

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): RunningProcess {
  const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const processId = child.pid;
  if (processId === undefined) throw new Error("E2E child did not receive a process ID");
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

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function seedProfile(directory: string, endpoint: string, name: string): Promise<void> {
  const store = await ControlPlaneStore.open(join(directory, "control-plane"));
  try {
    const providerRecord = store.createProvider({
      name: "openrouter",
      integrationMode: "direct",
      endpointPolicy: endpoint,
    }, "cli");
    const account = store.createAccount({
      pseudonym: "acct-e2e",
      providerId: providerRecord.id,
      credentialHandle: "env:OPENROUTER_API_KEY",
    }, "cli");
    const ready = store.bindCredential(account.id, account.version, {
      credentialHandle: "env:OPENROUTER_API_KEY",
      credentialGeneration: 1,
      state: "ready",
    }, "cli");
    const pool = store.createPool({
      name: "e2e-pool",
      providerId: providerRecord.id,
      strategy: "fill-first",
      retryBudget: 1,
      accountIds: [ready.id],
    }, "cli");
    store.createProfile({
      name,
      harness: "claude",
      providerId: providerRecord.id,
      poolId: pool.id,
      modelRoles: {
        primary: "nvidia/nemotron-3.5-lightning:free",
        fast: "nvidia/nemotron-nano-12b-v2-vl:free",
      },
    }, "cli");
  } finally {
    store.close();
  }
}

async function writeConfig(directory: string, port: number): Promise<string> {
  const config = join(directory, "gateway.toml");
  await writeFile(config, [
    "schemaVersion = 1",
    "[gateway]",
    `port = ${String(port)}`,
    `managementPort = ${String(port + 1)}`,
    'logLevel = "silent"',
    "[controlPlane]",
    `dataDirectory = "${join(directory, "control-plane")}"`,
  ].join("\n"), "utf8");
  return config;
}

describe.skipIf(!enabled)("Claude Code fake pool-profile E2E", () => {
  it("runs text and helper mapping through a profile pool without mutating global Claude files", async () => {
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response('data: {"id":"pool-e2e","choices":[{"delta":{"content":"FAKE_POOL_E2E_OK"}}]}\n\ndata: {"id":"pool-e2e","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    await seedProfile(directory, baseUrl, "work");
    const config = await writeConfig(directory, 17881);
    const homeFile = join(directory, ".claude.json");
    await writeFile(homeFile, "sentinel\n", "utf8");
    const before = await digest(homeFile);
    const result = await run(process.execPath, [
      "dist/cli/main.js", "run", "claude", "--config", config, "--profile", "work", "--",
      "-p", "Reply with the fixture marker.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }).completion;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("FAKE_POOL_E2E_OK");
    expect(received.length).toBeGreaterThan(0);
    expect(await digest(homeFile)).toBe(before);
  }, timeoutMs);
});
