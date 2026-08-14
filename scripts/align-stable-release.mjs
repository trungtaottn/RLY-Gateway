#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const targetBranch = "dev";
const stableBranch = "main";
const shaPattern = /^[0-9a-f]{40}$/;
const environment = (name) => process.env[`GITHUB_${name}`] ?? "";

export function evaluateAlignment({ targetSha, mainSha, devIsAncestor, treesIdentical }) {
  if (!shaPattern.test(targetSha)) throw new Error("Stable release SHA must be a full commit SHA");
  if (mainSha !== targetSha) throw new Error("Stable branch advanced after release; refusing to align dev to a stale SHA");
  if (!devIsAncestor) throw new Error("dev is not an ancestor of the released main SHA; refusing non-fast-forward alignment");
  if (!treesIdentical) throw new Error("dev and released main have divergent tree content; refusing alignment");
  return { branch: targetBranch, sha: targetSha, force: false };
}

async function git(...args) {
  const { stdout } = await execFile("git", args, { encoding: "utf8" });
  return stdout.trim();
}

async function exitsZero(...args) {
  try {
    await git(...args);
    return true;
  } catch {
    return false;
  }
}

async function appendOutput(name, value) {
  const outputPath = environment("OUTPUT");
  if (outputPath) await appendFile(outputPath, `${name}=${value}\n`);
}

async function main() {
  const targetSha = environment("SHA");
  const repository = environment("REPOSITORY");
  const token = environment("TOKEN");
  if (environment("REF_NAME") !== stableBranch) throw new Error("Stable alignment may run only from the main branch");
  if (!repository || !token) throw new Error("GitHub repository and workflow token are required");

  await git("fetch", "--no-tags", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`);
  const mainSha = await git("ls-remote", "origin", `refs/heads/${stableBranch}`);
  const currentMainSha = mainSha.split(/\s+/u)[0] ?? "";
  const devIsAncestor = await exitsZero("merge-base", "--is-ancestor", `refs/remotes/origin/${targetBranch}`, targetSha);
  const treesIdentical = await exitsZero("diff", "--quiet", `refs/remotes/origin/${targetBranch}^{tree}`, `${targetSha}^{tree}`);
  const update = evaluateAlignment({ targetSha, mainSha: currentMainSha, devIsAncestor, treesIdentical });
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/git/refs/heads/${update.branch}`, {
    method: "PATCH",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ sha: update.sha, force: update.force }),
  });
  if (!response.ok) throw new Error(`GitHub rejected fast-forward dev alignment (${response.status})`);
  await appendOutput("status", "aligned");
  process.stdout.write(`Aligned ${targetBranch} to released ${stableBranch} SHA\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
