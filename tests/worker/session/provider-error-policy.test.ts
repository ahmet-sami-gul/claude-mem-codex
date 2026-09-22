/**
 * The shared provider error policy (M2, plan 3.3 hook 7).
 *
 * The bodies were lifted verbatim out of OpenAICompatibleProvider so a
 * provider outside that hierarchy applies identical rules. The ONE behavioural
 * addition is the `session.lastProviderError` stash, and it applies to Claude,
 * Gemini and OpenRouter as much as to Codex — CodexProvider has its own
 * `rememberFailure` that sets the same field inside query()'s catch, so every
 * codex assertion is satisfied whether or not the shared policy still does it.
 * These tests pin the shared policy directly, so deleting the stash cannot pass
 * unnoticed.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { handleSessionError, preservingAbortReason } from '../../../src/services/worker/session/provider-error-policy.js';
import { ClassifiedProviderError } from '../../../src/services/worker/provider-errors.js';
import { logger } from '../../../src/utils/logger.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';

function makeSession(): ActiveSession {
  return {
    sessionDbId: 11,
    contentSessionId: 'content-11',
    memorySessionId: 'mem-11',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function classified(kind: ClassifiedProviderError['kind']): ClassifiedProviderError {
  return new ClassifiedProviderError(`provider said ${kind}`, {
    kind,
    cause: new Error(kind),
    code: `test_${kind}`,
  });
}

function applied(error: unknown, session: ActiveSession): unknown {
  try {
    handleSessionError(error, session, 'TestProvider');
    return null;
  } catch (thrown: unknown) {
    return thrown;
  }
}

describe('provider-error-policy', () => {
  let warn: ReturnType<typeof spyOn>;
  let debug: ReturnType<typeof spyOn>;
  let failure: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, 'warn').mockImplementation(() => {});
    debug = spyOn(logger, 'debug').mockImplementation(() => {});
    failure = spyOn(logger, 'failure').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
    failure.mockRestore();
  });

  it('stashes the classified failure on the session before it aborts', () => {
    const session = makeSession();
    const error = classified('quota_exhausted');

    expect(applied(error, session)).toBe(error);

    // The object itself, not a message: every reader downstream of the abort
    // (status, observer health, a provider's quota circuit) needs the
    // kind/code/retryAfterMs structurally.
    expect(session.lastProviderError).toBe(error);
    expect(session.abortReason).toBe('quota:quota_exhausted');
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('stashes it for a classified failure that does NOT preserve the batch', () => {
    const session = makeSession();
    const error = classified('setup_required');

    expect(applied(error, session)).toBe(error);

    expect(session.lastProviderError).toBe(error);
    // No preserving category for setup_required — the field is still the
    // record of why this run ended.
    expect(session.abortReason).toBeUndefined();
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('leaves the field alone for an abort', () => {
    const session = makeSession();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    expect(applied(abort, session)).toBe(abort);

    // An abort is the session ending on purpose, not a provider failure.
    expect(session.lastProviderError).toBeUndefined();
  });

  it('leaves the field alone for an unclassified error', () => {
    const session = makeSession();
    const bug = new TypeError('x.trim is not a function');

    expect(applied(bug, session)).toBe(bug);

    expect(session.lastProviderError).toBeUndefined();
    expect(failure).toHaveBeenCalled();
  });

  it('maps only the self-clearing conditions onto a preserving abort reason', () => {
    expect(preservingAbortReason(classified('quota_exhausted'))).toBe('quota:quota_exhausted');
    expect(preservingAbortReason(classified('rate_limit'))).toBe('quota:rate_limit');
    expect(preservingAbortReason(classified('auth_invalid'))).toBe('auth:auth_invalid');
    expect(preservingAbortReason(classified('transient'))).toBe('transport:transient');
    expect(preservingAbortReason(classified('setup_required'))).toBeNull();
  });
});
