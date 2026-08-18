import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RLY_MODEL_PREFIX } from "../../../src/runtime/claude-overlay.js";

const enabled = process.env["RLY_CLAUDE_E2E"] === "1";
const timeoutMs = 60_000;
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
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-overlay-e2e-"));
  directories.push(directory);
  return directory;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

async function seedNativeConfig(home: string): Promise<readonly string[]> {
  const native = join(home, ".claude");
  await mkdir(join(native, "agents"), { recursive: true });
  await mkdir(join(native, "commands"), { recursive: true });
  await mkdir(join(native, "skills", "demo"), { recursive: true });
  await mkdir(join(native, "plugins"), { recursive: true });
  await writeFile(join(native, "settings.json"), JSON.stringify({
    model: "claude-sonnet-4-5",
    theme: "dark",
    env: { ANTHROPIC_BASE_URL: "http://native.example", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  }), "utf8");
  await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\nreviewer fixture\n", "utf8");
  await writeFile(join(native, "commands", "ship.md"), "ship fixture\n", "utf8");
  await writeFile(join(native, "skills", "demo", "SKILL.md"), "# demo skill\n", "utf8");
  await writeFile(join(native, "plugins", "config.json"), JSON.stringify({
    enabledPlugins: ["https://example.com/marketplace"],
    oauthAccounts: { "example.com": { oauthToken: "e2e-fixture-token" } },
  }), "utf8");
  await writeFile(join(home, ".claude.json"), "sentinel\n", "utf8");
  return [
    join(native, "settings.json"),
    join(native, "agents", "reviewer.md"),
    join(native, "commands", "ship.md"),
    join(native, "skills", "demo", "SKILL.md"),
    join(native, "plugins", "config.json"),
    join(home, ".claude.json"),
  ];
}

async function writeConfig(directory: string, baseUrl: string): Promise<string> {
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
  return config;
}

describe.skipIf(!enabled)("Claude Code overlay E2E", () => {
  it("launches through the durable RLY overlay, preserves native config, and keeps RLY model state across launches", async () => {
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(
      'data: {"id":"overlay-e2e","choices":[{"delta":{"content":"FAKE_OVERLAY_E2E_OK"}}]}\n\ndata: {"id":"overlay-e2e","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const directory = await temporaryDirectory();
    const protectedFiles = await seedNativeConfig(directory);
    const before = await Promise.all(protectedFiles.map(digest));
    const config = await writeConfig(directory, baseUrl);
    const overlay = join(directory, ".rly", "claude", "views", "default");

    const first = await run(process.execPath, [
      "dist/cli/main.js", "run", "claude", "--config", config,
      "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--",
      "-p", "Reply with the overlay fixture marker.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }).completion;
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("FAKE_OVERLAY_E2E_OK");

    // The durable overlay exists, composed from native input.
    const settings = JSON.parse(await readFile(join(overlay, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings["theme"]).toBe("dark");
    expect(settings["model"]).toBe("claude-sonnet-4-5");
    // Native gateway env override is stripped from the overlay; other env stays.
    expect(settings["env"]).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(await readFile(join(overlay, "agents", "reviewer.md"), "utf8")).toBe("# reviewer\nreviewer fixture\n");
    expect(await readFile(join(overlay, "commands", "ship.md"), "utf8")).toBe("ship fixture\n");
    expect(await readFile(join(overlay, "skills", "demo", "SKILL.md"), "utf8")).toBe("# demo skill\n");
    const pluginConfig = JSON.parse(await readFile(join(overlay, "plugins", "config.json"), "utf8")) as Record<string, unknown>;
    expect(pluginConfig).toEqual({ enabledPlugins: ["https://example.com/marketplace"] });
    expect(JSON.stringify(pluginConfig)).not.toMatch(/token|oauthAccount/i);
    expect(JSON.parse(await readFile(join(overlay, ".rly-overlay.json"), "utf8"))).toMatchObject({ allowlistVersion: 3 });

    // Native files remain byte-identical after the RLY launch.
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);

    // A plain `claude` launch would read native settings: the overlay never
    // carries gateway env, RLY auth, or RLY projection model ids.
    expect(JSON.stringify(settings)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|claude-rly-|fixture-key/);

    // Simulate Claude persisting an RLY-only /model selection, then relaunch.
    await writeFile(join(overlay, "settings.json"), JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark", env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }), "utf8");
    const second = await run(process.execPath, [
      "dist/cli/main.js", "run", "claude", "--config", config,
      "--route", "openrouter/nvidia/nemotron-3.5-lightning:free", "--",
      "-p", "Reply with the overlay fixture marker.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory, OPENROUTER_API_KEY: "fixture-key" }).completion;
    expect(second.code, second.output).toBe(0);
    const afterSecond = JSON.parse(await readFile(join(overlay, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(afterSecond["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);

    // `rly status` reports a secret-free overlay summary.
    const status = await run(process.execPath, ["dist/cli/main.js", "status", "--config", config], { ...process.env, HOME: directory }).completion;
    const statusPayload = JSON.parse(status.output.split("\n").filter((line) => line.startsWith("{")).pop() ?? "{}") as {
      claudeOverlay?: { directory?: string; source?: string; allowlistVersion?: number };
    };
    expect(statusPayload.claudeOverlay).toMatchObject({
      directory: overlay,
      source: join(directory, ".claude"),
      allowlistVersion: 3,
    });
  }, timeoutMs);
});
