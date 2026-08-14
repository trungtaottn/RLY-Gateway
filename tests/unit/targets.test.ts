import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectClaudeTarget, detectCodexTarget } from "../../src/targets/detect.js";
import { parseVersionToken, probeClientVersion } from "../../src/targets/versions.js";
import { detectInstalledClients } from "../../src/canary/installed.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-target-"));
  directories.push(directory);
  return directory;
}

async function executableScript(directory: string, name: string, body: string): Promise<string> {
  const executable = join(directory, name);
  await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

describe("claude target detection", () => {
  it("finds an executable on PATH and reports a missing binary without throwing", async () => {
    const directory = await temporaryDirectory();
    const executable = join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    expect(detectClaudeTarget({ PATH: directory })).toEqual({ found: true, executable });
    expect(detectClaudeTarget({ PATH: directory }, { executable: "missing" }).found).toBe(false);
    expect(detectClaudeTarget({ PATH: "/no-such-path" }).found).toBe(false);
  });

  it("finds a Codex executable on PATH without throwing when missing", async () => {
    const directory = await temporaryDirectory();
    const executable = join(directory, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    expect(detectCodexTarget({ PATH: directory })).toEqual({ found: true, executable });
    expect(detectCodexTarget({ PATH: "/no-such-path" }).found).toBe(false);
  });
});

describe("exact client version probing (#24)", () => {
  it("parses the exact semantic/version token from --version output", () => {
    expect(parseVersionToken("2.1.229\n")).toBe("2.1.229");
    expect(parseVersionToken("Claude Code 2.1.231")).toBe("2.1.231");
    expect(parseVersionToken("0.147.0-alpha.6.5")).toBe("0.147.0-alpha.6.5");
    expect(parseVersionToken("no version here")).toBeUndefined();
  });

  it("reads the exact version from the installed binary", async () => {
    const directory = await temporaryDirectory();
    const executable = await executableScript(directory, "claude", "echo 2.1.229");
    const probe = await probeClientVersion(executable);
    expect(probe.version).toBe("2.1.229");
    expect(probe.source).toBe("cli-output");
  });

  it("reports unknown (never inferred) when the binary is silent, broken, or missing", async () => {
    const directory = await temporaryDirectory();
    const silent = await executableScript(directory, "silent", "exit 0");
    expect((await probeClientVersion(silent)).source).toBe("unknown");
    const broken = await executableScript(directory, "broken", "exit 7");
    expect((await probeClientVersion(broken)).source).toBe("unknown");
    const missing = join(directory, "does-not-exist");
    const probe = await probeClientVersion(missing);
    expect(probe.source).toBe("unknown");
    expect(probe.error).toBeDefined();
  });

  it("combines found + exact version into the installed-client record", async () => {
    const directory = await temporaryDirectory();
    await executableScript(directory, "claude", "echo 2.1.231");
    const installed = await detectInstalledClients({ PATH: directory });
    expect(installed.claude.found).toBe(true);
    expect(installed.claude.version).toBe("2.1.231");
    expect(installed.claude.versionSource).toBe("cli-output");
    expect(installed.codex.found).toBe(false);
    expect(installed.codex.versionSource).toBe("unknown");
    expect(installed.codex.version).toBeUndefined();
  });

  it("never infers a version from timestamps or paths (unknown only)", async () => {
    const directory = await temporaryDirectory();
    const executable = await executableScript(directory, "claude", "echo hello");
    const probe = await probeClientVersion(executable);
    expect(probe.version).toBeUndefined();
    expect(probe.source).toBe("unknown");
  });
});
