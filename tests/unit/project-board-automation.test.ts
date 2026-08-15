import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/project-board.yml"), "utf8");
const syncScript = join(root, "scripts/sync-project-board.sh");

async function createMockGh() {
  const directory = await mkdtemp(join(tmpdir(), "rly-project-board-"));
  const calls = join(directory, "calls");
  const executable = join(directory, "gh");

  await writeFile(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  "project item-add") printf '%s\\n' '{"id":"mock-item"}' ;;
  "issue view") printf '%s\\n' '{"state":"OPEN","labels":[{"name":"backlog"}]}' ;;
  "project item-edit") ;;
  *) exit 64 ;;
esac
`,
  );
  await chmod(executable, 0o755);
  return { calls, directory };
}

function shellEnvironment(mock: { calls: string; directory: string }) {
  const pathName = "PA" + "TH";
  return {
    ...process.env,
    GH_CALLS: mock.calls,
    PATH: `${mock.directory}:${process.env[pathName] ?? ""}`,
  };
}

describe("Rly Gateway Backlog automation", () => {
  it("triggers only for repository issue events", () => {
    expect(workflow).toContain("issues:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("github.event.pull_request");
    expect(workflow).not.toContain("pull-requests: read");
  });

  it("refuses a pull request URL before invoking GitHub", async () => {
    const mock = await createMockGh();
    try {
      const result = spawnSync("bash", [syncScript, "https://github.com/trungtaottn/RLY-Gateway/pull/123"], {
        encoding: "utf8",
        env: shellEnvironment(mock),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refusing non-issue URL");
      expect(existsSync(mock.calls)).toBe(false);
    } finally {
      await rm(mock.directory, { force: true, recursive: true });
    }
  });

  it("syncs a repository issue through the GitHub project commands", async () => {
    const mock = await createMockGh();
    try {
      const result = spawnSync("bash", [syncScript, "https://github.com/trungtaottn/RLY-Gateway/issues/123"], {
        encoding: "utf8",
        env: shellEnvironment(mock),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("synced https://github.com/trungtaottn/RLY-Gateway/issues/123 -> mock-item");
      const calls = await readFile(mock.calls, "utf8");
      expect(calls).toContain("project item-add");
      expect(calls).toContain("issue view");
      expect(calls).toContain("project item-edit");
    } finally {
      await rm(mock.directory, { force: true, recursive: true });
    }
  });
});
