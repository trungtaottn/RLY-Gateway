import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeChildEnvironment,
  createCodexChildEnvironment,
  launchClaude,
  launchCodex,
  type ChildSpawner,
  type ChildProcessLike,
  type SignalSource,
} from "../../src/runtime/child-launcher.js";

class TestChild implements ChildProcessLike {
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  public readonly signals: NodeJS.Signals[] = [];

  public once(event: "close" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): unknown {
    if (event === "close") this.closeListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    else this.errorListener = listener as (error: Error) => void;
    return this;
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  public close(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeListener?.(code, signal);
  }

  public fail(error: Error): void {
    this.errorListener?.(error);
  }
}

class TestSignals implements SignalSource {
  private readonly listeners = new Map<NodeJS.Signals, () => void>();

  public once(signal: NodeJS.Signals, listener: () => void): unknown {
    this.listeners.set(signal, listener);
    return this;
  }

  public removeListener(signal: NodeJS.Signals, listener: () => void): unknown {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
    return this;
  }

  public emit(signal: NodeJS.Signals): void {
    const listener = this.listeners.get(signal);
    this.listeners.delete(signal);
    listener?.();
  }
}

describe("Claude child launcher", () => {
  it("creates an isolated child environment", () => {
    const parent = { PATH: "/bin", ANTHROPIC_BASE_URL: "http://outside", ANTHROPIC_API_KEY: "outside-key" };
    const environment = createClaudeChildEnvironment(parent, "http://127.0.0.1:17871", "transient-token");

    expect(environment).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:17871",
      ANTHROPIC_AUTH_TOKEN: "transient-token",
    });
    expect(environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(parent).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://outside",
      ANTHROPIC_API_KEY: "outside-key",
    });
  });

  it("forwards arguments unchanged and propagates child exit", async () => {
    const child = new TestChild();
    let suppliedOptions: Parameters<ChildSpawner>[2] | undefined;
    let suppliedArgs: readonly string[] | undefined;
    const spawner: ChildSpawner = (_executable, args, options) => {
      suppliedArgs = args;
      suppliedOptions = options;
      return child;
    };
    const launched = launchClaude({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient-token",
      executable: "test-claude",
      args: ["--model", "quoted value", "--", "-not-a-gateway-flag"],
      environment: { PATH: "/bin" },
      spawner,
      signalSource: new TestSignals(),
    });

    const childEnvironment = suppliedOptions?.env;
    expect(childEnvironment?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:17871");
    expect(childEnvironment?.["ANTHROPIC_AUTH_TOKEN"]).toBe("transient-token");
    expect(childEnvironment?.["CLAUDE_CONFIG_DIR"]).toMatch(/rly-gateway-claude-/);
    expect(suppliedOptions?.stdio).toBe("inherit");
    expect(suppliedArgs).toEqual(["--model", "quoted value", "--", "-not-a-gateway-flag"]);
    child.close(23, null);
    await expect(launched).resolves.toEqual({ code: 23, signal: null });
  });

  it("uses the durable overlay directory when provided and leaves it in place", async () => {
    const child = new TestChild();
    let suppliedOptions: Parameters<ChildSpawner>[2] | undefined;
    const spawner: ChildSpawner = (_executable, _args, options) => {
      suppliedOptions = options;
      return child;
    };
    const overlay = join(tmpdir(), "rly-durable-claude-overlay");
    await mkdir(overlay, { recursive: true });
    const launched = launchClaude({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient-token",
      args: [],
      environment: { PATH: "/bin" },
      configDirectory: overlay,
      spawner,
      signalSource: new TestSignals(),
    });
    expect(suppliedOptions?.env["CLAUDE_CONFIG_DIR"]).toBe(overlay);
    child.close(0, null);
    await expect(launched).resolves.toEqual({ code: 0, signal: null });
    // Durable overlay is never removed by the launcher.
    await expect(access(overlay)).resolves.toBeUndefined();
  });

  it("creates an isolated Codex child environment", async () => {
    const parent = { PATH: "/bin", OPENAI_BASE_URL: "http://outside", CODEX_API_KEY: "outside-key" };
    const environment = createCodexChildEnvironment(parent, "http://127.0.0.1:17871", "transient-token");
    expect(environment).toMatchObject({
      PATH: "/bin",
      OPENAI_BASE_URL: "http://127.0.0.1:17871",
      OPENAI_API_KEY: "transient-token",
    });
    expect(environment).not.toHaveProperty("CODEX_HOME");
    expect(environment).not.toHaveProperty("CODEX_API_KEY");
    const child = new TestChild();
    let suppliedOptions: Parameters<ChildSpawner>[2] | undefined;
    const launched = launchCodex({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient-token",
      executable: "test-codex",
      args: ["exec", "fixture"],
      environment: { PATH: "/bin" },
      spawner: (_executable, args, options) => {
        expect(args).toEqual(["exec", "fixture"]);
        suppliedOptions = options;
        return child;
      },
      signalSource: new TestSignals(),
    });
    if (suppliedOptions === undefined) throw new Error("Codex child was not spawned");
    expect(suppliedOptions.env["CODEX_HOME"]).toMatch(/rly-gateway-codex-/);
    child.close(0, null);
    await expect(launched).resolves.toEqual({ code: 0, signal: null });
  });

  it("uses Claude's documented no-persistence flag for print sessions only", async () => {
    const child = new TestChild();
    let suppliedArgs: readonly string[] | undefined;
    const launched = launchClaude({
      gatewayBaseUrl: "http://127.0.0.1:17871", authToken: "transient-token", args: ["-p", "fixture"],
      spawner: (_executable, args) => { suppliedArgs = args; return child; }, signalSource: new TestSignals(),
    });
    expect(suppliedArgs).toEqual(["-p", "fixture", "--no-session-persistence"]);
    child.close(0, null);
    await expect(launched).resolves.toEqual({ code: 0, signal: null });
  });

  it("forwards a shutdown signal once and bounds a slow child shutdown", async () => {
    vi.useFakeTimers();
    try {
      const child = new TestChild();
      const signals = new TestSignals();
      const launched = launchClaude({
        gatewayBaseUrl: "http://127.0.0.1:17871",
        authToken: "transient-token",
        args: [],
        spawner: () => child,
        signalSource: signals,
        shutdownTimeoutMs: 10,
      });

      signals.emit("SIGINT");
      signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(10);
      expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
      child.close(null, "SIGINT");
      await expect(launched).resolves.toEqual({ code: null, signal: "SIGINT" });
    } finally {
      vi.useRealTimers();
    }
  });
});
