import { createHash, randomBytes } from "node:crypto";

export type PkcePair = Readonly<{
  verifier: string;
  challenge: string;
  method: "S256";
}>;

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function matchesPkceChallenge(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}
