/**
 * SessionManager.claimObservationBatch (M4, plan 3.3 "Diğer değişiklikler").
 *
 * The batch claim is what lets a provider pay for ONE turn per burst of tool
 * calls instead of one per call. Its guarantees are the ones pinned here:
 * FIFO with a hard stop at the first message that cannot join (so a summarize
 * request is never skipped), grouping by prompt/agent/cwd, count and character
 * budgets, a linger only while the queue is idle, and a claimed set that the
 * existing confirm/reset calls act on as a whole.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import {
  SessionManager,
  observationBatchChars,
  type ObservationBatchPolicy,
} from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ObservationData, PendingMessageWithId } from '../../src/services/worker-types.js';

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: (id: number) => ({
      content_session_id: `content-${id}`,
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      getLatestPromptTextFromUserPrompts: () => null,
    }),
  } as unknown as DatabaseManager;
}

const SESSION = 1;
const NO_LINGER: ObservationBatchPolicy = { maxMessages: 10, maxChars: 1_000_000, lingerMs: 0 };

let toolCounter = 0;
function obsData(overrides: Partial<ObservationData> = {}): ObservationData {
  toolCounter++;
  return {
    tool_name: `Tool${toolCounter}`,
    tool_input: { n: toolCounter },
    tool_response: { ok: true },
    prompt_number: 1,
    cwd: '/repo',
    toolUseId: `tu-${toolCounter}`,
    ...overrides,
  };
}

/** Claim the head of the queue exactly as a generator does. */
async function claimFirst(sm: SessionManager): Promise<{
  first: PendingMessageWithId;
  iterator: AsyncIterableIterator<PendingMessageWithId>;
}> {
  const iterator = sm.getMessageIterator(SESSION);
  const next = await iterator.next();
  if (next.done) throw new Error('nothing queued');
  return { first: next.value, iterator };
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('SessionManager.claimObservationBatch', () => {
  let sm: SessionManager;

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
    sm = new SessionManager(makeDbManager());
    sm.initializeSession(SESSION, 'prompt', 1);
  });

  afterEach(async () => {
    // End any drain a test left parked on the buffer.
    sm.getSession(SESSION)?.abortController.abort();
    spies.forEach(spy => spy.mockRestore());
  });

  it('claims the queued observations of the same prompt, agent and cwd in FIFO order', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C' }));
    const { first } = await claimFirst(sm);

    const batch = await sm.claimObservationBatch(SESSION, first, NO_LINGER);

    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
    expect(batch[0]).toBe(first);
    const session = sm.getSession(SESSION)!;
    expect(session.claimedMessageIds).toEqual(batch.map(m => m._persistentId));
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(0);
  });

  it('stops at a summarize request and never claims the observation behind it', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    await sm.queueSummarize(SESSION, 'done');
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C' }));
    const { first, iterator } = await claimFirst(sm);

    const batch = await sm.claimObservationBatch(SESSION, first, NO_LINGER);
    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);

    // The drain's next message is the summarize, then C — queue order kept.
    const next = await iterator.next();
    expect(next.value?.type).toBe('summarize');
  });

  it.each([
    ['prompt number', { prompt_number: 2 }],
    ['agent id', { agentId: 'sub-1' }],
    ['agent type', { agentType: 'explorer' }],
    ['working directory', { cwd: '/other' }],
  ] as const)('ends the batch at an observation with a different %s', async (_label, different) => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'X', ...different }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'D' }));
    const { first } = await claimFirst(sm);

    const batch = await sm.claimObservationBatch(SESSION, first, NO_LINGER);

    // FIFO: D matches A, but it is behind X, so it is not taken.
    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);
  });

  it('treats an empty and an absent grouping field as the same group', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A', agentId: undefined, cwd: '' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B', agentId: '', cwd: undefined }));
    const { first } = await claimFirst(sm);
    const batch = await sm.claimObservationBatch(SESSION, first, NO_LINGER);
    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);
  });

  it('keeps the batch within maxMessages, counting the first observation', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await sm.queueObservation(SESSION, obsData({ tool_name: name }));
    }
    const { first } = await claimFirst(sm);
    const batch = await sm.claimObservationBatch(SESSION, first, { ...NO_LINGER, maxMessages: 3 });
    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(2);
  });

  it('keeps the batch within maxChars, measured as the rendered envelopes', async () => {
    const small = { tool_input: { v: 'x'.repeat(100) } };
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A', ...small }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B', ...small }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C', ...small }));
    const { first } = await claimFirst(sm);
    const one = observationBatchChars(first);
    expect(one).toBeGreaterThan(100);

    // Room for exactly two envelopes (the names are the same width).
    const batch = await sm.claimObservationBatch(SESSION, first, { ...NO_LINGER, maxChars: one * 2 + 1 });
    expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);
  });

  it('measures the truncated envelope, not the raw payload', async () => {
    // A 200K field renders as ~16K after the prompt's own head/tail elision.
    await sm.queueObservation(SESSION, obsData({ tool_name: 'Big', tool_response: { content: 'y'.repeat(200_000) } }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    const { first } = await claimFirst(sm);
    expect(observationBatchChars(first)).toBeLessThan(20_000);
    const batch = await sm.claimObservationBatch(SESSION, first, { ...NO_LINGER, maxChars: 48_000 });
    expect(batch.map(m => m.tool_name)).toEqual(['Big', 'B']);
  });

  it('always sends the first observation, even when it alone exceeds maxChars, and does not linger for company', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A', tool_input: { v: 'x'.repeat(5_000) } }));
    const { first } = await claimFirst(sm);
    const start = Date.now();
    const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 1_000, lingerMs: 5_000 });
    expect(batch).toEqual([first]);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('maxMessages 1 disables batching entirely: nothing claimed, no linger', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    const { first } = await claimFirst(sm);
    const start = Date.now();
    const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 1, maxChars: 48_000, lingerMs: 5_000 });
    expect(batch).toEqual([first]);
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  describe('linger', () => {
    it('does not linger when work is already queued', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
      const { first } = await claimFirst(sm);
      const wait = spyOn(sm.getMessageBuffer(), 'waitForNewMessage');

      const start = Date.now();
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 2, maxChars: 48_000, lingerMs: 5_000 });

      expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);
      expect(wait).not.toHaveBeenCalled();
      expect(Date.now() - start).toBeLessThan(1_000);
    });

    it('claims a backlog shorter than maxMessages and returns at once, without waiting for more', async () => {
      // Work was queued when the call began: this is a backlog drain, not a
      // burst in progress, so the now-empty queue is not waited on.
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
      const { first } = await claimFirst(sm);
      const wait = spyOn(sm.getMessageBuffer(), 'waitForNewMessage');

      const start = performance.now();
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 1_500 });
      const elapsed = performance.now() - start;

      expect(batch.map(m => m.tool_name)).toEqual(['A', 'B']);
      expect(wait).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(500);
    });

    it('does not linger when the next queued message cannot join', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      await sm.queueSummarize(SESSION, 'done');
      const { first } = await claimFirst(sm);
      const wait = spyOn(sm.getMessageBuffer(), 'waitForNewMessage');
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 5_000 });
      expect(batch).toEqual([first]);
      expect(wait).not.toHaveBeenCalled();
    });

    it('lingers while the queue is idle and takes the rest of a burst', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      setTimeout(() => { void sm.queueObservation(SESSION, obsData({ tool_name: 'B' })); }, 20);
      setTimeout(() => { void sm.queueObservation(SESSION, obsData({ tool_name: 'C' })); }, 60);

      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 3, maxChars: 48_000, lingerMs: 2_000 });

      expect(batch.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
    });

    it('bounds the linger by lingerMs in total and returns what it has', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      const start = Date.now();
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 60 });
      const elapsed = Date.now() - start;
      expect(batch).toEqual([first]);
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(1_000);
    });

    it('shares ONE linger budget across arrivals rather than restarting it per message', async () => {
      // lingerMs 200 from the start of the call: B (50 ms) and C (150 ms) are
      // inside it; D (300 ms) is not. A per-wait linger would have restarted
      // the 200 ms after C and taken D too (150 + 200 = 350 > 300).
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      const start = performance.now();
      setTimeout(() => { void sm.queueObservation(SESSION, obsData({ tool_name: 'B' })); }, 50);
      setTimeout(() => { void sm.queueObservation(SESSION, obsData({ tool_name: 'C' })); }, 150);
      const dQueued = new Promise<void>(resolve => {
        setTimeout(() => { void sm.queueObservation(SESSION, obsData({ tool_name: 'D' })).then(() => resolve()); }, 300);
      });

      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 10, maxChars: 48_000, lingerMs: 200 });
      const elapsed = performance.now() - start;
      await dQueued;

      expect(batch.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
      expect(elapsed).toBeGreaterThanOrEqual(190);
      expect(elapsed).toBeLessThan(290);
      expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(1);
    });

    it('never lingers for an aborted session', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      sm.getSession(SESSION)!.abortController.abort();
      const start = Date.now();
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 5_000 });
      expect(batch).toEqual([first]);
      expect(Date.now() - start).toBeLessThan(1_000);
    });

    it('stops lingering as soon as the session aborts', async () => {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      setTimeout(() => sm.getSession(SESSION)!.abortController.abort(), 20);
      const start = Date.now();
      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 5_000 });
      expect(batch).toEqual([first]);
      expect(Date.now() - start).toBeLessThan(1_000);
    });
  });

  it('keeps earliestPendingTimestamp and lastGeneratorActivity current', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    const { first } = await claimFirst(sm);
    const session = sm.getSession(SESSION)!;
    // Pretend the head was claimed a while ago and something older is pending.
    session.earliestPendingTimestamp = first._originalTimestamp - 5_000;
    session.lastGeneratorActivity = 0;

    const batch = await sm.claimObservationBatch(SESSION, first, NO_LINGER);

    expect(batch).toHaveLength(2);
    expect(session.earliestPendingTimestamp).toBe(first._originalTimestamp - 5_000);
    expect(session.lastGeneratorActivity).toBeGreaterThan(0);

    session.earliestPendingTimestamp = null;
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C' }));
    await sm.claimObservationBatch(SESSION, first, NO_LINGER);
    expect(session.earliestPendingTimestamp).not.toBeNull();
  });

  it('confirms the whole claimed batch together', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C' }));
    const { first } = await claimFirst(sm);
    await sm.claimObservationBatch(SESSION, first, NO_LINGER);

    expect(await sm.confirmClaimedMessages(SESSION)).toBe(3);
    expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(0);
    const session = sm.getSession(SESSION)!;
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).toBeNull();
  });

  it('resets the whole claimed batch to pending together, and it is re-yielded in order', async () => {
    await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'B' }));
    await sm.queueObservation(SESSION, obsData({ tool_name: 'C' }));
    const { first, iterator } = await claimFirst(sm);
    await sm.claimObservationBatch(SESSION, first, NO_LINGER);
    expect(sm.getClaimedMessages(SESSION).map(m => m.tool_name)).toEqual(['A', 'B', 'C']);

    expect(await sm.resetProcessingToPending(SESSION)).toBe(3);
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(3);

    const again: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await iterator.next();
      again.push(next.value!.tool_name!);
    }
    expect(again).toEqual(['A', 'B', 'C']);
  });

  it('returns just the first message for an unknown session', async () => {
    const first = { type: 'observation', tool_name: 'A', _persistentId: 1, _originalTimestamp: 1 } as PendingMessageWithId;
    expect(await sm.claimObservationBatch(999, first, NO_LINGER)).toEqual([first]);
  });
});

describe('SessionManager.claimObservationBatch: claim reset underneath a linger', () => {
  it('never puts the same message in a batch twice', async () => {
    const quiet = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    const sm = new SessionManager(makeDbManager());
    sm.initializeSession(SESSION, 'prompt', 1);
    try {
      await sm.queueObservation(SESSION, obsData({ tool_name: 'A' }));
      const { first } = await claimFirst(sm);
      // Something resets the claims while the batch is lingering: A is
      // unclaimed again and sits at the head of the queue.
      setTimeout(() => { void sm.resetProcessingToPending(SESSION); }, 10);

      const batch = await sm.claimObservationBatch(SESSION, first, { maxMessages: 4, maxChars: 48_000, lingerMs: 200 });

      expect(batch.map(m => m._persistentId)).toEqual([first._persistentId]);
    } finally {
      sm.getSession(SESSION)?.abortController.abort();
      quiet.forEach(spy => spy.mockRestore());
    }
  });
});
