import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import {
  LEGACY_STATE_DIRECTORY_NAME,
  RLY_STATE_DIRECTORY_NAME,
  StateRootMigrationError,
  resolveDefaultControlPlaneDirectory,
} from "../../src/storage/paths.js";

const homes: string[] = [];

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-state-root-"));
  homes.push(directory);
  return directory;
}

async function writeLegacyTree(root: string): Promise<void> {
  await mkdir(join(root, "credentials", "locks"), { recursive: true });
  await mkdir(join(root, "backups"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await mkdir(join(root, "responses"), { recursive: true });
  await writeFile(join(root, "control-plane.sqlite"), "database", "utf8");
  await writeFile(join(root, "control-plane.sqlite-wal"), "wal", "utf8");
  await writeFile(join(root, "credentials", "acct.json"), "credential", "utf8");
  await writeFile(join(root, "backups", "prior.sqlite"), "backup", "utf8");
  await writeFile(join(root, "logs", "event.log"), "log", "utf8");
  await writeFile(join(root, "responses", "continuation.json"), "continuation", "utf8");
  await writeFile(join(root, "unknown-state-file"), "preserve-me", "utf8");
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("default RLY state-root migration", () => {
  it("moves the complete legacy tree once and makes .rly authoritative", async () => {
    const root = await home();
    const legacy = join(root, LEGACY_STATE_DIRECTORY_NAME);
    await writeLegacyTree(legacy);

    const resolution = await resolveDefaultControlPlaneDirectory(root);
    expect(resolution.directory).toBe(join(root, RLY_STATE_DIRECTORY_NAME));
    await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(resolution.directory, "credentials", "acct.json"), "utf8")).resolves.toBe("credential");
    await expect(readFile(join(resolution.directory, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
    await resolution.commit();
  });

  it("fails closed and leaves both roots unchanged", async () => {
    const root = await home();
    const legacy = join(root, LEGACY_STATE_DIRECTORY_NAME);
    const canonical = join(root, RLY_STATE_DIRECTORY_NAME);
    await writeLegacyTree(legacy);
    await writeLegacyTree(canonical);

    await expect(resolveDefaultControlPlaneDirectory(root)).rejects.toBeInstanceOf(StateRootMigrationError);
    await expect(readFile(join(legacy, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
    await expect(readFile(join(canonical, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
  });

  it("uses an existing .rly root without touching it", async () => {
    const root = await home();
    const canonical = join(root, RLY_STATE_DIRECTORY_NAME);
    await writeLegacyTree(canonical);

    const resolution = await resolveDefaultControlPlaneDirectory(root);
    await resolution.commit();
    await expect(readFile(join(canonical, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
  });

  it("initializes a clean install only beneath .rly", async () => {
    const root = await home();
    const resolution = await resolveDefaultControlPlaneDirectory(root);
    const store = await ControlPlaneStore.open(resolution.directory);
    store.close();
    await resolution.commit();
    await expect(lstat(join(root, LEGACY_STATE_DIRECTORY_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, RLY_STATE_DIRECTORY_NAME))).resolves.toBeDefined();
  });

  it("restores legacy state if the first authoritative open cannot continue", async () => {
    const root = await home();
    const legacy = join(root, LEGACY_STATE_DIRECTORY_NAME);
    await writeLegacyTree(legacy);

    const resolution = await resolveDefaultControlPlaneDirectory(root);
    await resolution.rollback();
    await expect(readFile(join(legacy, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
    await expect(lstat(join(root, RLY_STATE_DIRECTORY_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent starters without losing the legacy tree", async () => {
    const root = await home();
    await writeLegacyTree(join(root, LEGACY_STATE_DIRECTORY_NAME));

    const first = await resolveDefaultControlPlaneDirectory(root);
    const secondPending = resolveDefaultControlPlaneDirectory(root);
    await first.commit();
    const second = await secondPending;
    await second.commit();
    await expect(readFile(join(root, RLY_STATE_DIRECTORY_NAME, "unknown-state-file"), "utf8")).resolves.toBe("preserve-me");
    await expect(lstat(join(root, LEGACY_STATE_DIRECTORY_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked legacy root without creating .rly", async () => {
    const root = await home();
    const target = join(root, "outside-state");
    await writeLegacyTree(target);
    await symlink(target, join(root, LEGACY_STATE_DIRECTORY_NAME));

    await expect(resolveDefaultControlPlaneDirectory(root)).rejects.toBeInstanceOf(StateRootMigrationError);
    await expect(lstat(join(root, RLY_STATE_DIRECTORY_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
