/**
 * The shared error policy for HTTP/CLI observer providers, lifted verbatim out
 * of OpenAICompatibleProvider so a provider that does not extend that class
 * (or extends it but needs the policy from its own catch sites) applies exactly
 * the same rules rather than a second, drifting copy.
 *
 * The bodies are unchanged: same categories, same order, same log lines, same
 * rethrow contract. The only additions are the `providerName` parameter that
 * used to be read off `this`, and the stashing of the classified failure on the
 * session so a later reader (status, observer health, the Codex quota circuit)
 * can see WHY the generator paused instead of re-deriving it from a string.
 */

import { logger } from '../../../utils/logger.js';
import { isClassified, type ClassifiedProviderError } from '../provider-errors.js';
import { isAbortError } from '../agents/FallbackErrorHandler.js';
import type { WorkerRef } from '../agents/types.js';
import type { ActiveSession } from '../../worker-types.js';

/**
 * Map a classified provider failure onto the abortReason category that keeps
 * buffered work alive.
 *
 * handleGeneratorExit finalizes the session — dropping whatever is buffered —
 * for every category outside its preserve list. Quota was only ever set by
 * the two PROACTIVE sites (the pre-request rate-limit guard and the
 * observer-text heuristic), so a real 429 coming back from the provider left
 * abortReason null and the session was torn down as if the failure were
 * fatal (#3700). These conditions clear on their own; the work should still
 * be there when they do.
 */
export function preservingAbortReason(error: ClassifiedProviderError): string | null {
  switch (error.kind) {
    case 'quota_exhausted':
    case 'rate_limit':
      return `quota:${error.kind}`;
    // Same shape, same list: handleGeneratorExit already honours 'auth', and
    // credentials that are fixed by /login are no more fatal than a 429.
    case 'auth_invalid':
      return `auth:${error.kind}`;
    // A timeout or network fault that outlived the retry policy. Finalizing
    // would turn it into permanent data loss — the same reasoning as the
    // observer-text transport path in ResponseProcessor (#3752).
    case 'transient':
      return `transport:${error.kind}`;
    default:
      return null;
  }
}

/**
 * Label, abort, log, rethrow — the one way an observer generator failure leaves
 * a provider. `providerName` is the human-readable provider label that used to
 * come from `this.providerName`.
 */
export function handleSessionError(
  error: unknown,
  session: ActiveSession,
  providerName: string,
  _worker?: WorkerRef,
): never {
  if (isAbortError(error)) {
    logger.warn('SDK', `${providerName} agent aborted`, { sessionId: session.sessionDbId });
    throw error;
  }

  if (isClassified(error)) {
    // Stashed BEFORE the abort, for the same reason abortReason is: everything
    // downstream of the abort (the route's .finally(), status, observer health)
    // runs while this call is still unwinding, so a failure recorded afterwards
    // would arrive too late to be read.
    session.lastProviderError = error;

    // Set BEFORE the rethrow: the .finally() in SessionRoutes reads
    // session.abortReason to decide whether to finalize the session, so a
    // reason recorded after unwinding would arrive too late to matter.
    const preserving = preservingAbortReason(error);
    if (preserving !== null) {
      session.abortReason = preserving;
      // Abort as well as label. Without it the controller stays live while
      // the error unwinds, and the session route books the failure twice —
      // an observer failure and an error outcome on the way out, then the
      // aborted outcome at finalization — leaving observer-health marked
      // failed for a pause that is not a failure. This is what the two
      // observer-text paths already do for the same conditions.
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      logger.warn('SDK', `${providerName} paused on ${error.kind}; preserving buffered work`, {
        sessionId: session.sessionDbId,
        kind: error.kind,
      });
    }

    // Logged once at SessionRoutes' `Observer failed` line.
    logger.debug('SDK', `${providerName} agent error`, { sessionDbId: session.sessionDbId, kind: error.kind }, error);
  } else {
    logger.failure('SDK', `${providerName} agent error`, { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
  }
  throw error;
}
