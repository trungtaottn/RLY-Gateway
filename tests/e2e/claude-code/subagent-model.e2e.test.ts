import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../../src/control-plane/store.js";
import { CredentialBroker } from "../../../src/credentials/broker.js";
import { AgentExecutionContextRegistry } from "../../../src/profiles/agent-contexts.js";
import { LaunchSessionRegistry } from "../../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../../src/profiles/traces.js";
import { createGatewayServer } from "../../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../../src/config/schema.js";
import { seedClineClaudeProfile, sseFixture } from "../../helpers/cline-profile-seed.js";

/**
 * Gated Claude Code subagent model resolution E2E (#71).
 *
 * Uses the REAL Claude Code CLI as the client: the main session runs against
 * the RLY gateway (fake upstream) and stays on the profile's Terra-class
 * model, while a subagent request carrying Claude Code attribution headers
 * (`X-Claude-Code-Session-Id` / `-Agent-Id` / `-Parent-Agent-Id`) with the
 * portable `model: fable` alias resolves through #69 to the Sol-class target
 * in the parent's family. The source agent definition (`model: fable`) is
 * never rewritten to a physical model.
 *
 * The exact native `fable` alias behavior of a given client baseline is owned
 * by #24 canary fixtures; this test pins the gateway plumbing on the observed
 * local client. Opt-in `RLY_CLAUDE_E2E=1`, skipped ≠ pass.
 */

const enabled = process.env["RLY_CLAUDE_E2E"] === "1";
const timeoutMs = 60_000;
const TERRA = "gpt-5.6-terra";
const SOL = "gpt-5.6-sol";
let provider: FastifyInstance | undefined;
let app: FastifyInstance | undefined;
const directories: string[] = [];
const processes: RunningProcess[] = [];

afterEach(async () => {
  const active = processes.splice(0);
  for (const process of active) process.stop();
  await Promise.all(active.map((process) => process.completion.catch(() => undefined)));
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

async function freePort(): Promise<number> {
  const server = await import("node:http").then(({ createServer }) => createServer());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe.skipIf(!enabled)("Claude Code subagent model resolution E2E (#71)", () => {
  it("resolves a fable subagent in the parent family and keeps the real main session on its model", async () => {
    const received: { model?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push({ model: body.model });
      return new Response(sseFixture("subagent-e2e", "SUBAGENT_E2E_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });

    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-e2e-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    const store = await ControlPlaneStore.open(controlPlane);
    const broker = await CredentialBroker.open(controlPlane);
    await seedClineClaudeProfile(store, broker, controlPlane, {
      endpoint,
      profileName: "clinepass",
      modelRoles: { primary: TERRA },
    });
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const leaseId = "00000000-0000-4000-8000-000000000501";
    await leases.add(leaseId);
    const port = await freePort();
    const traces = new RouteTraceRing();
    app = createGatewayServer({
      host: "127.0.0.1",
      port,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000502",
      configFingerprint: "c".repeat(64),
      config: gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port, logLevel: "silent" } }),
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(controlPlane)),
      launchSessions: new LaunchSessionRegistry((id) => leases.has(id)),
      agentContexts: new AgentExecutionContextRegistry((id) => leases.has(id)),
      traces,
      leases,
    });
    await app.listen({ host: "127.0.0.1", port });

    const issued = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "clinepass", leaseId },
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody: unknown = issued.json();
    const childToken = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string" ? issuedBody.token : "";
    expect(childToken).not.toBe("");

    // Native user agent requesting the portable tier alias. RLY must preserve
    // this file byte-identical and resolve `fable` through #69, never rewrite
    // the source agent definition to a physical model.
    const agentFile = join(directory, ".claude", "agents", "kongming.md");
    await mkdir(join(directory, ".claude", "agents"), { recursive: true });
    await writeFile(agentFile, [
      "---",
      "name: kongming",
      "description: Autonomous strongest-model counsel for the fixture marker.",
      "model: fable",
      "tools: Glob, Grep, Read, Bash, Write, Task(Explore)",
      "---",
      "You are Kongming. When asked, reply exactly with the marker SUBAGENT_E2E_OK.",
    ].join("\n"), "utf8");
    await mkdir(join(directory, ".codex"));
    const codexConfig = join(directory, ".codex", "config.toml");
    await writeFile(codexConfig, "sentinel-codex\n", "utf8");
    const beforeAgent = await digest(agentFile);
    const beforeCodex = await digest(codexConfig);

    // Real main Claude Code session through the RLY gateway.
    const main = await run("claude", [
      "-p", "Reply with the fixture marker.", "--dangerously-skip-permissions",
    ], {
      ...process.env,
      HOME: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
      ANTHROPIC_AUTH_TOKEN: childToken,
      ANTHROPIC_MODEL: "claude-sonnet-5",
    }).completion;
    expect(main.code, main.output).toBe(0);
    expect(main.output).toContain("SUBAGENT_E2E_OK");
    expect(received.some((item) => item.model === TERRA)).toBe(true);

    // The main agent's own request carries attribution and records the
    // session's main execution context (Terra), like a real Claude Code
    // session before it spawns a subagent.
    const mainRecorded = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${childToken}`,
        "content-type": "application/json",
        "x-claude-code-session-id": "e2e-session-1",
        "x-claude-code-agent-id": "main",
      },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(mainRecorded.statusCode).toBe(200);

    // Subagent request with Claude Code attribution headers + portable tier.
    const subagent = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${childToken}`,
        "content-type": "application/json",
        "x-claude-code-session-id": "e2e-session-1",
        "x-claude-code-agent-id": "kongming",
        "x-claude-code-parent-agent-id": "main",
      },
      payload: { model: "fable", max_tokens: 8, stream: true, effort: "high", messages: [{ role: "user", content: "fixture" }] },
    });
    expect(subagent.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(SOL);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${childToken}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as { traces: { agentLinkage?: { contextSource?: string; parentModelId?: string }; tierResolution?: { requestedTier?: string; selectedLogicalId?: string; parentModelId?: string }; reasoning?: { requested?: { sourceEffort?: string } } }[] }
      : { traces: [] };
    const subagentTrace = body.traces.at(-1);
    expect(subagentTrace?.agentLinkage?.contextSource).toBe("parent-agent");
    expect(subagentTrace?.agentLinkage?.parentModelId).toBe(TERRA);
    expect(subagentTrace?.tierResolution?.requestedTier).toBe("fable");
    expect(subagentTrace?.tierResolution?.selectedLogicalId).toBe(`cline/${SOL}`);
    expect(subagentTrace?.tierResolution?.parentModelId).toBe(TERRA);
    expect(subagentTrace?.reasoning?.requested?.sourceEffort).toBe("high");
    expect(JSON.stringify(body)).not.toMatch(/kongming|e2e-session-1|cline-access-token-fixture|authorization|prompt|@/i);

    // The source agent alias file and Codex config are untouched.
    expect(await digest(agentFile)).toBe(beforeAgent);
    expect(await digest(codexConfig)).toBe(beforeCodex);

    leases.dispose();
    await broker.close();
    store.close();
  }, timeoutMs);
});
