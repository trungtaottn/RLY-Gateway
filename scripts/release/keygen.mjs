#!/usr/bin/env node
// RLY release signing key management (#128).
//
// Generates an Ed25519 key pair for release signing and prints the PUBLIC key
// PEM (safe to commit) and the PRIVATE key PEM (NEVER commit — install it as
// the repository secret RLY_RELEASE_SIGNING_KEY).
//
// Usage:
//   node scripts/release/keygen.mjs [--out-dir <dir>]
//
// When --out-dir is given, writes signing-public-key.pem (commit this) and
// signing-private-key.pem (secret; gitignored/never commit) into the dir and
// prints the matching fingerprints. Without it, prints both PEMs to stdout.
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateSigningKeyPair, publicKeyFingerprint } from "./signing.mjs";

function parseArgs(argv) {
  const options = { outDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--out-dir requires a value");
      options.outDir = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pair = generateSigningKeyPair();
  const publicFingerprint = publicKeyFingerprint(pair.publicKey);
  if (options.outDir !== undefined) {
    const dir = resolve(options.outDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "signing-public-key.pem"), pair.publicKey);
    await writeFile(join(dir, "signing-private-key.pem"), pair.privateKey);
    process.stdout.write(
      `Generated signing key pair in ${dir}:\n` +
        `  public : signing-public-key.pem  (fingerprint ${publicFingerprint})  — COMMIT this file\n` +
        `  private: signing-private-key.pem (fingerprint ${publicFingerprint})  — NEVER COMMIT; install as the GitHub secret RLY_RELEASE_SIGNING_KEY\n`,
    );
  } else {
    process.stdout.write(
      `# RLY release signing key pair (Ed25519)\n# Public key fingerprint: ${publicFingerprint}\n#\n# PUBLIC key — safe to commit:\n${pair.publicKey}#\n# PRIVATE key — NEVER COMMIT. Install as the repository secret RLY_RELEASE_SIGNING_KEY:\n${pair.privateKey}`,
    );
  }
}

await main().catch((error) => {
  process.stderr.write(`keygen failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
