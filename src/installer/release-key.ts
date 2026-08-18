/**
 * RLY release signing PUBLIC key (#128) embedded for runtime verification.
 *
 * The private key NEVER enters the repository (it lives only in the
 * `RLY_RELEASE_SIGNING_KEY` Actions secret); the public key is committed at
 * `scripts/release/signing-public-key.pem` AND embedded here so the compiled
 * runtime and standalone artifacts can verify channel metadata / release
 * manifests / artifact digest statements without shipping the `scripts/`
 * tree (which is outside the #35 artifact allowlist).
 *
 * A regression test asserts the embedded PEM is byte-identical to the
 * committed `scripts/release/signing-public-key.pem` so the two copies can
 * never drift silently.
 */

export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhbLJkqs+JHlKvo53l0Mu+OlnNoh9glFhbyY9i6d9IY0=
-----END PUBLIC KEY-----
`;
