#!/usr/bin/env node
import semanticRelease from "semantic-release";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import process from "node:process";

const outputPath = process.env[`GITHUB_${"OUTPUT"}`];
const result = await semanticRelease({ ci: true });
if (!result) {
  process.stdout.write("No releasable commits\n");
  if (outputPath) await appendFile(outputPath, "released=false\n");
  process.exit(0);
}
const { version, gitTag, notes } = result.nextRelease;
const githubRelease = result.releases?.find((release) => release.name === "@semantic-release/github");
const releaseUrl = githubRelease?.url ?? "";
process.stdout.write(`Released ${gitTag}\n`);
if (outputPath) {
  const notesDelimiter = `SEMANTIC_RELEASE_NOTES_${randomUUID()}`;
  await appendFile(outputPath, `released=true\nversion=${version}\ntag=${gitTag}\nrelease-url=${releaseUrl}\nnotes<<${notesDelimiter}\n${notes}\n${notesDelimiter}\n`);
}
