import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchClaude, type ChildProcessLike, type ChildSpawner, type SignalSource } from "../../src/runtime/child-launcher.js";
import {
  CLAUDE_OVERLAY_ALLOWLIST_VERSION,
  claudeOverlayPaths,
  composeOverlayPluginConfig,
  composeOverlaySettings,
  nativeClaudeConfigDirectory,
  prepareClaudeOverlay,
  readClaudeOverlayStatus,
  RLY_MODEL_PREFIX,
  rlyOwnedModel,
} from "../../src/runtime/claude-overlay.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-overlay-"));
  directories.push(directory);
  return directory;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileMode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

function nativeEnvironment(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: "/bin" };
}

describe("RLY Claude configuration overlay", () => {
  it("composes native settings one-way: unrelated keys preserved, gateway env stripped, model kept", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({
      model: "claude-sonnet-4-5",
      theme: "dark",
      permissions: { allow: ["Bash"] },
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_BASE_URL: "http://native.example",
        ANTHROPIC_AUTH_TOKEN: "native-secret",
        ANTHROPIC_API_KEY: "native-key",
        OPENAI_API_KEY: "native-openai",
      },
    }), "utf8");
    const before = await digest(join(native, "settings.json"));

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    expect(resolution.directory).toBe(join(controlPlane, "claude"));
    expect(resolution.source).toBe(native);
    expect(resolution.composed).toBe(true);
    const overlay = JSON.parse(await readFile(resolution.directory + "/settings.json", "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(overlay["theme"]).toBe("dark");
    expect(overlay["permissions"]).toEqual({ allow: ["Bash"] });
    expect(overlay["env"]).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    // Native input is never modified.
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("refreshes allowlisted agents, commands, and skills without touching other files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await mkdir(join(native, "commands"), { recursive: true });
    await mkdir(join(native, "skills", "review"), { recursive: true });
    await mkdir(join(native, "plugins", "cache"), { recursive: true });
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\nreviewer fixture\n", "utf8");
    await writeFile(join(native, "agents", "ignored.txt"), "not an agent\n", "utf8");
    await writeFile(join(native, "commands", "ship.md"), "ship fixture\n", "utf8");
    await writeFile(join(native, "skills", "review", "SKILL.md"), "# skill fixture\n", "utf8");
    await writeFile(join(native, "plugins", "cache", "binary.bin"), "plugin cache must not be copied\n", "utf8");
    await writeFile(join(native, "unknown.json"), "unknown surface\n", "utf8");

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    expect(await readFile(join(resolution.directory, "agents", "reviewer.md"), "utf8")).toBe("# reviewer\nreviewer fixture\n");
    expect(await readFile(join(resolution.directory, "commands", "ship.md"), "utf8")).toBe("ship fixture\n");
    expect(await readFile(join(resolution.directory, "skills", "review", "SKILL.md"), "utf8")).toBe("# skill fixture\n");
    // Non-allowlisted surfaces are never copied.
    await expect(stat(join(resolution.directory, "agents", "ignored.txt"))).rejects.toThrow();
    await expect(stat(join(resolution.directory, "plugins", "cache"))).rejects.toThrow();
    await expect(stat(join(resolution.directory, "unknown.json"))).rejects.toThrow();
    expect(resolution.refreshed).toEqual(expect.arrayContaining(["agents/reviewer.md", "commands/ship.md", "skills/review/SKILL.md"]));
    expect(resolution.refreshed).not.toEqual(expect.arrayContaining(["agents/ignored.txt", "plugins/cache/binary.bin"]));
  });

  it("carries only the plugin enablement declaration and drops credential-bearing keys", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "plugins"), { recursive: true });
    await writeFile(join(native, "plugins", "config.json"), JSON.stringify({
      enabledPlugins: ["https://example.com/marketplace"],
      marketplaces: ["https://example.com/marketplace"],
      oauthAccounts: { "example.com": { oauthToken: "fixture-token", refreshToken: "fixture-refresh" } },
      installedPlugins: [{ name: "private" }],
    }), "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    const carried = JSON.parse(await readFile(paths.pluginConfig, "utf8")) as Record<string, unknown>;
    expect(carried).toEqual({
      enabledPlugins: ["https://example.com/marketplace"],
      marketplaces: ["https://example.com/marketplace"],
    });
    expect(JSON.stringify(carried)).not.toMatch(/token|secret|oauthAccount|installedPlugins/i);
  });

  it("uses private permissions for overlay files and directories", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    expect(await fileMode(paths.directory)).toBe(0o700);
    expect(await fileMode(join(paths.agents))).toBe(0o700);
    expect(await fileMode(paths.settings)).toBe(0o600);
    expect(await fileMode(join(paths.agents, "reviewer.md"))).toBe(0o600);
    expect(await fileMode(paths.marker)).toBe(0o600);
  });

  it("is idempotent and preserves a persisted RLY-only model when native input is unchanged", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    const nativeDigest = await digest(join(native, "settings.json"));

    const first = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    expect(first.composed).toBe(true);

    // Claude persists an RLY-only projection model into the overlay (/model Enter).
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark" }), "utf8");

    const second = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    // Native unchanged → no recompose → RLY model survives.
    expect(second.composed).toBe(false);
    expect(second.refreshed).toEqual([]);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(await digest(join(native, "settings.json"))).toBe(nativeDigest);
  });

  it("picks up native changes on re-compose while keeping RLY-only model state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}fast-0`, theme: "dark" }), "utf8");

    // User edits native settings (newer mtime) and adds a new preference.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-haiku-4-5", theme: "light", extra: true }), "utf8");

    const refreshed = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(refreshed.composed).toBe(true);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["theme"]).toBe("light");
    expect(overlay["extra"]).toBe(true);
    // RLY-owned projection model wins over native model input on re-compose.
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}fast-0`);
    expect(JSON.parse(await readFile(nativeSettings, "utf8"))).toMatchObject({ theme: "light", extra: true });
  });

  it("keeps a native (non-RLY) model as user input after re-compose", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: "claude-opus-4-8" }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", extra: true }), "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    // A real model persisted in the overlay is not RLY-owned; native input wins.
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(overlay["extra"]).toBe(true);
  });

  it("converges under concurrent prepares without corrupting state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const before = await digest(join(native, "settings.json"));

    const results = await Promise.all([
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
    ]);

    expect(new Set(results.map((result) => result.directory)).size).toBe(1);
    const paths = claudeOverlayPaths(controlPlane);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(await readFile(join(paths.agents, "reviewer.md"), "utf8")).toBe("# reviewer\n");
    expect(JSON.parse(await readFile(paths.marker, "utf8"))).toMatchObject({ allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION });
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("creates an empty durable overlay when no native config exists and never touches home files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    await writeFile(join(home, ".claude.json"), "sentinel\n", "utf8");

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    // No native surfaces to compose, but the durable namespace + marker exist.
    expect(resolution.composed).toBe(false);
    expect(resolution.refreshed).toEqual([]);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("sentinel\n");
    expect(await readClaudeOverlayStatus(controlPlane)).toMatchObject({
      directory: join(controlPlane, "claude"),
      source: join(home, ".claude"),
      allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
    });
  });

  it("skips malformed native settings without failing the launch or touching native files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), "{ not valid json", "utf8");
    const before = await digest(join(native, "settings.json"));
    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(resolution.composed).toBe(false);
    // Malformed native settings are not composed into the overlay.
    await expect(stat(claudeOverlayPaths(controlPlane).settings)).rejects.toThrow();
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("never composes an overlay from itself", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const nested = await prepareClaudeOverlay(controlPlane, {
      environment: { HOME: home, CLAUDE_CONFIG_DIR: resolution.directory, PATH: "/bin" },
    });
    expect(nested.composed).toBe(false);
    expect(nested.directory).toBe(resolution.directory);
  });

  it("reports a secret-free overlay status and no status without a marker", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    expect(await readClaudeOverlayStatus(controlPlane)).toBeUndefined();
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const status = await readClaudeOverlayStatus(controlPlane);
    expect(status).toBeDefined();
    expect(status?.source).toBe(join(home, ".claude"));
    expect(status?.allowlistVersion).toBe(CLAUDE_OVERLAY_ALLOWLIST_VERSION);
    expect(status?.directory).toBe(join(controlPlane, "claude"));
  });

  it("launches Claude with the durable overlay and leaves native config byte-identical after /model activity", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "sentinel\n", "utf8");
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const protectedFiles = [join(native, "settings.json"), join(native, "agents", "reviewer.md"), join(home, ".claude.json")];
    const before = await Promise.all(protectedFiles.map(digest));

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const child = new TestChild();
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const spawner: ChildSpawner = (_executable, _args, options) => {
      childEnvironment = options.env;
      return child;
    };
    const launched = launchClaude({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient-token",
      args: ["-p", "fixture"],
      environment: nativeEnvironment(home),
      configDirectory: resolution.directory,
      spawner,
      signalSource: new TestSignals(),
    });
    expect(childEnvironment?.["CLAUDE_CONFIG_DIR"]).toBe(resolution.directory);
    expect(childEnvironment?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:17871");
    expect(childEnvironment?.["ANTHROPIC_AUTH_TOKEN"]).toBe("transient-token");
    expect(childEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY");

    // Simulate Claude persisting an RLY-only /model selection into the overlay.
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark" }), "utf8");
    child.close(0, null);
    await expect(launched).resolves.toEqual({ code: 0, signal: null });

    // A subsequent RLY launch keeps the RLY model; native files stay byte-identical.
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
    // The overlay never carries gateway env or auth material that a plain launch could inherit.
    expect(JSON.stringify(overlay)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|transient-token/);
  });

  it("exposes pure composition helpers", () => {
    expect(composeOverlaySettings(undefined)).toEqual({});
    expect(composeOverlaySettings({ model: "claude-sonnet-4-5", env: { ANTHROPIC_BASE_URL: "x", KEEP: "y" } }))
      .toEqual({ model: "claude-sonnet-4-5", env: { KEEP: "y" } });
    expect(composeOverlaySettings({ model: "a" }, { model: `${RLY_MODEL_PREFIX}x` })).toEqual({ model: `${RLY_MODEL_PREFIX}x` });
    expect(rlyOwnedModel({ model: `${RLY_MODEL_PREFIX}x` })).toBe(`${RLY_MODEL_PREFIX}x`);
    expect(rlyOwnedModel({ model: "claude-sonnet-4-5" })).toBeUndefined();
    expect(composeOverlayPluginConfig({ enabledPlugins: ["a"], oauthAccounts: { x: { token: "t" } } }))
      .toEqual({ enabledPlugins: ["a"] });
    expect(composeOverlayPluginConfig({ oauthAccounts: { x: { token: "t" } } })).toBeUndefined();
    expect(nativeClaudeConfigDirectory({ HOME: "/tmp/u", CLAUDE_CONFIG_DIR: "/custom" })).toBe("/custom");
    expect(nativeClaudeConfigDirectory({ HOME: "/tmp/u" })).toBe("/tmp/u/.claude");
  });
});

class TestChild implements ChildProcessLike {
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  public once(event: "close" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): unknown {
    if (event === "close") this.closeListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    return this;
  }

  public kill(): boolean {
    return true;
  }

  public close(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeListener?.(code, signal);
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
}
