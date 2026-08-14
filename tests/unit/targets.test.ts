import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectClaudeTarget } from "../../src/targets/detect.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("claude target detection", () => {
  it("finds an executable on PATH and reports a missing binary without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-target-"));
    directories.push(directory);
    const executable = join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    expect(detectClaudeTarget({ PATH: directory })).toEqual({ found: true, executable });
    expect(detectClaudeTarget({ PATH: directory }, { executable: "missing" }).found).toBe(false);
    expect(detectClaudeTarget({ PATH: "/no-such-path" }).found).toBe(false);
  });
});
