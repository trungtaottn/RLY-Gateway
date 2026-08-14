#!/usr/bin/env node
import semanticRelease from "semantic-release";
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
process.stdout.write(`Released ${gitTag}\n`);
if (outputPath) {
  await appendFile(outputPath, `released=true\nversion=${version}\ntag=${gitTag}\nnotes<<EOF\n${notes}\nEOF\n`);
}
