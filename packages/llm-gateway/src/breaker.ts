import { AppError, isAppError } from "@brain/core";
import type { LlmGateway } from "./gateway.js";

export interface BreakerOptions {
  /** Failures in a row that stop calls to the provider. */
  readonly failureThreshold: number;
  /** How long calls stay stopped before one trial call is let through. */
  readonly openMs: number;
  readonly now?: () => number;
  /** Told when calls for a task stop and start again, for logs. */
  readonly onStateChange?: (task: string, state: "open" | "closed") => void;
}

/**
 * Failures that say the provider is unwell. A cancelled call, a request the provider rejects as
 * invalid, or a failure of our own (reported as provider_unknown) says nothing about its health.
 */
function isProviderFailure(err: unknown): boolean {
  if (!isAppError(err)) return false;
  const reason = String(err.details?.reason ?? "");
  if (err.code === "RATE_LIMITED") return true;
  if (err.code !== "UNAVAILABLE" || reason === "aborted" || reason === "provider_unknown") return false;
  return reason.startsWith("provider_") && !/^provider_4(0[0-9]|1[0-9]|2[0-8])$/.test(reason);
}

/** Our own setup is wrong, such as a revoked key or an unknown model: no wait will fix it. */
const MISCONFIGURED: ReadonlySet<string> = new Set(["provider_auth", "provider_404"]);

/**
 * The AI provider is down, overloaded or being skipped by the breaker, so asking again now would not
 * help (NFR-AVAIL-01). Callers can fall back to what works without it. A mistake in our own setup is
 * not an outage: it is reported as an error, so it gets fixed rather than hidden.
 */
export function isProviderOutage(err: unknown): boolean {
  if (!isAppError(err)) return false;
  const reason = String(err.details?.reason ?? "");
  if (MISCONFIGURED.has(reason)) return false;
  return reason === "circuit_open" || isProviderFailure(err);
}

/** One task's state. Each change bumps the generation, so a call that started before it cannot undo it. */
function createBreaker(task: string, options: BreakerOptions) {
  const now = options.now ?? Date.now;
  let failures = 0;
  let openedAt: number | null = null;
  let generation = 0;
  let isTrialRunning = false;

  const open = () => {
    if (openedAt === null) options.onStateChange?.(task, "open");
    openedAt = now();
    failures = 0;
    generation += 1;
  };
  const close = () => {
    if (openedAt !== null) {
      options.onStateChange?.(task, "closed");
      generation += 1;
    }
    openedAt = null;
    failures = 0;
  };

  return async function guard<T>(call: () => Promise<T>): Promise<T> {
    let isTrial = false;
    if (openedAt !== null) {
      if (now() - openedAt < options.openMs || isTrialRunning) {
        throw new AppError("UNAVAILABLE", "The AI service is not available right now. Try again in a minute.", {
          reason: "circuit_open",
        });
      }
      isTrial = true;
      isTrialRunning = true;
    }
    const startedIn = generation;
    const isCurrent = () => isTrial || startedIn === generation;
    try {
      const result = await call();
      if (isCurrent()) close();
      return result;
    } catch (err) {
      if (isProviderFailure(err) && isCurrent()) {
        failures += 1;
        if (isTrial || failures >= options.failureThreshold) open();
      }
      // A trial that failed for another reason, such as the person cancelling, proves nothing either
      // way, so calls stay stopped and the next one becomes the trial.
      throw err;
    } finally {
      if (isTrial) isTrialRunning = false;
    }
  };
}

/**
 * Stops calling the AI provider for a while after repeated failures (FR-LLM-04), so people get a
 * clear answer at once instead of waiting for calls that are likely to fail and may still be billed.
 * Each task has its own breaker, so trouble with one model does not stop the others.
 */
export function withCircuitBreaker(gateway: LlmGateway, options: BreakerOptions): LlmGateway {
  const answers = createBreaker("answer", options);
  const agents = createBreaker("agent", options);
  const rewrites = createBreaker("rewrite", options);
  return {
    streamAnswer: (input, onEvent, signal, onUsage) => answers(() => gateway.streamAnswer(input, onEvent, signal, onUsage)),
    agentTurn: (input, signal, onUsage) => agents(() => gateway.agentTurn(input, signal, onUsage)),
    rewriteQuery: (question, signal, onUsage, previous) => rewrites(() => gateway.rewriteQuery(question, signal, onUsage, previous)),
  };
}
