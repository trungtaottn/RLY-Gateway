import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { OAuthFlowError } from "../../src/credentials/errors.js";
import { matchesPkceChallenge } from "../../src/credentials/pkce.js";
import { createPkcePair } from "../../src/credentials/pkce.js";
import { fakeOauth, tempDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("codex oauth login", () => {
  it("completes PKCE login through an exact loopback callback", async () => {
    const directory = await tempDirectory("agent-gateway-oauth-ok-");
    directories.push(directory);
    const port = await availablePort();
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth(), callbackPort: port });
    const started = await broker.startLogin({ providerId: "00000000-0000-4000-8000-000000000001", pseudonym: "acct-fixture-001" });
    expect(started.authorizationUrl).toContain("code_challenge=");
    expect(started.authorizationUrl).toContain("code_challenge_method=S256");
    expect(started.redirectUri).toBe(`http://127.0.0.1:${String(port)}/callback`);
    const pair = createPkcePair();
    expect(matchesPkceChallenge(pair.verifier, pair.challenge)).toBe(true);
    const response = await fetch(`${started.redirectUri}?code=fixture-code&state=${started.state}`);
    expect(response.status).toBe(200);
    const metadata = await broker.waitForLogin();
    expect(metadata.generation).toBe(1);
    expect(metadata.pseudonym).toBe("acct-fixture-001");
    await broker.close();
  });

  it("fails closed on replay, mismatch, cancel, and callback collision", async () => {
    const directory = await tempDirectory("agent-gateway-oauth-neg-");
    directories.push(directory);
    const port = await availablePort();
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth(), callbackPort: port });
    const started = await broker.startLogin({ providerId: "00000000-0000-4000-8000-000000000001", pseudonym: "acct-fixture-001" });
    const mismatch = await fetch(`${started.redirectUri}?code=fixture-code&state=wrong-state`);
    expect(mismatch.status).toBe(400);
    const first = await fetch(`${started.redirectUri}?code=fixture-code&state=${started.state}`);
    expect(first.status).toBe(200);
    await broker.waitForLogin();
    await expect(fetch(`${started.redirectUri}?code=fixture-code&state=${started.state}`)).rejects.toThrow();
    await broker.close();

    const next = await CredentialBroker.open(directory, { oauth: fakeOauth(), callbackPort: port });
    const login = await next.startLogin({ providerId: "00000000-0000-4000-8000-000000000001", pseudonym: "acct-fixture-002" });
    const cancelled = next.waitForLogin();
    await next.cancelLogin(login.state);
    await expect(cancelled).rejects.toBeInstanceOf(OAuthFlowError);
    await next.close();

    const holder = await CredentialBroker.open(directory, { oauth: fakeOauth(), callbackPort: port });
    await holder.startLogin({ providerId: "00000000-0000-4000-8000-000000000001", pseudonym: "acct-fixture-003" });
    const colliding = await CredentialBroker.open(directory, { oauth: fakeOauth(), callbackPort: port });
    await expect(colliding.startLogin({
      providerId: "00000000-0000-4000-8000-000000000001",
      pseudonym: "acct-fixture-004",
    })).rejects.toMatchObject({ code: "callback-collision" });
    await colliding.close();
    await holder.close();
  });

  it("rejects expired and already-consumed state without persisting a credential", async () => {
    const directory = await tempDirectory("agent-gateway-oauth-replay-");
    directories.push(directory);
    let now = Date.now();
    const { OAuthSessionStore } = await import("../../src/credentials/oauth-session.js");
    const sessions = new OAuthSessionStore(() => now);
    const created = sessions.create({
      redirectUri: "http://127.0.0.1:17873/callback",
      providerId: "00000000-0000-4000-8000-000000000001",
      pseudonym: "acct-fixture-001",
    });
    sessions.consume(created.state, created.redirectUri);
    expect(() => sessions.consume(created.state, created.redirectUri)).toThrow(/already used/);
    const expiring = sessions.create({
      redirectUri: "http://127.0.0.1:17873/callback",
      providerId: "00000000-0000-4000-8000-000000000001",
      pseudonym: "acct-fixture-002",
    });
    now += 11 * 60 * 1000;
    expect(() => sessions.consume(expiring.state, expiring.redirectUri)).toThrow(/expired/);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    expect(await broker.metadata("cred-none")).toBeUndefined();
    await broker.close();
  });

  it("rejects an oversized oauth token body without storing a credential", async () => {
    const { createCodexOAuthClient } = await import("../../src/providers/oauth/codex/protocol.js");
    const { OAuthFlowError: FlowError } = await import("../../src/credentials/errors.js");
    const client = createCodexOAuthClient(() => Promise.resolve(new Response("x".repeat(5000), { status: 200 })));
    await expect(client.exchangeAuthorizationCode({
      code: "fixture-code",
      verifier: "fixture-verifier",
      redirectUri: "http://127.0.0.1:17873/callback",
    })).rejects.toBeInstanceOf(FlowError);
  });
});
