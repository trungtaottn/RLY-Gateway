import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { createClaudeChildEnvironment, createCodexChildEnvironment } from "../runtime/child-launcher.js";
import { appendObservation, claimIdentityFor, claimKeyFor, emptyClaimDocument, type CompatibilityClaimDocument, type EvidenceArtifactV2 } from "./claim.js";
import { CLAUDE_CODE_CONTRACT, CODEX_CLI_CONTRACT, type ClientContract } from "./client-fixtures.js";
import {
  INSTALLED_CLIENT_FIXTURE_REVISION,
  INSTALLED_CLIENT_RUNNER_VERSION,
  type BlackBoxWireSummary,
  type ChildInvocation,
  type CompatFailureCategory,
  type InstalledClientRunSpec,
  type InstalledClientRunSummary,
  type InvocationContext,
  type RunnerGateObservation,
} from "./runner-types.js";
import type { ClaimFeature } from "./claim.js";
import type { ClientKind, EndpointContract } from "./types.js";

/**
 * Layer B — installed-client black-box runner (#123).
 *
 * Runs the ACTUAL installed Claude Code / Codex CLI binary against a local
 * controlled fixture server (the same client-facing wire surface RLY serves:
 * Anthropic Messages + `/v1/models`, OpenAI Responses + `/v1/models`) with
 * child-only environment isolation (never real client config, never real
 * credentials). The fixture server records allowlisted wire metadata; each
 * gate evaluates the real client's behavior (request/stream framing,
 * cancellation, tool round-trip, multi-tool continuation, reasoning/effort,
 * discovery, attribution, tier aliases, subagent concurrency, config overlay,
 * long sessions) and emits a feature-scoped Evidence Artifact v2 record keyed
 * to the EXACT observed client version (observed ≠ reviewed baseline; drift
 * surveillance never auto-promotes).
 *
 * Hard invariants:
 * - Observed version is part of the claim identity; the supported baseline is
 *   recorded separately and never implied by a black-box pass.
 * - Missing binary → all gates `not-run` (`client-not-installed`), never PASS.
 * - Changed client behavior → typed gate failure keyed to that client version
 *   (`client-contract-drift`, `missing-agent-header`, ...).
 * - Raw results carry allowlisted metadata only; prompts, responses, reasoning
 *   text, credentials, and auth headers never persist.
 * - The runner never mutates trusted registry / effective compatibility state.
 */

/** Synthetic child token used only against the local fixture server. */
const FIXTURE_TOKEN = "fixture-token-blackbox";
/** Final response marker the fixture returns; the client echoes it in output. */
export const BLACKBOX_MARKER = "blackbox fixture marker OK";
const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const OUTPUT_CAP_BYTES = 64 * 1024;
/** Bounded wait for two concurrent requests in the parallel-subagent gate. */
const PARALLEL_HOLD_TIMEOUT_MS = 8_000;

type WireRecord = Readonly<{
  method: string;
  path: string;
  model?: string;
  streamRequested?: boolean;
  toolsRequested?: boolean;
  toolResultReceived?: boolean;
  reasoningRequested?: boolean;
  effortSignalPresent?: boolean;
  sessionHeaderPresent?: boolean;
  agentHeaderPresent?: boolean;
  parentAgentHeaderPresent?: boolean;
}>;

type Scenario =
  | "text" | "stream" | "tool" | "multi-tool" | "parallel-tool" | "reasoning"
  | "reasoning-tool" | "slow-stream" | "error" | "hold-two";

/** Local controlled fixture server exercising the client-facing wire surface. */
class BlackBoxFixtureServer {
  public readonly app: FastifyInstance;
  private scenario: Scenario = "text";
  private readonly records: WireRecord[] = [];
  private active = 0;
  private maxActive = 0;
  private aborted = false;
  private finished = false;
  private firstEventWaiters: (() => void)[] = [];

  public constructor(private readonly contract: EndpointContract) {
    this.app = Fastify({ logger: false });
    this.register();
  }

  public setScenario(scenario: Scenario): void {
    this.scenario = scenario;
    this.records.length = 0;
    this.active = 0;
    this.maxActive = 0;
    this.aborted = false;
    this.finished = false;
  }

  /** Resolves when the current streaming request has emitted its first frame. */
  public waitForFirstEvent(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstEventWaiters = this.firstEventWaiters.filter((waiter) => waiter !== settle);
        reject(new Error("fixture first event timeout"));
      }, timeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        this.firstEventWaiters = this.firstEventWaiters.filter((waiter) => waiter !== settle);
        resolve();
      };
      this.firstEventWaiters.push(settle);
    });
  }

  private notifyFirstEvent(): void {
    for (const waiter of this.firstEventWaiters.splice(0)) waiter();
  }

  public wireSummary(exitCode: number | null, exitSignal: string | null, timedOut: boolean): BlackBoxWireSummary {
    return Object.freeze({
      contract: this.contract,
      requestCount: this.records.length,
      discoveryRequested: this.records.some((record) => record.method === "GET" && record.path === "/v1/models"),
      sessionHeaderPresent: this.records.some((record) => record.sessionHeaderPresent === true),
      agentHeaderPresent: this.records.some((record) => record.agentHeaderPresent === true),
      parentAgentHeaderPresent: this.records.some((record) => record.parentAgentHeaderPresent === true),
      streamRequested: this.records.some((record) => record.streamRequested === true),
      toolRequested: this.records.some((record) => record.toolsRequested === true),
      toolResultReceived: this.records.some((record) => record.toolResultReceived === true),
      reasoningRequested: this.records.some((record) => record.reasoningRequested === true),
      effortSignalPresent: this.records.some((record) => record.effortSignalPresent === true),
      exitCode,
      exitSignal,
      timedOut,
      upstreamAborted: this.aborted,
      concurrentRequests: this.maxActive,
    });
  }

  private record(request: Readonly<{
    method: string; path: string; model?: unknown; stream?: unknown; tools?: unknown;
    contentBlocks?: unknown; reasoning?: unknown; effort?: unknown; headers: Readonly<Record<string, string | string[] | undefined>>;
  }>): void {
    const contentBlocks = Array.isArray(request.contentBlocks) ? request.contentBlocks : [];
    this.records.push(Object.freeze({
      method: request.method,
      path: request.path,
      ...(typeof request.model === "string" ? { model: request.model } : {}),
      ...(typeof request.stream === "boolean" ? { streamRequested: request.stream } : {}),
      ...(Array.isArray(request.tools) && request.tools.length > 0 ? { toolsRequested: true } : {}),
      ...(contentBlocks.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result") ? { toolResultReceived: true } : {}),
      ...(request.reasoning !== undefined ? { reasoningRequested: true } : {}),
      ...(typeof request.effort === "string" ? { effortSignalPresent: true } : {}),
      sessionHeaderPresent: Boolean(request.headers["x-claude-code-session-id"]),
      agentHeaderPresent: Boolean(request.headers["x-claude-code-agent-id"]),
      parentAgentHeaderPresent: Boolean(request.headers["x-claude-code-parent-agent-id"]),
    }));
  }

  private enter(): void {
    this.active += 1;
    if (this.active > this.maxActive) this.maxActive = this.active;
  }

  private leave(): void {
    this.active -= 1;
  }

  private register(): void {
    const app = this.app;
    app.get("/v1/models", async (_request, reply) => {
      this.enter();
      this.records.push(Object.freeze({
        method: "GET", path: "/v1/models",
        sessionHeaderPresent: false, agentHeaderPresent: false, parentAgentHeaderPresent: false,
      }));
      this.leave();
      return reply.send({
        data: [
          { type: "model", id: "claude-rly-openrouter-abc123", display_name: "RLY fixture", created_at: 0 },
          { type: "model", id: "claude-haiku-4-5", display_name: "Haiku", created_at: 0 },
          { type: "model", id: "claude-sonnet-4-5", display_name: "Sonnet", created_at: 0 },
          { type: "model", id: "claude-opus-4-5", display_name: "Opus", created_at: 0 },
        ],
        has_more: false,
        first_id: "claude-rly-openrouter-abc123",
        last_id: "claude-opus-4-5",
      });
    });

    if (this.contract === "anthropic-messages") {
      this.registerAnthropicMessages(app);
      return;
    }
    this.registerOpenAiResponses(app);
  }

  // -------------------------------------------------------------------------
  // Anthropic Messages surface (Claude Code)
  // -------------------------------------------------------------------------

  private anthropicFrames(kind: "text" | "tool" | "parallel-tool" | "reasoning", index: number): readonly string[] {
    const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const frames: string[] = [];
    frames.push(sse("message_start", {
      type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }));
    if (kind === "reasoning") {
      frames.push(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking" } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      frames.push(sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: BLACKBOX_MARKER } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
    } else if (kind === "tool" || kind === "parallel-tool") {
      const blocks = kind === "parallel-tool"
        ? [
            { type: "tool_use", id: "toolu_fixture_a", name: "Bash", input: { command: "printf blackbox-fixture-tool" } },
            { type: "tool_use", id: "toolu_fixture_b", name: "Bash", input: { command: "printf blackbox-fixture-tool" } },
          ]
        : [{ type: "tool_use", id: `toolu_fixture_${String(index)}`, name: "Bash", input: { command: "printf blackbox-fixture-tool" } }];
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block = blocks[blockIndex];
        if (block === undefined) continue;
        frames.push(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: block }));
        frames.push(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: "{}" } }));
        frames.push(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
      }
      frames.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }));
      frames.push(sse("message_stop", { type: "message_stop" }));
      return frames;
    } else {
      frames.push(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: BLACKBOX_MARKER } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    }
    frames.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }));
    frames.push(sse("message_stop", { type: "message_stop" }));
    return frames;
  }

  private anthropicToolPayload(index: number, parallel: boolean): Record<string, unknown> {
    const blocks = parallel
      ? [
          { type: "tool_use", id: "toolu_fixture_a", name: "Bash", input: { command: "printf blackbox-fixture-tool" } },
          { type: "tool_use", id: "toolu_fixture_b", name: "Bash", input: { command: "printf blackbox-fixture-tool" } },
        ]
      : [{ type: "tool_use", id: `toolu_fixture_${String(index)}`, name: "Bash", input: { command: "printf blackbox-fixture-tool" } }];
    return {
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: blocks, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: blocks.length },
    };
  }

  private anthropicTextPayload(): Record<string, unknown> {
    return {
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [{ type: "text", text: BLACKBOX_MARKER }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 },
    };
  }

  private anthropicToolKind(scenario: Scenario, requestIndex: number, hasToolResult: boolean): "tool" | "parallel-tool" | undefined {
    if (!["tool", "reasoning-tool", "multi-tool", "parallel-tool"].includes(scenario)) return undefined;
    if (hasToolResult) return undefined;
    if (scenario === "multi-tool" && requestIndex >= 3) return undefined;
    return scenario === "parallel-tool" ? "parallel-tool" : "tool";
  }

  private registerAnthropicMessages(app: FastifyInstance): void {
    app.post("/v1/messages", async (request, reply) => {
      this.enter();
      const body = request.body as Readonly<{
        model?: unknown; stream?: unknown; tools?: unknown; thinking?: unknown; effort?: unknown; messages?: readonly unknown[];
      }>;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const contentBlocks = messages.flatMap((message) => {
        const content = (message as { content?: unknown }).content;
        return Array.isArray(content) ? (content as readonly unknown[]) : [];
      });
      this.record({
        method: "POST", path: "/v1/messages",
        model: body.model, stream: body.stream, tools: body.tools,
        contentBlocks, reasoning: body.thinking, effort: body.effort,
        headers: request.headers,
      });
      const hasToolResult = contentBlocks.some((block) => (block as { type?: unknown }).type === "tool_result");
      const requestIndex = this.records.filter((record) => record.method === "POST").length;
      try {
        if (this.scenario === "error") {
          return await reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "fixture error" } });
        }
        if (this.scenario === "hold-two") {
          await this.waitForTwoConcurrent();
        }
        if (this.scenario === "slow-stream") {
          return this.openStream(reply, (write) => {
            write(this.anthropicFrames("text", 0)[0] ?? "");
          }, request);
        }
        const isStream = body.stream === true;
        const toolKind = this.anthropicToolKind(this.scenario, requestIndex, hasToolResult);
        if (isStream) {
          const kind = toolKind ?? (this.scenario === "reasoning" ? "reasoning" : "text");
          return this.openStream(reply, (write) => {
            for (const frame of this.anthropicFrames(kind, requestIndex)) write(frame);
          }, request);
        }
        this.finished = true;
        if (toolKind !== undefined) {
          return await reply.send(this.anthropicToolPayload(requestIndex, toolKind === "parallel-tool"));
        }
        return await reply.send(this.anthropicTextPayload());
      } finally {
        this.leave();
      }
    });
  }

  // -------------------------------------------------------------------------
  // OpenAI Responses surface (Codex CLI)
  // -------------------------------------------------------------------------

  private responsesToolPayload(index: number, parallel: boolean): Record<string, unknown> {
    const output = parallel
      ? [
          { type: "function_call", id: "fc_a", call_id: "call_a", name: "Bash", arguments: "{\"command\":\"printf blackbox-fixture-tool\"}" },
          { type: "function_call", id: "fc_b", call_id: "call_b", name: "Bash", arguments: "{\"command\":\"printf blackbox-fixture-tool\"}" },
        ]
      : [{ type: "function_call", id: `fc_${String(index)}`, call_id: `call_${String(index)}`, name: "Bash", arguments: "{\"command\":\"printf blackbox-fixture-tool\"}" }];
    return {
      id: "resp_fixture", object: "response", created_at: 0, status: "completed", model: "gpt-5.4",
      output, usage: { input_tokens: 1, output_tokens: output.length },
    };
  }

  private responsesTextPayload(): Record<string, unknown> {
    return {
      id: "resp_fixture", object: "response", created_at: 0, status: "completed", model: "gpt-5.4",
      output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: BLACKBOX_MARKER, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
  }

  private registerOpenAiResponses(app: FastifyInstance): void {
    app.post("/v1/responses", async (request, reply) => {
      this.enter();
      const body = request.body as Readonly<{
        model?: unknown; stream?: unknown; tools?: unknown; reasoning?: unknown; input?: unknown;
      }>;
      const input = Array.isArray(body.input) ? body.input : [];
      const functionCallOutputs = input.filter((item) => (item as { type?: unknown }).type === "function_call_output");
      this.record({
        method: "POST", path: "/v1/responses",
        model: body.model, stream: body.stream, tools: body.tools,
        contentBlocks: functionCallOutputs, reasoning: body.reasoning,
        effort: (body.reasoning as { effort?: unknown } | undefined)?.effort,
        headers: request.headers,
      });
      const hasToolResult = functionCallOutputs.length > 0;
      const requestIndex = this.records.filter((record) => record.method === "POST").length;
      try {
        if (this.scenario === "error") {
          return await reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "fixture error" } });
        }
        if (this.scenario === "hold-two") {
          await this.waitForTwoConcurrent();
        }
        if (this.scenario === "slow-stream") {
          return this.openStream(reply, (write) => {
            write("event: response.created\ndata: {}\n\n");
          }, request);
        }
        const toolKind = this.anthropicToolKind(this.scenario, requestIndex, hasToolResult);
        if (body.stream === true) {
          return this.openStream(reply, (write) => {
            write("event: response.created\ndata: {}\n\n");
            write("event: response.in_progress\ndata: {}\n\n");
            write("event: response.output_item.added\ndata: {}\n\n");
            if (toolKind !== undefined) {
              write("event: response.function_call_arguments.delta\ndata: {}\n\n");
            } else {
              write("event: response.output_text.delta\ndata: {}\n\n");
            }
            write("event: response.output_item.done\ndata: {}\n\n");
            write("event: response.completed\ndata: {}\n\n");
          }, request);
        }
        this.finished = true;
        if (toolKind !== undefined) {
          return await reply.send(this.responsesToolPayload(requestIndex, toolKind === "parallel-tool"));
        }
        return await reply.send(this.responsesTextPayload());
      } finally {
        this.leave();
      }
    });
  }

  /** Waits (bounded) until two requests are concurrently in-flight. */
  private async waitForTwoConcurrent(): Promise<void> {
    const started = Date.now();
    while (this.maxActive < 2 && Date.now() - started < PARALLEL_HOLD_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Opens a hijacked SSE stream, writes frames, tracks abort. */
  private openStream(
    reply: FastifyReply,
    write: (write: (chunk: string) => void) => void,
    request: FastifyRequest,
  ): undefined {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let first = true;
    write((chunk) => {
      if (first) {
        first = false;
        this.notifyFirstEvent();
      }
      reply.raw.write(chunk);
    });
    if (this.scenario === "slow-stream") {
      const requestClose = (): void => {
        if (!this.finished) this.aborted = true;
        request.raw.removeListener("close", requestClose);
      };
      request.raw.once("close", requestClose);
      return undefined;
    }
    this.finished = true;
    reply.raw.end();
    return undefined;
  }
}

type ChildOutcome = Readonly<{
  code: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
  timingMs: number;
}>;

function spawnChild(invocation: ChildInvocation, timeoutMs: number): { outcome: Promise<ChildOutcome>; kill: () => void } {
  const child = spawn(invocation.executable, invocation.args, {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const startedAt = Date.now();
  let timedOut = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const outcome = new Promise<ChildOutcome>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve(Object.freeze({
        code,
        signal,
        output: `${stdout}${stderr}`.slice(0, OUTPUT_CAP_BYTES),
        timedOut,
        timingMs: Date.now() - startedAt,
      }));
    });
    killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);
  });
  const kill = (): void => {
    if (settled) return;
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  };
  return { outcome, kill };
}

function claudeGateArgs(gate: ClaimFeature): readonly string[] {
  const base = ["-p", `Reply with the exact text: ${BLACKBOX_MARKER}.`, "--dangerously-skip-permissions", "--no-session-persistence"];
  switch (gate) {
    case "tools-single":
    case "tools-multi":
    case "tools-parallel":
    case "reasoning-tools":
      return ["-p", "Use the Bash tool and report the output.", "--dangerously-skip-permissions", "--no-session-persistence"];
    case "subagent-routing":
      return ["-p", `Reply with the exact text: ${BLACKBOX_MARKER}.`, "--model", "haiku", "--dangerously-skip-permissions", "--no-session-persistence"];
    default:
      return base;
  }
}

function codexGateArgs(gate: ClaimFeature): readonly string[] {
  const prompt = `Reply with the exact text: ${BLACKBOX_MARKER}.`;
  switch (gate) {
    case "tools-single":
    case "tools-multi":
    case "tools-parallel":
    case "reasoning-tools":
      return ["exec", "--skip-git-repo-check", "Use the Bash tool and report the output."];
    default:
      return ["exec", "--skip-git-repo-check", prompt];
  }
}

async function writeConfigOverlay(client: ClientKind, configDirectory: string): Promise<void> {
  if (client === "claude-code") {
    await writeFile(join(configDirectory, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }, null, 2), "utf8");
    return;
  }
  await mkdir(join(configDirectory, ".codex"), { recursive: true });
  await writeFile(join(configDirectory, ".codex", "config.toml"), 'model = "gpt-5.4"\n', "utf8");
}

function buildInvocation(spec: InstalledClientRunSpec, fixtureBaseUrl: string, configDirectory: string, gate: ClaimFeature, sessionId: string): ChildInvocation {
  const environment = spec.environment ?? process.env;
  const context: InvocationContext = Object.freeze({ gate, fixtureBaseUrl, configDirectory, environment });
  if (spec.invoke !== undefined) return spec.invoke(context);
  const blackboxEnv: NodeJS.ProcessEnv = {
    RLY_BLACKBOX_GATE: gate,
    RLY_BLACKBOX_FIXTURE_URL: fixtureBaseUrl,
    RLY_BLACKBOX_CONFIG_DIR: configDirectory,
    RLY_BLACKBOX_SESSION_ID: sessionId,
  };
  if (spec.client === "claude-code") {
    return Object.freeze({
      executable: spec.executable,
      args: claudeGateArgs(gate),
      env: Object.freeze({
        ...createClaudeChildEnvironment(environment, fixtureBaseUrl, FIXTURE_TOKEN, configDirectory),
        ...blackboxEnv,
      }),
    });
  }
  return Object.freeze({
    executable: spec.executable,
    args: codexGateArgs(gate),
    env: Object.freeze({
      ...createCodexChildEnvironment(environment, fixtureBaseUrl, FIXTURE_TOKEN, configDirectory),
      ...blackboxEnv,
    }),
  });
}

function scenarioForGate(gate: ClaimFeature): Scenario {
  switch (gate) {
    case "streaming": return "stream";
    case "tools-single": return "tool";
    case "tools-multi": return "multi-tool";
    case "tools-parallel": return "parallel-tool";
    case "reasoning-tools": return "reasoning-tool";
    case "reasoning": return "reasoning";
    case "cancellation": return "slow-stream";
    case "subagent-parallel": return "hold-two";
    default: return "text";
  }
}

function observation(gate: ClaimFeature, result: RunnerGateObservation["result"], failureReason?: CompatFailureCategory, detail?: string, timingMs?: number): RunnerGateObservation {
  return Object.freeze({
    gate, result,
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(detail === undefined ? {} : { detail }),
    ...(timingMs === undefined ? {} : { timingMs }),
  });
}

function markerInOutput(output: string): boolean {
  return output.includes(BLACKBOX_MARKER) || output.includes("blackbox-fixture-tool");
}

function evaluateGate(
  gate: ClaimFeature,
  wire: BlackBoxWireSummary,
  primary: ChildOutcome,
  secondary: ChildOutcome | undefined,
  timingMs: number,
): RunnerGateObservation {
  switch (gate) {
    case "text":
      if (wire.requestCount < 1) return observation(gate, "failed", "client-contract-drift", "no wire request observed", timingMs);
      if (wire.timedOut) return observation(gate, "failed", "timeout-cancel-failure", "client did not finish in bound", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed or did not echo marker", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "streaming":
      if (!wire.streamRequested) return observation(gate, "failed", "client-contract-drift", "stream not requested", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed or did not consume stream", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "cancellation":
      if (!wire.upstreamAborted) return observation(gate, "failed", "timeout-cancel-failure", "upstream abort not observed", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "tools-single":
      if (!wire.toolRequested) return observation(gate, "failed", "client-contract-drift", "no tool request", timingMs);
      if (!wire.toolResultReceived) return observation(gate, "failed", "malformed-continuation", "tool result round-trip missing", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed after tool loop", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "tools-multi":
      if (wire.requestCount < 3) return observation(gate, "failed", "malformed-continuation", "multi-turn continuation missing", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed after multi-turn loop", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "tools-parallel":
      if (!wire.toolResultReceived || wire.requestCount < 2) return observation(gate, "failed", "malformed-continuation", "parallel tool continuation missing", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed after parallel tools", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "reasoning":
      if (!wire.reasoningRequested) return observation(gate, "not-run", "client-did-not-send-reasoning-config", "client sent no reasoning config", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "client failed or reasoning lost", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "reasoning-tools":
      if (!wire.reasoningRequested || !wire.toolRequested) return observation(gate, "not-run", "client-did-not-send-reasoning-config", "no reasoning+tool request", timingMs);
      if (!wire.toolResultReceived || primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "client-contract-drift", "reasoning+tool interleave failed", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "model-discovery":
      if (!wire.discoveryRequested) return observation(gate, "failed", "client-contract-drift", "no /v1/models discovery request", timingMs);
      if (primary.code !== 0) return observation(gate, "failed", "client-contract-drift", "client failed after discovery", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "session-attribution":
      if (!wire.sessionHeaderPresent) return observation(gate, "failed", "missing-agent-header", "session attribution header absent", timingMs);
      if (primary.code !== 0) return observation(gate, "failed", "client-contract-drift", "client failed", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "subagent-routing":
      if (primary.code !== 0 || wire.requestCount < 1) return observation(gate, "failed", "client-contract-drift", "tier alias not accepted", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "subagent-parallel":
      if (wire.concurrentRequests < 2) return observation(gate, "failed", "client-contract-drift", "no concurrent attribution contexts", timingMs);
      if (primary.code !== 0 || (secondary !== undefined && secondary.code !== 0)) return observation(gate, "failed", "client-contract-drift", "a concurrent session failed", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "effort-signal":
      if (!wire.effortSignalPresent) return observation(gate, "not-run", "client-did-not-send-effort-signal", "client sent no effort signal", timingMs);
      if (primary.code !== 0 || !markerInOutput(primary.output)) return observation(gate, "failed", "effort-signal-lost", "client failed or effort lost", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "long-running-session":
      if (wire.requestCount < 2) return observation(gate, "failed", "client-contract-drift", "no session continuation observed", timingMs);
      if (primary.code !== 0) return observation(gate, "failed", "client-contract-drift", "client failed in long session", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    case "config-overlay":
      if (wire.requestCount < 1) return observation(gate, "failed", "client-contract-drift", "no wire request observed", timingMs);
      if (primary.code !== 0) return observation(gate, "failed", "client-contract-drift", "client failed with overlay", timingMs);
      return observation(gate, "passed", undefined, undefined, timingMs);
    default:
      return observation(gate, "not-run", "unsupported-feature", "gate not supported by black-box", timingMs);
  }
}

function defaultGatesFor(client: ClientKind): readonly ClaimFeature[] {
  return client === "claude-code"
    ? ["text", "streaming", "cancellation", "tools-single", "tools-multi", "tools-parallel", "reasoning", "reasoning-tools", "model-discovery", "session-attribution", "subagent-routing", "subagent-parallel", "effort-signal", "long-running-session", "config-overlay"]
    : ["text", "streaming", "cancellation", "tools-single", "tools-multi", "tools-parallel", "reasoning", "reasoning-tools", "model-discovery", "effort-signal", "config-overlay"];
}

/** Executes the installed-client black-box matrix for one client binary. */
export async function runInstalledClientMatrix(spec: InstalledClientRunSpec): Promise<InstalledClientRunSummary> {
  const client = spec.client;
  const contract: ClientContract = client === "claude-code" ? CLAUDE_CODE_CONTRACT : CODEX_CLI_CONTRACT;
  const gates = spec.gates ?? defaultGatesFor(client);
  const now = spec.now ?? (() => new Date().toISOString());
  const environment = Object.freeze({
    platform: spec.platform?.platform ?? process.platform,
    nodeVersion: spec.platform?.nodeVersion ?? process.version,
  });
  const timeoutMs = spec.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const fixtureRevision = spec.fixtureRevision ?? INSTALLED_CLIENT_FIXTURE_REVISION;
  const fixture = new BlackBoxFixtureServer(client === "claude-code" ? "anthropic-messages" : "openai-responses");
  const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  const gatesRun: RunnerGateObservation[] = [];
  const evidence: EvidenceArtifactV2[] = [];
  const claimsByKey = new Map<string, CompatibilityClaimDocument>();
  try {
    for (const gate of gates) {
      const gateObservation = await runSingleGate(spec, fixture, address, gate, timeoutMs);
      gatesRun.push(gateObservation);
      const claimIdentity = claimIdentityFor({
        client,
        clientVersion: spec.observedVersion,
        contract,
        adapterId: "installed-client-blackbox",
        accessProviderId: "local-installed",
        physicalModelId: "installed-binary",
      });
      const claimKey = claimKeyFor(claimIdentity, gate);
      const record: EvidenceArtifactV2 = Object.freeze({
        claimKey,
        feature: gate,
        layer: "B",
        kind: "installed-client",
        fixtureRevision,
        runnerVersion: INSTALLED_CLIENT_RUNNER_VERSION,
        checkedAt: now(),
        result: gateObservation.result,
        ...(gateObservation.failureReason === undefined ? {} : { failureReason: gateObservation.failureReason }),
        environment,
        ...(gateObservation.timingMs === undefined ? {} : { timingMs: gateObservation.timingMs }),
      });
      evidence.push(record);
      const existing = claimsByKey.get(claimKey) ?? emptyClaimDocument(claimIdentity, gate);
      claimsByKey.set(claimKey, appendObservation(existing, record));
    }
    return Object.freeze({
      client,
      executable: spec.executable,
      observedVersion: spec.observedVersion,
      supportedBaseline: spec.supportedBaseline,
      fixtureRevision,
      gates: Object.freeze(gatesRun),
      evidence: Object.freeze(evidence),
      claims: Object.freeze([...claimsByKey.values()]),
      environment,
    });
  } finally {
    await fixture.app.close();
  }
}

async function runSingleGate(
  spec: InstalledClientRunSpec,
  fixture: BlackBoxFixtureServer,
  fixtureBaseUrl: string,
  gate: ClaimFeature,
  timeoutMs: number,
): Promise<RunnerGateObservation> {
  const configDirectory = await mkdtemp(join(tmpdir(), "rly-blackbox-"));
  try {
    await writeConfigOverlay(spec.client, configDirectory);
    if (gate === "subagent-parallel") {
      fixture.setScenario("hold-two");
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const invocationA = buildInvocation(spec, fixtureBaseUrl, configDirectory, gate, sessionA);
      const invocationB = buildInvocation(spec, fixtureBaseUrl, configDirectory, gate, sessionB);
      const started = Date.now();
      const [left, right] = await Promise.all([
        spawnChild(invocationA, timeoutMs).outcome,
        spawnChild(invocationB, timeoutMs).outcome,
      ]);
      const wire = fixture.wireSummary(left.code ?? right.code, left.signal ?? right.signal, left.timedOut || right.timedOut);
      return evaluateGate(gate, wire, left, right, Date.now() - started);
    }
    fixture.setScenario(scenarioForGate(gate));
    if (gate === "cancellation") {
      const invocation = buildInvocation(spec, fixtureBaseUrl, configDirectory, gate, randomUUID());
      const spawned = spawnChild(invocation, timeoutMs);
      const started = Date.now();
      try {
        await fixture.waitForFirstEvent(timeoutMs);
      } catch {
        spawned.kill();
        return observation(gate, "failed", "timeout-cancel-failure", "client did not reach streaming first event", undefined);
      }
      spawned.kill();
      const outcome = await spawned.outcome;
      const wire = fixture.wireSummary(outcome.code, outcome.signal, outcome.timedOut);
      return evaluateGate(gate, wire, outcome, undefined, Date.now() - started);
    }
    const invocation = buildInvocation(spec, fixtureBaseUrl, configDirectory, gate, randomUUID());
    const started = Date.now();
    const outcome = await spawnChild(invocation, timeoutMs).outcome;
    const wire = fixture.wireSummary(outcome.code, outcome.signal, outcome.timedOut);
    return evaluateGate(gate, wire, outcome, undefined, Date.now() - started);
  } catch {
    // Never leak the underlying error message: failures stay typed/redacted.
    return observation(gate, "failed", "environment-inability", "gate execution error", undefined);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}
