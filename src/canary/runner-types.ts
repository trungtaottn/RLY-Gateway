import type { ClientContract } from "./client-fixtures.js";
import type {
  ClaimFeature,
  CompatibilityClaimDocument,
  EvidenceArtifactV2,
} from "./claim.js";
import type { AuthMode, ClientKind, EndpointContract, EvidenceResult } from "./types.js";

/**
 * Installed-client and live access-path compatibility runners (#123).
 *
 * Shared vocabulary for the Layer B (installed-client black-box) and Layer C
 * (exact live access-path) evidence runners. Both layers produce Evidence
 * Artifact v2 records (feature-scoped, keyed to the exact execution path via
 * `claimKeyFor`) with a typed, redacted failure taxonomy and per-observation
 * timing. Runners are observation-only: they NEVER mutate trusted registry /
 * effective compatibility state (#124 owns promotion).
 *
 * Secret-free invariants: raw result files carry allowlisted metadata
 * (booleans, counts, gate names, typed reasons, timing) only — never
 * credentials, authorization headers, account identity, prompts, real
 * responses, or reasoning text. Missing credentials / missing binaries /
 * skipped runs emit `not-run` (or no record), never PASS.
 */

/** Runner/tool versions for Layer B and Layer C evidence records. */
export const INSTALLED_CLIENT_RUNNER_VERSION = "rly-installed-client-runner/1.0" as const;
export const LIVE_ACCESS_PATH_RUNNER_VERSION = "rly-live-access-path-runner/1.0" as const;

/** Fixture/corpus revision the Layer B black-box fixture server serves. */
export const INSTALLED_CLIENT_FIXTURE_REVISION = "rly-installed-client-blackbox-fixtures-v1" as const;
/** Corpus revision for Layer C canary requests (synthetic, low-impact). */
export const LIVE_ACCESS_FIXTURE_REVISION = "rly-live-access-path-canary-v1" as const;

/**
 * Typed, redacted failure taxonomy (#123 scope item 9). Values are stable
 * lowercase identifiers — never free-form prose, never secrets. A failure
 * reason distinguishes client contract drift, protocol translation failure,
 * authentication failure, provider availability/quota/rate-limit failure,
 * unsupported feature, malformed continuation, timeout/cancel failure, and
 * environment/platform inability. Contract-drift sub-reasons pin the exact
 * changed behavior (`missing-agent-header`, `effort-signal-lost`, client did
 * not send a config it is expected to send).
 */
export type CompatFailureCategory =
  | "client-contract-drift"
  | "missing-agent-header"
  | "effort-signal-lost"
  | "client-did-not-send-reasoning-config"
  | "client-did-not-send-effort-signal"
  | "protocol-translation-failure"
  | "authentication-failure"
  | "authentication-credentials-unavailable"
  | "provider-unavailable"
  | "provider-rate-limit"
  | "unsupported-feature"
  | "malformed-continuation"
  | "timeout-cancel-failure"
  | "environment-inability"
  | "client-not-installed"
  | "provider-did-not-call-tool"
  | "not-applicable-to-access-path";

/** One feature-scoped black-box/live observation (pre-evidence record). */
export type RunnerGateObservation = Readonly<{
  gate: ClaimFeature;
  result: EvidenceResult;
  failureReason?: CompatFailureCategory;
  /** Wall-clock duration of the observation in milliseconds. */
  timingMs?: number;
  /** Short, redacted detail (e.g. `provider returned 429`). Never a secret. */
  detail?: string;
}>;

/**
 * Allowlisted wire summary captured by the Layer B fixture server. Booleans
 * and counts only — never header values (authorization is redacted), never
 * request/response bodies, never prompts or reasoning text.
 */
export type BlackBoxWireSummary = Readonly<{
  requestCount: number;
  /** True when the client issued a `GET /v1/models` discovery request. */
  discoveryRequested?: boolean;
  sessionHeaderPresent?: boolean;
  agentHeaderPresent?: boolean;
  parentAgentHeaderPresent?: boolean;
  streamRequested?: boolean;
  toolRequested?: boolean;
  toolResultReceived?: boolean;
  reasoningRequested?: boolean;
  effortSignalPresent?: boolean;
  /** Client-facing protocol of the fixture server. */
  contract: EndpointContract;
  /** Client exit code/signal (safe, integer/null). */
  exitCode: number | null;
  exitSignal: string | null;
  /** True when the child was killed by the bounded timeout. */
  timedOut: boolean;
  /** True when the fixture observed the upstream connection abort (cancellation). */
  upstreamAborted?: boolean;
  /** Requests observed concurrently (parallel-subagent approximation). */
  concurrentRequests: number;
}>;

/** Result of a Layer B run for one client: observations + evidence records. */
export type InstalledClientRunSummary = Readonly<{
  client: ClientKind;
  /** Exact executable path identity of the installed client. */
  executable: string;
  /** Exact observed client version (probe output), distinct from baseline. */
  observedVersion: string;
  /** Reviewed supported baseline; observed ≠ baseline and never auto-promoted. */
  supportedBaseline: string;
  /** Fixture/corpus revision the black-box ran against. */
  fixtureRevision: string;
  gates: readonly RunnerGateObservation[];
  /** Feature-scoped Evidence Artifact v2 records (layer B). */
  evidence: readonly EvidenceArtifactV2[];
  /** Per-feature Compatibility Claim documents (observed-version keyed). */
  claims: readonly CompatibilityClaimDocument[];
  /** Safe path to the raw machine-readable results (metadata only). */
  rawResultsRef?: string;
  environment: Readonly<{ platform: string; nodeVersion: string }>;
  /** Set when the client binary was not found; gates then report not-run. */
  error?: string;
}>;

/** Result of a Layer C run for one exact access path. */
export type LiveAccessPathSummary = Readonly<{
  identity: Readonly<{
    client: ClientKind;
    clientVersion: string;
    adapterId: string;
    accessProviderId: string;
    authMode: AuthMode;
    endpointContract: EndpointContract;
    physicalModelId: string;
  }>;
  gates: readonly RunnerGateObservation[];
  evidence: readonly EvidenceArtifactV2[];
  claims: readonly CompatibilityClaimDocument[];
  rawResultsRef?: string;
  environment: Readonly<{ platform: string; nodeVersion: string }>;
  /** Set when credentials were unavailable or the run was skipped. */
  error?: string;
}>;

/**
 * Full child invocation for one black-box gate. The default invocation is
 * derived from the client kind (real installed binary, client-native args,
 * child-only env). Tests inject a script-based invocation so the runner logic
 * is deterministic without a real client binary.
 */
export type ChildInvocation = Readonly<{
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}>;

/** Context handed to the invocation builder for one gate. */
export type InvocationContext = Readonly<{
  gate: ClaimFeature;
  fixtureBaseUrl: string;
  configDirectory: string;
  environment: NodeJS.ProcessEnv;
}>;

/**
 * Layer B run spec. `executable`/`observedVersion` come from
 * `detectInstalledClients` (or the drift-surveillance target). `invoke`
 * overrides the child invocation for deterministic tests (fake client script);
 * the production default runs the actual installed binary with child-only
 * env isolated from real client config.
 */
export type InstalledClientRunSpec = Readonly<{
  client: ClientKind;
  executable: string;
  observedVersion: string;
  supportedBaseline: string;
  contract: ClientContract;
  gates?: readonly ClaimFeature[];
  fixtureRevision?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  platform?: Readonly<{ platform: string; nodeVersion: string }>;
  timeoutMs?: number;
  invoke?: (context: InvocationContext) => ChildInvocation;
  /** Where raw machine-readable results are written (default: none). */
  resultDirectory?: string;
}>;

/**
 * Layer C live run spec: the exact configured
 * (client + protocol/revision + adapter + provider + auth mode + endpoint +
 * physical model + feature) access path, executed with explicit opt-in and an
 * available credential. `providerBaseUrl` is the exact configured endpoint;
 * the credential is read from `credentialEnvName` (never stored or logged).
 */
export type LiveAccessPathSpec = Readonly<{
  client: ClientKind;
  clientVersion: string;
  contract: ClientContract;
  adapterId: string;
  accessProviderId: string;
  authMode: AuthMode;
  endpointContract: EndpointContract;
  physicalModelId: string;
  providerBaseUrl: string;
  credentialEnvName: string;
  gates?: readonly ClaimFeature[];
  fixtureRevision?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  platform?: Readonly<{ platform: string; nodeVersion: string }>;
  timeoutMs?: number;
  resultDirectory?: string;
}>;

/** Feature gates exercisable by the installed-client black-box (Claude Code). */
export const CLAUDE_BLACKBOX_GATES: readonly ClaimFeature[] = Object.freeze([
  "text",
  "streaming",
  "cancellation",
  "tools-single",
  "tools-multi",
  "tools-parallel",
  "reasoning",
  "reasoning-tools",
  "model-discovery",
  "session-attribution",
  "subagent-routing",
  "subagent-parallel",
  "effort-signal",
  "long-running-session",
  "config-overlay",
]);

/** Feature gates exercisable by the installed-client black-box (Codex CLI). */
export const CODEX_BLACKBOX_GATES: readonly ClaimFeature[] = Object.freeze([
  "text",
  "streaming",
  "cancellation",
  "tools-single",
  "tools-multi",
  "tools-parallel",
  "reasoning",
  "reasoning-tools",
  "model-discovery",
  "effort-signal",
  "config-overlay",
]);

/**
 * Feature gates exercisable by the live access-path runner over the client
 * HTTP surface. Client-side lifecycle features (subagent routing/parallel,
 * config-overlay, long-running sessions) are not provable over one HTTP path
 * and stay `not-run` with a typed reason — never PASS.
 */
export const LIVE_ACCESS_GATES: readonly ClaimFeature[] = Object.freeze([
  "text",
  "streaming",
  "cancellation",
  "tools-single",
  "tools-multi",
  "tools-parallel",
  "reasoning",
  "reasoning-tools",
  "model-discovery",
  "session-attribution",
  "effort-signal",
]);

/** All gates a black-box/live runner may evaluate for a client kind. */
export function blackBoxGatesFor(client: ClientKind): readonly ClaimFeature[] {
  return client === "claude-code" ? CLAUDE_BLACKBOX_GATES : CODEX_BLACKBOX_GATES;
}
