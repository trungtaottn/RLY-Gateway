import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { launchCodex } from "../../src/runtime/child-launcher.js";

const directories: string[] = [];

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("global client config isolation", () => {
  it("leaves Claude and Codex configuration byte-identical", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-gateway-home-"));
    directories.push(home);
    const claudeDirectory = join(home, ".claude");
    const codexDirectory = join(home, ".codex");
    await mkdir(claudeDirectory);
    await mkdir(codexDirectory);
    const protectedFiles = [
      join(home, ".claude.json"),
      join(claudeDirectory, "settings.json"),
      join(codexDirectory, "config.toml"),
    ];
    await Promise.all(protectedFiles.map((path, index) => writeFile(path, `sentinel-${String(index)}\n`, "utf8")));
    const before = await Promise.all(protectedFiles.map(digest));
    const configPath = join(home, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await runCli(
      ["run", "claude", "--config", configPath, "--"],
      {
        environment: { HOME: home, PATH: "/bin" },
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "transient",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude: vi.fn().mockResolvedValue({ code: 0, signal: null }),
      },
    );
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
    expect(release).toHaveBeenCalledOnce();
    await runCli(
      ["run", "codex", "--config", configPath, "--"],
      {
        environment: { HOME: home, PATH: "/bin" },
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "transient",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchCodex: vi.fn().mockResolvedValue({ code: 0, signal: null }),
      },
    );
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
    await launchCodex({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      environment: { HOME: home, PATH: "/bin" },
    });
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
  });
});
