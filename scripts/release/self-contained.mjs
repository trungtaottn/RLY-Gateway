#!/usr/bin/env node
// RLY artifact self-containment check (#128).
//
// The "uninstall" qualification gate: an RLY artifact is a self-contained
// directory tree. Removal of the artifact must never require (or affect)
// anything outside its own tree. This check walks the unpacked artifact and
// verifies every entry resolves inside the artifact root (no escaping or
// absolute symlinks — same rule as the #35 positive allowlist) and that no
// file within the tree references an absolute developer path, home directory,
// or pnpm store path (privacy/public boundary for the qualification gate).

import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

async function walkTree(root, relativePrefix = "") {
  const entries = [];
  const names = (await readdir(join(root, relativePrefix))).sort();
  for (const name of names) {
    const path = relativePrefix ? `${relativePrefix}/${name}` : name;
    const details = await lstat(join(root, relativePrefix, name));
    if (details.isSymbolicLink()) {
      entries.push({ path, type: "symlink", target: await readlink(join(root, relativePrefix, name)) });
    } else if (details.isDirectory()) {
      entries.push({ path, type: "dir" });
      entries.push(...await walkTree(root, path));
    } else if (details.isFile()) {
      entries.push({ path, type: "file" });
    } else {
      entries.push({ path, type: "special" });
    }
  }
  return entries;
}

/**
 * Verifies the artifact tree is self-contained. Returns sorted errors;
 * an empty array means removal of the artifact directory is complete and
 * self-contained.
 */
export async function checkSelfContained(artifactRoot) {
  const errors = [];
  const entries = await walkTree(artifactRoot);
  for (const entry of entries) {
    if (entry.type === "special") errors.push(`special file: ${entry.path}`);
    if (entry.type === "symlink") {
      const target = entry.target ?? "";
      if (target === "" || target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
        errors.push(`absolute/escaping symlink ${entry.path} -> ${target}`);
        continue;
      }
      const resolved = resolve("/", join(artifactRoot, entry.path), "..", target);
      if (resolved !== resolve(artifactRoot) && !resolved.startsWith(`${resolve(artifactRoot)}${sep}`)) {
        errors.push(`symlink ${entry.path} -> ${target} escapes the artifact tree`);
      }
    }
  }
  // RLY-owned text files must not embed absolute developer paths / home dirs
  // / pnpm store paths (privacy/public boundary).
  const textCandidates = entries
    .filter((entry) => entry.type === "file")
    .filter((entry) => !entry.path.startsWith("node_modules/") || /\.json$/.test(entry.path))
    .filter((entry) => entry.path !== "bin/node");
  for (const entry of textCandidates) {
    let contents;
    try {
      contents = await readFile(join(artifactRoot, entry.path), "utf8");
    } catch {
      continue; // binary file
    }
    if (/\/home\/[^/ ]+/.test(contents)) errors.push(`${entry.path}: embeds a home directory path`);
    if (/(^|\/)\.pnpm-store(\/|$)/.test(contents)) errors.push(`${entry.path}: embeds a pnpm store path`);
  }
  return errors.sort();
}
