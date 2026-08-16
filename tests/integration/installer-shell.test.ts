import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseFixture, type ReleaseFixture } from "../helpers/installer-fixture.js";

const directories: string[] = [];
const servers: Array<{ server: Server; port: number }> = [];

async function directory(prefix = "rly-install-shell-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const { server } of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Local HTTP server serving a release fixture as a GitHub-like origin:
 * `GET /releases/download/v<version>/<asset>` (public assets) and
 * `GET /repos/<owner>/<repo>/releases` (discovery listing).
 */
async function serveFixtureRequest(
  fixture: ReleaseFixture,
  options: Readonly<{ tamperTarball?: boolean }>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = request.url ?? "/";
  const path = decodeURIComponent(new URL(url, "http://localhost").pathname);
  if (path.endsWith("/releases")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ tag_name: `v${fixture.version}`, draft: false }]));
    return;
  }
  const marker = `/releases/download/v${fixture.version}/`;
  const index = path.indexOf(marker);
  if (index < 0) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const asset = path.slice(index + marker.length);
  const safe = asset.replace(/[/\\]/g, "_");
  try {
    let bytes = await readFile(join(fixture.releaseDir, safe));
    if (asset === fixture.filename && options.tamperTarball === true) {
      bytes = Buffer.concat([Buffer.from([bytes[0] === 0 ? 1 : 0]), bytes.subarray(1)]);
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}

async function serveFixture(fixture: ReleaseFixture, options: Readonly<{ tamperTarball?: boolean }> = {}): Promise<{ origin: string; port: number }> {
  const server = createServer((request, response) => {
    void serveFixtureRequest(fixture, options, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  servers.push({ server, port });
  return { origin: `http://127.0.0.1:${String(port)}`, port };
}

async function runInstaller(script: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const absoluteScript = join(process.cwd(), script);
  try {
    const { stdout } = await promisify(execFile)("sh", [absoluteScript, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const cause = error as { status?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: cause.status ?? (cause.killed === true ? 124 : 1),
      stdout: cause.stdout ?? "",
      stderr: cause.stderr ?? "",
    };
  }
}

const FAKE_RLY = "#!/bin/sh\necho \"fake-rly-install:$*\"\nexit 0\n";

describe("bootstrap installer scripts/install.sh (#129)", () => {
  it("downloads, verifies, unpacks and hands the exact artifact to rly install", async () => {
    const releaseDir = await directory("rly-fixture-");
    const work = await directory("rly-work-");
    const fixture = await buildReleaseFixture({
      releaseDir,
      version: "1.0.0-beta.5",
      channel: "beta",
      launcherContent: FAKE_RLY,
    });
    const { origin } = await serveFixture(fixture);
    const keyFile = join(work, "fixture-pub.pem");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(keyFile, fixture.publicKeyPem, { mode: 0o600 });
    const result = await runInstaller("scripts/install.sh", ["--channel", "beta", "--origin", origin, "--target", "linux-x64"], work, {
      ...process.env,
      RLY_VERBOSE: "1",
      RLY_RELEASE_PUBLIC_KEY_FILE: keyFile,
    });
    if (result.code !== 0) console.log("SHELL-STDERR", result.stderr, "SHELL-STDOUT", result.stdout);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("artifact verified");
    expect(result.stdout).toContain(fixture.sha256);
    expect(result.stdout).toContain("fake-rly-install");
    expect(result.stdout).toContain("--artifact");
    expect(result.stdout).toContain("--metadata-dir");
  });

  it("fails closed on a tampered artifact before executing it", async () => {
    const releaseDir = await directory("rly-fixture-");
    const work = await directory("rly-work-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", launcherContent: FAKE_RLY });
    const { origin } = await serveFixture(fixture, { tamperTarball: true });
    const result = await runInstaller("scripts/install.sh", ["--channel", "beta", "--origin", origin, "--target", "linux-x64"], work, { ...process.env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("digest mismatch");
    expect(result.stdout).not.toContain("fake-rly-install");
  });

  it("fails closed on an unsupported target with an actionable message", async () => {
    const releaseDir = await directory("rly-fixture-");
    const work = await directory("rly-work-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", launcherContent: FAKE_RLY });
    const { origin } = await serveFixture(fixture);
    const result = await runInstaller("scripts/install.sh", ["--channel", "beta", "--origin", origin, "--target", "win32-x64"], work, { ...process.env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unsupported target");
  });

  it("fails closed on an invalid channel", async () => {
    const releaseDir = await directory("rly-fixture-");
    const work = await directory("rly-work-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", launcherContent: FAKE_RLY });
    const { origin } = await serveFixture(fixture);
    const result = await runInstaller("scripts/install.sh", ["--channel", "prod", "--origin", origin, "--target", "linux-x64"], work, { ...process.env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("channel must be beta or stable");
  });

  it("fails closed when the artifact signature does not verify against the trust anchor", async () => {
    const releaseDir = await directory("rly-fixture-");
    const work = await directory("rly-work-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", launcherContent: FAKE_RLY });
    const { origin } = await serveFixture(fixture);
    // Point the trust anchor at a DIFFERENT public key (e.g. a wrong/mirror
    // key): the artifact signature must fail closed before execution.
    const { writeFile } = await import("node:fs/promises");
    const wrongKey = await directory("rly-wrongkey-");
    const { generateSigningKeyPair } = await import("../../scripts/release/signing.mjs");
    await writeFile(join(wrongKey, "wrong.pem"), generateSigningKeyPair().publicKey, { mode: 0o600 });
    const result = await runInstaller("scripts/install.sh", ["--channel", "beta", "--origin", origin, "--target", "linux-x64"], work, {
      ...process.env,
      RLY_RELEASE_PUBLIC_KEY_FILE: join(wrongKey, "wrong.pem"),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does NOT verify");
    expect(result.stdout).not.toContain("fake-rly-install");
  });
});
