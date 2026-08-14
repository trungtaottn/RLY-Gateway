import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { classifyProviderFailure, cooldownUntilFor, nextQuotaClass } from "../../control-plane/health/outcomes.js";
import type { RouteOutcomeClass } from "../../control-plane/health/types.js";
import type { ControlPlaneStore } from "../../control-plane/store.js";
import { parseAffinity } from "./affinity.js";
import type { EffectiveRoute } from "../effective-route.js";
import { markOutputStarted } from "../effective-route.js";
import { NoEligibleAccountError, RouteSealedError } from "../errors.js";
import type { DecisionTrace } from "../eligibility/trace.js";
import { canRotate, isAbortError, isOutputOrToolEvent } from "./retry.js";
import type { RouteSelector, SelectInput } from "./selector.js";

export type PoolInvoke = (
  route: EffectiveRoute,
  signal: AbortSignal,
) => AsyncIterable<CanonicalEvent> | Iterable<CanonicalEvent>;

export type PoolExecution = Readonly<{
  route: EffectiveRoute;
  traces: readonly DecisionTrace[];
  events: readonly CanonicalEvent[];
}>;

export async function executePoolRequest(input: Readonly<{
  selector: RouteSelector;
  store: ControlPlaneStore;
  request: CanonicalRequest;
  select: Omit<SelectInput, "requestId" | "excludeAccountIds">;
  invoke: PoolInvoke;
  signal: AbortSignal;
}>): Promise<PoolExecution> {
  const pool = input.select.policy.snapshot.pools.find((item) => item.id === input.select.poolId);
  const retryBudget = pool?.retryBudget ?? 0;
  const affinity = parseAffinity(pool?.affinity);
  const traces: DecisionTrace[] = [];
  const tried: string[] = [];
  let lastError: Error | undefined;
  const maxAttempts = retryBudget + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let selected;
    try {
      selected = await input.selector.select({
        ...input.select,
        requestId: input.request.id,
        excludeAccountIds: tried,
      });
    } catch (error) {
      if (error instanceof NoEligibleAccountError && lastError !== undefined) throw lastError;
      throw error;
    }
    traces.push(selected.trace);
    input.selector.revalidate(selected.route, input.select);
    const collected: CanonicalEvent[] = [];
    let route = selected.route;
    try {
      for await (const event of input.invoke(route, input.signal)) {
        if (!route.outputStarted && isOutputOrToolEvent(event)) route = markOutputStarted(route);
        collected.push(event);
        if (event.type === "response-failed") {
          const outcome = classifyProviderFailure(event.code);
          recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
          lastError = new RouteFailure(outcome, event.code);
          if (!canRotate({
            outputStarted: route.outputStarted,
            rotationsUsed: attempt,
            retryBudget,
            outcome,
          })) {
            if (route.outputStarted) throw new RouteSealedError();
            throw lastError;
          }
          tried.push(route.accountId);
          break;
        }
      }
      if (collected.some((event) => event.type === "response-failed")) continue;
      recordOutcome(input.store, route, "success", affinity.cooldownSeconds);
      return { route, traces, events: collected };
    } catch (error) {
      if (error instanceof RouteSealedError || error instanceof RouteFailure) throw error;
      if (isAbortError(error)) throw error;
      const outcome = classifyThrown(error);
      recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
      lastError = error instanceof Error ? error : new Error("provider invoke failed");
      if (!canRotate({ outputStarted: route.outputStarted, rotationsUsed: attempt, retryBudget, outcome })) {
        throw lastError;
      }
      tried.push(route.accountId);
    }
  }
  throw lastError ?? new NoEligibleAccountError(input.request.id);
}

export class RouteFailure extends Error {
  override name = "RouteFailure";
  public constructor(
    readonly outcome: RouteOutcomeClass,
    readonly code: string,
  ) {
    super("Provider request failed");
  }
}

function recordOutcome(
  store: ControlPlaneStore,
  route: EffectiveRoute,
  outcome: RouteOutcomeClass,
  cooldownSeconds: Readonly<{ auth: number; quota: number; transient: number }>,
): void {
  const cooldown = outcome === "success" ? null : cooldownUntilFor(outcome, store.currentTime(), cooldownSeconds);
  const current = store.getAccount(route.accountId);
  store.recordRouteOutcome(route.accountId, {
    outcome,
    quotaClass: nextQuotaClass(outcome, current.quotaClass),
    cooldownUntil: cooldown ?? null,
  });
}

function classifyThrown(error: unknown): RouteOutcomeClass {
  if (error instanceof RouteFailure) return error.outcome;
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return classifyProviderFailure(code);
}
