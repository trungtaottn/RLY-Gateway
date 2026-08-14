import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../../src/control-plane/store.js";
import { CredentialStore } from "../../../src/credentials/store.js";
import { defaultControlPlaneDirectory } from "../../../src/storage/paths.js";
import { detectClaudeTarget } from "../../../src/targets/detect.js";
import { CLINE_PROFILE_ROLES } from "../../helpers/cline-profile-seed.js";

const enabled = process.env["RLY_LIVE_CLINEPASS"] === "1";
const handle = process.env["RLY_LIVE_CLINE_HANDLE"];
const endpoint = process.env["RLY_LIVE_CLINE_ENDPOINT"];
const claude = detectClaudeTarget(process.env);
const timeoutMs = 60_000;
const directories: string[] = [];
const processes: RunningProcess[] = [];

afterEach(async () => {
  const active = processes.splice(0);
  for (const process of active) process.stop();
  await Promise.all(active.map((process) => process.completion.catch(() => undefined)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type RunningProcess = Readonly<{ completion: Promise<{ code: number | null; output: string }>; stop: () => void }>;

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): RunningProcess {
  const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const processId = child.pid;
  if (processId === undefined) throw new Error("live smoke child did not receive a process ID");
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

describe.skipIf(!enabled || !handle || !endpoint || !claude.found)("Claude Code live ClinePass smoke", () => {
  it("issues one Claude Code request through a clinepass profile without mutating global config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-claude-live-"));
    directories.push(directory);
    const sourceDirectory = process.env["RLY_LIVE_CLINE_CONTROL_PLANE"] ?? defaultControlPlaneDirectory();
    const source = await CredentialStore.open(sourceDirectory);
    const record = await source.read(handle ?? "");
    expect(record.provider).toBe("cline");
    const controlPlane = join(directory, "control-plane");
    const dest = await CredentialStore.open(controlPlane);
    await dest.commit(record.handle, 0, { ...record, generation: 1 });
    const store = await ControlPlaneStore.open(controlPlane);
    try {
      const provider = store.createProvider({
        name: "cline",
        integrationMode: "oauth",
        endpointPolicy: endpoint,
      }, "cli");
      const account = store.createAccount({
        pseudonym: "acct-live",
        providerId: provider.id,
        credentialHandle: record.handle,
      }, "cli");
      const ready = store.bindCredential(account.id, account.version, {
        credentialHandle: record.handle,
        credentialGeneration: 1,
        state: "ready",
      }, "cli");
      const pool = store.createPool({
        name: "live-pool",
        providerId: provider.id,
        strategy: "fill-first",
        retryBudget: 0,
        accountIds: [ready.id],
      }, "cli");
      store.createProfile({
        name: "clinepass",
        harness: "claude",
        providerId: provider.id,
        poolId: pool.id,
        modelRoles: CLINE_PROFILE_ROLES,
      }, "cli");
    } finally {
      store.close();
    }
    const config = join(directory, "gateway.toml");
    await writeFile(config, [
      "schemaVersion = 1",
      "[gateway]",
      "port = 17895",
      "managementPort = 17896",
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    const homeFile = join(directory, ".claude.json");
    const codexDirectory = join(directory, ".codex");
    await mkdir(codexDirectory);
    const codexFile = join(codexDirectory, "config.toml");
    await writeFile(homeFile, "sentinel-claude\n", "utf8");
    await writeFile(codexFile, "sentinel-codex\n", "utf8");
    const beforeClaude = await digest(homeFile);
    const beforeCodex = await digest(codexFile);
    const result = await run(process.execPath, [
      "dist/cli/main.js", "clinepass", "--config", config, "--",
      "-p", "Reply with one word.", "--dangerously-skip-permissions",
    ], { ...process.env, HOME: directory }).completion;
    expect(result.code).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output).not.toMatch(/accessToken|refreshToken|authorization|sk-|Bearer /i);
    expect(await digest(homeFile)).toBe(beforeClaude);
    expect(await digest(codexFile)).toBe(beforeCodex);
  }, timeoutMs);
});
