/**
 * "The observer's model just answered a turn" — a tiny in-process signal
 * (M3, plan 3.5).
 *
 * WHY IT EXISTS. Some Codex problems are only visible to a real exec: a
 * lockdown breach, a model the server rejects, a plan that does not include
 * Codex, a 401 while `codex login status` still reports a ChatGPT login. The
 * model-free self-check passes straight through all of them, so a passing
 * re-check cannot be trusted to mean "fixed". The codex readiness gate instead
 * lets ONE waiting session through as a canary and releases the rest only once
 * that canary's model has actually answered. Waiting for the canary's
 * generator to EXIT would not do: an active Claude Code session keeps its
 * generator running for as long as it keeps working, and every session that
 * already ended would sit behind it indefinitely.
 *
 * The same signal is what proves a run healthy enough to end a problem streak
 * (the gate's backoff), instead of "the run ended without a login problem",
 * which an idle exit or a circuit refusal also satisfies.
 *
 * WHAT COUNTS. ResponseProcessor raises it only for a non-empty answer that
 * got past every refusal classifier (overflow, quota, auth and transport
 * prose): parsed XML, or plain prose the observer chose to answer with. An
 * empty turn does not count — Codex's first forbidden-tool attempt comes back
 * as empty content, and that is precisely the run a canary exists to catch.
 *
 * Listeners run synchronously and must not throw into the caller; a throwing
 * listener is logged and the rest still hear the event.
 */

import { logger } from '../../../utils/logger.js';
import type { ObserverProvider } from '../../worker-types.js';

export interface ObserverTurnAnswered {
  sessionDbId: number;
  /** `session.currentProvider` when the answer arrived; null if unknown. */
  provider: ObserverProvider | null;
}

export type ObserverTurnAnsweredListener = (event: ObserverTurnAnswered) => void;

const listeners = new Set<ObserverTurnAnsweredListener>();

/** Subscribe; returns the unsubscribe. */
export function onObserverTurnAnswered(listener: ObserverTurnAnsweredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyObserverTurnAnswered(event: ObserverTurnAnswered): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error: unknown) {
      logger.warn('SESSION', 'Observer turn listener threw', { sessionId: event.sessionDbId },
        error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Test hook: drop every subscription. */
export function resetObserverTurnListenersForTesting(): void {
  listeners.clear();
}
