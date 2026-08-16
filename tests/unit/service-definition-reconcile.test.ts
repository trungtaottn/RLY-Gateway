import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDefinition, isLegacyDefinition, reconcileDefinition, renderExpectedDefinition } from "../../src/service-manager/reconcile.js";
import type { ServiceDefinitionInput, ServiceManagerAdapter, ServiceStatus } from "../../src/service-manager/types.js";
import { createHash } from "node:crypto";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-reconcile-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeAdapter implements ServiceManagerAdapter {
  platform = "linux" as const;
  serviceName = "rly-gateway";
  definitionPath: string;
  registers = 0;
  #content: string | undefined;

  constructor(definitionPath: string, content?: string) {
    this.definitionPath = definitionPath;
    this.#content = content;
  }

  isSupported(): boolean { return true; }
  async isRegistered(): Promise<boolean> { return this.#content !== undefined; }
  async register(input: ServiceDefinitionInput): Promise<void> {
    this.registers += 1;
    this.#content = this.renderDefinition(input);
    await writeFile(this.definitionPath, this.#content, { mode: 0o600 });
  }
  renderDefinition(input: ServiceDefinitionInput): string {
    return `[Unit]\nExecStart=${input.executable} ${input.entrypoint ?? ""}gateway start --config ${input.configPath}\n`;
  }
  unregister(): Promise<void> { return Promise.resolve(); }
  start(): Promise<void> { return Promise.resolve(); }
  restart(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  status(): Promise<ServiceStatus> { return Promise.resolve("running"); }
}

const expected: ServiceDefinitionInput = {
  serviceName: "rly-gateway",
  executable: "/home/alice/.rly/bootstrap/rly-gateway",
  configPath: "/home/alice/work/gateway.config.toml",
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("service-definition reconciliation (#94)", () => {
  it("renders the RLY-owned expected definition content", () => {
    const adapter = new FakeAdapter(join("/tmp", "rly-gateway.service"));
    const content = renderExpectedDefinition(adapter, expected);
    expect(content).toContain("/home/alice/.rly/bootstrap/rly-gateway");
    expect(content).toContain("gateway start --config /home/alice/work/gateway.config.toml");
    expect(content).not.toMatch(/dist[/\\]cli[/\\]init\.js/);
  });

  it("detects a missing definition and repairs it idempotently", async () => {
    const dir = await directory();
    const unitPath = join(dir, "rly-gateway.service");
    const adapter = new FakeAdapter(unitPath);
    const before = await detectDefinition(adapter, expected);
    expect(before.status).toBe("missing");
    expect(before.changed).toBe(true);

    const repaired = await reconcileDefinition(adapter, expected);
    expect(repaired.status).toBe("repaired");
    expect(adapter.registers).toBe(1);
    expect(repaired.revision).toBe(hash(renderExpectedDefinition(adapter, expected)!));
    expect(await readFile(unitPath, "utf8")).toBe(renderExpectedDefinition(adapter, expected));

    // Idempotent: an already-correct definition is a no-op (no duplicate).
    const again = await reconcileDefinition(adapter, expected);
    expect(again.status).toBe("ok");
    expect(adapter.registers).toBe(1);
  });

  it("detects a stale/path-drifted definition and repairs it", async () => {
    const dir = await directory();
    const unitPath = join(dir, "rly-gateway.service");
    await writeFile(unitPath, "[Unit]\nExecStart=/usr/bin/node /opt/rly/dist/cli/init.js gateway start --config /old/path/gateway.config.toml\n", "utf8");
    const adapter = new FakeAdapter(unitPath, await readFile(unitPath, "utf8"));
    const before = await detectDefinition(adapter, expected);
    expect(before.status).toBe("stale");
    expect(before.migrated).toBe(true);

    const repaired = await reconcileDefinition(adapter, expected);
    expect(repaired.status).toBe("repaired");
    expect(repaired.migrated).toBe(true);
    expect(adapter.registers).toBe(1);
    expect(await readFile(unitPath, "utf8")).toBe(renderExpectedDefinition(adapter, expected)!);
  });

  it("migrates a legacy direct-refs definition (runtime/refs/active path) to the bootstrap", async () => {
    const dir = await directory();
    const unitPath = join(dir, "rly-gateway.service");
    const legacy = "[Unit]\nExecStart=/usr/bin/node /home/alice/.rly/runtime/refs/active/dist/cli/main.js gateway start --config /home/alice/work/gateway.config.toml\n";
    await writeFile(unitPath, legacy, "utf8");
    const adapter = new FakeAdapter(unitPath, legacy);
    expect(await detectDefinition(adapter, expected)).toMatchObject({ status: "stale", migrated: true });
    const repaired = await reconcileDefinition(adapter, expected);
    expect(repaired.status).toBe("repaired");
    expect(repaired.migrated).toBe(true);
    const content = await readFile(unitPath, "utf8");
    // The repaired definition NEVER references the refs path or a node binary.
    expect(content).not.toMatch(/runtime[/\\]refs[/\\]/);
    expect(content).not.toMatch(/node/);
    expect(content).toContain("/home/alice/.rly/bootstrap/rly-gateway");
  });

  it("classifies legacy definitions: node binary, init.js entrypoint, direct refs path", () => {
    expect(isLegacyDefinition("/usr/bin/node /opt/rly/dist/cli/init.js gateway start --config /w/g.toml")).toBe(true);
    expect(isLegacyDefinition("/usr/local/bin/node /opt/rly/dist/cli/main.js gateway start")).toBe(true);
    expect(isLegacyDefinition("ExecStart=/home/u/.rly/runtime/refs/active/dist/cli/main.js gateway start")).toBe(true);
    // The stable bootstrap definition is not legacy.
    expect(isLegacyDefinition("/home/u/.rly/bootstrap/rly-gateway gateway start --config /w/g.toml")).toBe(false);
  });

  it("reports a repair failure without partial state", async () => {
    const dir = await directory();
    const unitPath = join(dir, "rly-gateway.service");
    const adapter = new FakeAdapter(unitPath);
    adapter.register = () => Promise.reject(new Error("no user manager"));
    const repaired = await reconcileDefinition(adapter, expected);
    expect(repaired.status).toBe("failed");
    expect(repaired.message).toContain("no user manager");
    expect(repaired.changed).toBe(true);
  });

  it("definitions never contain credentials, tokens, or account identity", () => {
    const content = renderExpectedDefinition(new FakeAdapter(join("/tmp", "x.service")), expected)!;
    expect(content).not.toMatch(/Bearer/i);
    expect(content).not.toMatch(/api[_-]?key/i);
    expect(content).not.toMatch(/token/i);
    expect(content).not.toMatch(/@/);
    expect(content).not.toMatch(/secret/i);
  });

  it("reports unsupported platforms without falsely claiming success", async () => {
    const adapter: ServiceManagerAdapter = {
      platform: "unsupported",
      serviceName: "rly-gateway",
      isSupported: () => false,
      isRegistered: () => Promise.resolve(false),
      register: () => Promise.resolve(undefined),
      unregister: () => Promise.resolve(undefined),
      start: () => Promise.resolve(undefined),
      restart: () => Promise.resolve(undefined),
      stop: () => Promise.resolve(undefined),
      status: () => Promise.resolve("not-registered"),
    };
    const detected = await detectDefinition(adapter, expected);
    expect(detected.status).toBe("unsupported");
    const repaired = await reconcileDefinition(adapter, expected);
    expect(repaired.status).toBe("unsupported");
  });
});
