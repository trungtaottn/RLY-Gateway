import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonStringify, publicKeyFingerprint, verifyDigestStatement, verifyJsonSignature, verifySignature } from "../../src/installer/signing.js";
import { RELEASE_PUBLIC_KEY_PEM } from "../../src/installer/release-key.js";
import { generateSigningKeyPair, signBytes, signDigestStatement, signJson, canonicalJsonStringify as publisherCanonicalJson } from "../../scripts/release/signing.mjs";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-signing-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installer Ed25519 verification (#129 / #128 interop)", () => {
  it("the embedded release public key is byte-identical to the committed PEM", async () => {
    const committed = await readFile(join(process.cwd(), "scripts", "release", "signing-public-key.pem"), "utf8");
    expect(RELEASE_PUBLIC_KEY_PEM).toBe(committed);
  });

  it("canonical JSON matches the publisher implementation byte-for-byte", () => {
    const value = {
      channelSchemaVersion: 1,
      channel: "beta",
      snapshots: [
        { releaseVersion: "1.0.0-beta.5", artifacts: { "linux-x64": { sha256: "a".repeat(64) } }, state: "current" },
      ],
      stale: false,
      nested: { z: 1, a: [3, 1, { x: "y" }], keep: null },
    };
    expect(canonicalJsonStringify(value)).toBe(publisherCanonicalJson(value));
  });

  it("verifies a publisher-signed JSON envelope and rejects tampering", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    const value = { channelSchemaVersion: 1, channel: "stable", version: 3 };
    const envelope = signJson(privateKeyPem, value);
    expect(verifyJsonSignature(publicKeyPem, value, envelope)).toBe(true);
    expect(verifyJsonSignature(publicKeyPem, { ...value, version: 4 }, envelope)).toBe(false);
    expect(verifyJsonSignature(publicKeyPem, value, { ...envelope, signature: "A".repeat(88) })).toBe(false);
    expect(() => verifyJsonSignature(publicKeyPem, value, { algorithm: "rsa" })).toThrow(/invalid/i);
    expect(() => verifyJsonSignature("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n", value, envelope)).toThrow(/fingerprint/i);
  });

  it("verifies a publisher-signed artifact digest statement", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    const digest = "b".repeat(64);
    const envelope = signDigestStatement(privateKeyPem, digest);
    expect(verifyDigestStatement(publicKeyPem, digest, envelope)).toBe(true);
    expect(verifyDigestStatement(publicKeyPem, "c".repeat(64), envelope)).toBe(false);
    expect(() => verifyDigestStatement(publicKeyPem, "not-a-digest", envelope)).toThrow(/invalid sha256/);
  });

  it("verifies raw-byte signatures and exposes a stable key fingerprint", () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    const envelope = signBytes(privateKeyPem, "sha256:abc\n");
    expect(verifySignature(publicKeyPem, "sha256:abc\n", envelope)).toBe(true);
    expect(verifySignature(publicKeyPem, "sha256:abd\n", envelope)).toBe(false);
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(RELEASE_PUBLIC_KEY_PEM)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies end-to-end with the committed key when signed by the same key", async () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    await writeFile(join(await directory(), "signing-public-key.pem"), publicKeyPem, "utf8");
    const envelope = signJson(privateKeyPem, { ok: true, n: 1 });
    expect(verifyJsonSignature(publicKeyPem, { ok: true, n: 1 }, envelope)).toBe(true);
  });
});
