import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RLY_MODEL_PREFIX } from "../routing/model-projection/types.js";

export { RLY_MODEL_PREFIX } from "../routing/model-projection/types.js";

/**
 * RLY Claude configuration overlay (#74).
 *
 * Claude Code's `CLAUDE_CONFIG_DIR` owns settings, agents, skills, commands,
 * plugins, and session/history state for the supported client baseline (pinned
 * through #24; the currently observed target is `2.1.229`). The historical
 * launcher pointed that variable at a fresh throwaway temp directory so RLY
 * never touched the user's real `~/.claude` — but it also threw away the
 * user's settings/agents/plugins and every RLY session/history on exit.
 *
 * This module replaces the throwaway directory with a durable RLY-owned
 * overlay under the durable RLY home (`<control-plane>/claude`, `~/.rly/claude`
 * by default). The native Claude config root is treated as read/compose-only
 * INPUT; RLY gateway/model state is written only inside the overlay; a later
 * plain `claude` launch is never affected.
 *
 * Composition is a typed allowlist, never an unrestricted recursive copy:
 *
 * | Surface | Handling |
 * | --- | --- |
 * | `settings.json` | one-way merge; `env` keys conflicting with the RLY gateway contract are stripped; `model` stays user input |
 * | `agents/*.md`, `commands/*.md` | one-way refresh copy |
 * | `skills/**` | allowlisted recursive copy (user-authored) |
 * | `plugins/config.json` | allowlisted keys only (`enabledPlugins`, `marketplaces`); credential-bearing keys (`oauthAccounts`, token-like) are dropped |
 * | everything else (`plugins/cache|repos`, `history`, `projects`, `shell-snapshots`, `todos`, `statsig`, `version`) | never copied |
 *
 * The home-level `~/.claude.json` file is never read, written, or deleted by
 * RLY. Project-local `.claude` configuration is discovered by Claude from the
 * working directory and is not part of this overlay.
 *
 * Refresh policy: an allowlisted file is copied only when the native file is
 * present and newer than the overlay copy (or the copy is missing). Native
 * deletions are not propagated — RLY state is additive and survives. All RLY
 * writes are atomic (temp file + rename) at `0600`; directories are `0700`.
 * Because composition is deterministic from native input, concurrent RLY
 * launches converge without locks; when native input is unchanged the overlay
 * is not rewritten, so a sibling session's `/model` write (Claude's own
 * shared-config write into the overlay) is preserved.
 */

export const CLAUDE_OVERLAY_DIRECTORY_NAME = "claude";
export const CLAUDE_OVERLAY_MARKER_NAME = ".rly-overlay.json";
/**
 * Allowlist composition version. Bumped when the typed allowlist contract
 * changes (e.g. a new gateway-contract env key): an older overlay marker is
 * re-composed on the next launch while RLY-owned state (a persisted
 * `claude-rly-*` model) still wins.
 */
export const CLAUDE_OVERLAY_ALLOWLIST_VERSION = 2;

/** Env keys RLY owns for the child-only gateway contract and must never inherit from native settings. */
export const GATEWAY_CONTRACT_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
] as const;

const SETTINGS_FILE = "settings.json";
const AGENTS_DIRECTORY = "agents";
const COMMANDS_DIRECTORY = "commands";
const SKILLS_DIRECTORY = "skills";
const PLUGIN_CONFIG_RELATIVE = join("plugins", "config.json");
/** Keys carried from the native plugin config; everything else (including OAuth accounts) stays native. */
const PLUGIN_CONFIG_ALLOWED_KEYS = new Set(["enabledPlugins", "marketplaces"]);
/** Dependency/version-control directories are never copied as part of the skills allowlist. */
const SKILLS_EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

export type ClaudeOverlayPaths = Readonly<{
  directory: string;
  settings: string;
  agents: string;
  commands: string;
  skills: string;
  pluginConfig: string;
  marker: string;
}>;

export function claudeOverlayPaths(controlPlaneDirectory: string): ClaudeOverlayPaths {
  const directory = join(controlPlaneDirectory, CLAUDE_OVERLAY_DIRECTORY_NAME);
  return {
    directory,
    settings: join(directory, SETTINGS_FILE),
    agents: join(directory, AGENTS_DIRECTORY),
    commands: join(directory, COMMANDS_DIRECTORY),
    skills: join(directory, SKILLS_DIRECTORY),
    pluginConfig: join(directory, PLUGIN_CONFIG_RELATIVE),
    marker: join(directory, CLAUDE_OVERLAY_MARKER_NAME),
  };
}

/** Resolves the native (user-owned) Claude config root to compose from. */
export function nativeClaudeConfigDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const configured = environment["CLAUDE_CONFIG_DIR"];
  if (configured !== undefined && configured !== "") return configured;
  return join(environment["HOME"] ?? homedir(), ".claude");
}

/** Drops native `env` overrides that would fight the RLY child-only gateway contract. */
function stripGatewayEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings["env"];
  if (typeof env !== "object" || env === null || Array.isArray(env)) return settings;
  const stripped = Object.fromEntries(
    Object.entries(env as Record<string, unknown>).filter(([key]) => !(GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key)),
  );
  return { ...settings, env: stripped };
}

/**
 * Merges native settings with RLY-owned overrides. The native `model` stays
 * user input; a previously persisted RLY-only projection model in the overlay
 * is RLY-owned state and wins over native model input on re-compose.
 */
export function composeOverlaySettings(native: unknown, previous?: unknown): Record<string, unknown> {
  if (native === undefined) return {};
  if (typeof native !== "object" || native === null || Array.isArray(native)) {
    throw new Error("RLY cannot compose Claude settings: native settings.json is not a JSON object");
  }
  const merged = { ...stripGatewayEnv(native as Record<string, unknown>) };
  const previousModel = rlyOwnedModel(previous);
  if (previousModel !== undefined) merged["model"] = previousModel;
  return merged;
}

/** Returns the overlay-persisted model only when it is an RLY-only projection id. */
export function rlyOwnedModel(settings: unknown): string | undefined {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
  const model = (settings as Record<string, unknown>)["model"];
  return typeof model === "string" && model.startsWith(RLY_MODEL_PREFIX) ? model : undefined;
}

/** Carries only the plugin enablement declaration; never OAuth accounts or token-like keys. */
export function composeOverlayPluginConfig(native: unknown): unknown {
  if (typeof native !== "object" || native === null || Array.isArray(native)) return undefined;
  const source = native as Record<string, unknown>;
  const carried = Object.fromEntries(Object.entries(source).filter(([key]) => PLUGIN_CONFIG_ALLOWED_KEYS.has(key)));
  return Object.keys(carried).length === 0 ? undefined : carried;
}

export type ClaudeOverlayResolution = Readonly<{
  directory: string;
  source: string;
  /** True when any overlay file was composed/refreshed on this call. */
  composed: boolean;
  refreshed: readonly string[];
}>;

export type ClaudeOverlayPrepareOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
}>;

export type ClaudeOverlayStatus = Readonly<{
  directory: string;
  source: string;
  allowlistVersion: number;
  lastComposedAt?: string;
}>;

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isNewer(source: string, target: string): Promise<boolean> {
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
  return sourceStat.mtimeMs > targetStat.mtimeMs;
}

async function needsRefresh(source: string, target: string): Promise<boolean> {
  try {
    return await isNewer(source, target);
  } catch {
    // Target missing (or source unreadable): refresh.
    return true;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    // Missing, unreadable, or malformed native JSON surfaces are treated as
    // absent: RLY never fails the launch over native content it cannot
    // compose, and never rewrites it. Malformed native settings are skipped
    // (documented difference) rather than dropped silently from a shared file.
    return undefined;
  }
}

async function writePrivateText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporaryPath = join(dirname(path), `.rly-overlay.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) throw error;
    throw error;
  }
}

/** One-way refresh copy of a single allowlisted file (atomic, 0600). */
async function refreshFileCopy(source: string, target: string): Promise<boolean> {
  if (!(await isRegularFile(source))) return false;
  if (!(await needsRefresh(source, target))) return false;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700).catch(() => undefined);
  const temporaryPath = join(dirname(target), `.rly-overlay.${randomUUID()}.copy`);
  await copyFile(source, temporaryPath);
  await chmod(temporaryPath, 0o600).catch(() => undefined);
  try {
    await rename(temporaryPath, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) throw error;
    throw error;
  }
  return true;
}

/** Lists regular files below a directory. Symlinks are never followed (safety). */
async function listFiles(directory: string, recursive: boolean): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKILLS_EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...await listFiles(path, true));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}

type OverlayMarker = Readonly<{
  allowlistVersion?: number;
  source?: string;
  lastComposedAt?: string;
}>;

async function readMarker(path: string): Promise<OverlayMarker | undefined> {
  const value = await readJsonFile(path);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record["allowlistVersion"] === "number" ? { allowlistVersion: record["allowlistVersion"] } : {}),
    ...(typeof record["source"] === "string" ? { source: record["source"] } : {}),
    ...(typeof record["lastComposedAt"] === "string" ? { lastComposedAt: record["lastComposedAt"] } : {}),
  };
}

async function writeMarker(path: string, marker: OverlayMarker): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * Prepares (idempotently) the durable RLY Claude config overlay for a launch.
 *
 * Returns the `CLAUDE_CONFIG_DIR` value for the child. Missing, unreadable,
 * or malformed native surfaces are skipped (never rewritten); the native
 * `settings.json` is never failed over or modified.
 */
export async function prepareClaudeOverlay(
  controlPlaneDirectory: string,
  options: ClaudeOverlayPrepareOptions = {},
): Promise<ClaudeOverlayResolution> {
  const environment = options.environment ?? process.env;
  const paths = claudeOverlayPaths(controlPlaneDirectory);
  const source = nativeClaudeConfigDirectory(environment);
  if (samePath(source, paths.directory)) {
    // Never compose an overlay from itself (nested/self reference).
    return { directory: paths.directory, source, composed: false, refreshed: [] };
  }
  const refreshed: string[] = [];
  let composed = false;

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700).catch(() => undefined);

  // settings.json: one-way merge with RLY-owned overrides.
  const nativeSettingsPath = join(source, SETTINGS_FILE);
  const nativeSettings = await readJsonFile(nativeSettingsPath);
  const marker = await readMarker(paths.marker);
  const shouldComposeSettings = nativeSettings !== undefined && (
    !(await exists(paths.settings))
    || marker === undefined
    || (marker.allowlistVersion ?? 0) < CLAUDE_OVERLAY_ALLOWLIST_VERSION
    || await needsRefresh(nativeSettingsPath, paths.settings)
  );
  if (shouldComposeSettings) {
    const previous = await readJsonFile(paths.settings);
    await writePrivateText(paths.settings, `${JSON.stringify(composeOverlaySettings(nativeSettings, previous), null, 2)}\n`);
    refreshed.push(SETTINGS_FILE);
    composed = true;
  }

  // agents/*.md and commands/*.md: one-way refresh copy.
  for (const [directoryName, suffix] of [
    [AGENTS_DIRECTORY, ".md"],
    [COMMANDS_DIRECTORY, ".md"],
  ] as const) {
    for (const file of await listFiles(join(source, directoryName), false)) {
      if (!file.endsWith(suffix)) continue;
      if (await refreshFileCopy(file, join(paths.directory, directoryName, basename(file)))) {
        refreshed.push(join(directoryName, basename(file)));
      }
    }
  }

  // skills/** : allowlisted recursive copy of user-authored skills.
  const nativeSkills = join(source, SKILLS_DIRECTORY);
  for (const file of await listFiles(nativeSkills, true)) {
    const relativePath = relative(nativeSkills, file);
    if (await refreshFileCopy(file, join(paths.directory, SKILLS_DIRECTORY, relativePath))) {
      refreshed.push(join(SKILLS_DIRECTORY, relativePath));
    }
  }

  // plugins/config.json: allowlisted keys only; credential-bearing keys dropped.
  const nativePluginConfig = join(source, PLUGIN_CONFIG_RELATIVE);
  const pluginConfig = await readJsonFile(nativePluginConfig);
  if (pluginConfig !== undefined && await needsRefresh(nativePluginConfig, paths.pluginConfig)) {
    const carried = composeOverlayPluginConfig(pluginConfig);
    if (carried !== undefined) {
      await writePrivateText(paths.pluginConfig, `${JSON.stringify(carried, null, 2)}\n`);
      refreshed.push(PLUGIN_CONFIG_RELATIVE);
      composed = true;
    }
  }

  if (composed || refreshed.length > 0 || marker === undefined) {
    await writeMarker(paths.marker, {
      allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      source,
      lastComposedAt: new Date().toISOString(),
    });
  }
  return { directory: paths.directory, source, composed, refreshed };
}

/** Secret-free overlay summary for diagnostics; paths/version/composition status only. */
export async function readClaudeOverlayStatus(controlPlaneDirectory: string): Promise<ClaudeOverlayStatus | undefined> {
  const paths = claudeOverlayPaths(controlPlaneDirectory);
  const marker = await readMarker(paths.marker);
  if (marker === undefined) return undefined;
  return {
    directory: paths.directory,
    source: marker.source ?? nativeClaudeConfigDirectory(),
    allowlistVersion: marker.allowlistVersion ?? CLAUDE_OVERLAY_ALLOWLIST_VERSION,
    ...(marker.lastComposedAt === undefined ? {} : { lastComposedAt: marker.lastComposedAt }),
  };
}
