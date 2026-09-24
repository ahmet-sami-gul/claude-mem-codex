import { describe, test, expect } from 'bun:test';
import { CLAIM_MATCHING_LOOKAHEAD, SessionMessageBuffer } from '../../../src/services/worker/SessionMessageBuffer.js';
import type { PendingMessage, PendingMessageWithId } from '../../../src/services/worker-types.js';

function obs(toolName: string, toolUseId?: string): PendingMessage {
  return { type: 'observation', tool_name: toolName, tool_input: {}, tool_response: {}, toolUseId };
}

/** Drain everything currently buffered, ending the iterator via a tiny idle timeout. */
async function drainAll(buffer: SessionMessageBuffer, sessionDbId: number): Promise<PendingMessageWithId[]> {
  const controller = new AbortController();
  const collected: PendingMessageWithId[] = [];
  for await (const msg of buffer.drain({
    sessionDbId,
    signal: controller.signal,
    idleTimeoutMs: 30,
    onIdleTimeout: () => controller.abort(),
  })) {
    collected.push(msg);
  }
  return collected;
}

describe('SessionMessageBuffer (in-RAM observation buffer)', () => {
  test('enqueue assigns increasing ids and reports depth', () => {
    const buffer = new SessionMessageBuffer();
    const id1 = buffer.enqueue(1, obs('Read'));
    const id2 = buffer.enqueue(1, obs('Write'));
    expect(id2).toBeGreaterThan(id1);
    expect(buffer.getPendingCount(1)).toBe(2);
    expect(buffer.getTotalDepth()).toBe(2);
  });

  test('dedups observations by toolUseId within a session, but never dedups summarize/no-id', () => {
    const buffer = new SessionMessageBuffer();
    expect(buffer.enqueue(1, obs('Read', 'tool-abc'))).toBeGreaterThan(0);
    expect(buffer.enqueue(1, obs('Read', 'tool-abc'))).toBe(0); // duplicate suppressed
    expect(buffer.enqueue(1, obs('Read'))).toBeGreaterThan(0);  // no id → not deduped
    expect(buffer.enqueue(1, obs('Read'))).toBeGreaterThan(0);  // no id → not deduped
    // same toolUseId in a different session is independent
    expect(buffer.enqueue(2, obs('Read', 'tool-abc'))).toBeGreaterThan(0);
  });

  test('drain yields buffered messages in FIFO order with id + timestamp', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));
    const drained = await drainAll(buffer, 1);
    expect(drained.map(m => m.tool_name)).toEqual(['Read', 'Write']);
    expect(drained[0]._persistentId).toBeGreaterThan(0);
    expect(typeof drained[0]._originalTimestamp).toBe('number');
  });

  test('confirm removes a message; resetClaimed makes claimed messages re-drainable', async () => {
    const buffer = new SessionMessageBuffer();
    const id = buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));

    // First drain claims both.
    const first = await drainAll(buffer, 1);
    expect(first.length).toBe(2);
    // Nothing confirmed yet → still buffered.
    expect(buffer.getPendingCount(1)).toBe(2);

    // Confirm one → depth drops.
    expect(buffer.confirm(id)).toBe(1);
    expect(buffer.getPendingCount(1)).toBe(1);

    // resetClaimed re-yields the remaining (claimed-but-unconfirmed) one.
    expect(buffer.resetClaimed(1)).toBe(1);
    const second = await drainAll(buffer, 1);
    expect(second.map(m => m.tool_name)).toEqual(['Write']);
  });

  test('clear empties a session; dispose forgets it', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));
    expect(buffer.clear(1)).toBe(2);
    expect(buffer.getPendingCount(1)).toBe(0);
    // dispose also clears the dedup memory, so the same toolUseId can re-enter.
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.dispose(1);
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0);
  });

  test('clear also resets the dedup set so a previously-seen toolUseId re-enters', () => {
    // Regression: clear() must drop seenToolUseIds like dispose() does.
    // Otherwise a clear() not followed by dispose() leaves the dedup set intact
    // and a later enqueue of a previously-seen toolUseId is silently lost (0).
    const buffer = new SessionMessageBuffer();
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0);
    expect(buffer.clear(1)).toBe(1);
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0); // not suppressed
  });

  test('drain ends via idle timeout when no work arrives', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    let idleFired = false;
    const start = Date.now();
    const iterated: PendingMessageWithId[] = [];
    for await (const msg of buffer.drain({
      sessionDbId: 99,
      signal: controller.signal,
      idleTimeoutMs: 25,
      onIdleTimeout: () => { idleFired = true; controller.abort(); },
    })) {
      iterated.push(msg);
    }
    expect(idleFired).toBe(true);
    expect(iterated.length).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  test('peekTypes reflects buffered message types', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, { type: 'summarize', last_assistant_message: 'done' });
    const types = buffer.peekTypes(1);
    expect(types).toEqual([
      { message_type: 'observation', tool_name: 'Read' },
      { message_type: 'summarize', tool_name: null },
    ]);
  });
});

describe('SessionMessageBuffer.claimMatching (M4 observation batching)', () => {
  function summarize(): PendingMessage {
    return { type: 'summarize', last_assistant_message: 'done' };
  }

  const isSummarize = (m: PendingMessageWithId): boolean => m.type !== 'observation';
  const all = { isBarrier: () => false, accept: () => true };

  /** Claim the head of the queue the way the drain does, via a one-shot drain. */
  async function claimHead(buffer: SessionMessageBuffer, sessionDbId: number): Promise<PendingMessageWithId> {
    const controller = new AbortController();
    const iterator = buffer.drain({ sessionDbId, signal: controller.signal, idleTimeoutMs: 30 });
    const first = await iterator.next();
    controller.abort();
    await iterator.return?.();
    if (first.done) throw new Error('nothing to claim');
    return first.value;
  }

  test('claims unclaimed messages oldest first, skipping the ones already claimed', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    buffer.enqueue(1, obs('C'));
    const head = await claimHead(buffer, 1);
    expect(head.tool_name).toBe('A');

    const offered: string[] = [];
    const claimed = buffer.claimMatching(1, { ...all, accept: m => { offered.push(m.tool_name!); return true; }, max: 10 });
    expect(claimed.map(m => m.tool_name)).toEqual(['B', 'C']);
    // The claimed head is neither offered nor a barrier.
    expect(offered).toEqual(['B', 'C']);
    // Same view the drain yields: persistent id + original enqueue time.
    expect(claimed[0]._persistentId).toBeGreaterThan(head._persistentId);
    expect(typeof claimed[0]._originalTimestamp).toBe('number');
    expect(buffer.getUnclaimedCount(1)).toBe(0);
    // Claimed is not confirmed: everything is still buffered.
    expect(buffer.getPendingCount(1)).toBe(3);
  });

  test('skips what accept rejects and keeps walking; the skipped messages stay queued in order', async () => {
    const buffer = new SessionMessageBuffer();
    for (const name of ['A1', 'B1', 'A2', 'C1', 'B2', 'A3']) buffer.enqueue(1, obs(name));

    const claimed = buffer.claimMatching(1, { isBarrier: isSummarize, accept: m => m.tool_name!.startsWith('A'), max: 10 });

    expect(claimed.map(m => m.tool_name)).toEqual(['A1', 'A2', 'A3']);
    expect(buffer.getUnclaimedCount(1)).toBe(3);
    const rest = await drainAll(buffer, 1);
    expect(rest.map(m => m.tool_name)).toEqual(['B1', 'C1', 'B2']);
  });

  test('stops at the first barrier and never claims or offers anything past it (summarize is never skipped)', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A1'));
    buffer.enqueue(1, obs('B1'));
    buffer.enqueue(1, summarize());
    buffer.enqueue(1, obs('A2'));

    const offered: string[] = [];
    const barriers: string[] = [];
    const claimed = buffer.claimMatching(1, {
      isBarrier: m => { barriers.push(m.type === 'summarize' ? 'summarize' : m.tool_name!); return isSummarize(m); },
      accept: m => { offered.push(m.tool_name!); return m.tool_name!.startsWith('A'); },
      max: 10,
    });

    expect(claimed.map(m => m.tool_name)).toEqual(['A1']);
    // B1 is skipped, the summarize ends the walk, and A2 behind it is not even looked at.
    expect(barriers).toEqual(['A1', 'B1', 'summarize']);
    expect(offered).toEqual(['A1', 'B1']);
    expect(buffer.getUnclaimedCount(1)).toBe(3);
  });

  test('a claimed summarize is in flight, not a barrier', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, summarize());
    buffer.enqueue(1, obs('A'));
    const head = await claimHead(buffer, 1);
    expect(head.type).toBe('summarize');

    const claimed = buffer.claimMatching(1, { isBarrier: isSummarize, accept: () => true, max: 10 });
    expect(claimed.map(m => m.tool_name)).toEqual(['A']);
  });

  test('examines at most `lookahead` unclaimed messages', () => {
    const buffer = new SessionMessageBuffer();
    for (const name of ['B1', 'B2', 'B3', 'A1', 'A2']) buffer.enqueue(1, obs(name));
    const accept = (m: PendingMessageWithId): boolean => m.tool_name!.startsWith('A');

    let offered = 0;
    const claimed = buffer.claimMatching(1, {
      isBarrier: isSummarize,
      accept: m => { offered++; return accept(m); },
      max: 10,
      lookahead: 4,
    });
    expect(claimed.map(m => m.tool_name)).toEqual(['A1']);
    expect(offered).toBe(4);

    // Claimed messages do not count against the lookahead.
    expect(buffer.claimMatching(1, { isBarrier: isSummarize, accept, max: 10, lookahead: 4 }).map(m => m.tool_name)).toEqual(['A2']);
  });

  test('defaults the lookahead to CLAIM_MATCHING_LOOKAHEAD', () => {
    const buffer = new SessionMessageBuffer();
    for (let i = 0; i < CLAIM_MATCHING_LOOKAHEAD; i++) buffer.enqueue(1, obs(`B${i}`));
    buffer.enqueue(1, obs('A-far'));
    expect(buffer.claimMatching(1, { isBarrier: isSummarize, accept: m => m.tool_name === 'A-far', max: 10 })).toEqual([]);
    buffer.confirm(buffer.claimMatching(1, { ...all, max: 1 })[0]._persistentId);
    expect(buffer.claimMatching(1, { isBarrier: isSummarize, accept: m => m.tool_name === 'A-far', max: 10 }).map(m => m.tool_name)).toEqual(['A-far']);
  });

  test('respects max, and calls accept once per message in queue order, never once the batch is full', () => {
    const buffer = new SessionMessageBuffer();
    for (const name of ['A', 'B', 'C', 'D', 'E']) buffer.enqueue(1, obs(name));
    const offered: string[] = [];
    const claimed = buffer.claimMatching(1, {
      isBarrier: isSummarize,
      accept: m => { offered.push(m.tool_name!); return m.tool_name !== 'B'; },
      max: 2,
    });
    expect(claimed.map(m => m.tool_name)).toEqual(['A', 'C']);
    expect(offered).toEqual(['A', 'B', 'C']);
    expect(buffer.claimMatching(1, { ...all, max: 0 })).toEqual([]);
    expect(buffer.claimMatching(99, { ...all, max: 5 })).toEqual([]);
  });

  test('notifies the mutation hook once per claim that took something', () => {
    let mutations = 0;
    const buffer = new SessionMessageBuffer(() => { mutations++; });
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    mutations = 0;
    buffer.claimMatching(1, { ...all, max: 5 });
    expect(mutations).toBe(1);
    buffer.claimMatching(1, { ...all, max: 5 });
    expect(mutations).toBe(1);
  });

  test('claimed batch members are confirmed and reset like drained ones', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    buffer.enqueue(1, obs('C'));
    const claimed = buffer.claimMatching(1, { ...all, max: 2 });
    expect(buffer.resetClaimed(1)).toBe(2);
    const redrained = await drainAll(buffer, 1);
    expect(redrained.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
    for (const m of claimed) expect(buffer.confirm(m._persistentId)).toBe(1);
    expect(buffer.getPendingCount(1)).toBe(1);
  });
});

describe('SessionMessageBuffer.dropOldestUnclaimedObservations (codex queue cap)', () => {
  function summarize(): PendingMessage {
    return { type: 'summarize', last_assistant_message: 'done' };
  }

  test('drops the oldest unclaimed observations down to `keep`, and nothing when under it', async () => {
    let mutations = 0;
    const buffer = new SessionMessageBuffer(() => { mutations++; });
    for (const name of ['A', 'B', 'C', 'D', 'E']) buffer.enqueue(1, obs(name));
    mutations = 0;

    expect(buffer.dropOldestUnclaimedObservations(1, 5)).toBe(0);
    expect(mutations).toBe(0);

    expect(buffer.dropOldestUnclaimedObservations(1, 2)).toBe(3);
    expect(mutations).toBe(1);
    expect((await drainAll(buffer, 1)).map(m => m.tool_name)).toEqual(['D', 'E']);
    expect(buffer.dropOldestUnclaimedObservations(99, 0)).toBe(0);
  });

  test('never drops claimed (in-flight) messages or anything but an observation', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    // A and B are in flight.
    buffer.claimMatching(1, { isBarrier: () => false, accept: () => true, max: 2 });
    buffer.enqueue(1, summarize());
    buffer.enqueue(1, obs('C'));
    buffer.enqueue(1, { type: 'init' } as unknown as PendingMessage);
    buffer.enqueue(1, obs('D'));
    buffer.enqueue(1, obs('E'));

    expect(buffer.dropOldestUnclaimedObservations(1, 1)).toBe(2);

    expect(buffer.getPendingCount(1)).toBe(5);
    expect(buffer.peekTypes(1)).toEqual([
      { message_type: 'observation', tool_name: 'A' },
      { message_type: 'observation', tool_name: 'B' },
      { message_type: 'summarize', tool_name: null },
      { message_type: 'init', tool_name: null },
      { message_type: 'observation', tool_name: 'E' },
    ]);
    // Even with no room left, only unclaimed observations go.
    expect(buffer.dropOldestUnclaimedObservations(1, 0)).toBe(1);
    expect(buffer.getPendingCount(1)).toBe(4);
    expect(buffer.getUnclaimedCount(1)).toBe(2);
  });

  test('keeps a dropped toolUseId in the dedup set', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A', 'tool-a'));
    buffer.enqueue(1, obs('B', 'tool-b'));
    expect(buffer.dropOldestUnclaimedObservations(1, 1)).toBe(1);
    // A re-delivered duplicate of the dropped tool use is still suppressed.
    expect(buffer.enqueue(1, obs('A', 'tool-a'))).toBe(0);
    expect(buffer.getPendingCount(1)).toBe(1);
  });
});

describe('SessionMessageBuffer.waitForNewMessage', () => {
  test('resolves true when a message is enqueued for the session', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    const waiting = buffer.waitForNewMessage(1, controller.signal, 5_000);
    setTimeout(() => buffer.enqueue(1, obs('A')), 10);
    const start = Date.now();
    expect(await waiting).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test('resolves false on timeout, and ignores other sessions', async () => {
    const buffer = new SessionMessageBuffer();
    const waiting = buffer.waitForNewMessage(1, new AbortController().signal, 40);
    buffer.enqueue(2, obs('A'));
    expect(await waiting).toBe(false);
  });

  test('resolves false at once for an aborted signal or a non-positive timeout', async () => {
    const buffer = new SessionMessageBuffer();
    const aborted = new AbortController();
    aborted.abort();
    const start = Date.now();
    expect(await buffer.waitForNewMessage(1, aborted.signal, 5_000)).toBe(false);
    expect(await buffer.waitForNewMessage(1, new AbortController().signal, 0)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('resolves false when the signal aborts mid-wait', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    const waiting = buffer.waitForNewMessage(1, controller.signal, 5_000);
    setTimeout(() => controller.abort(), 10);
    expect(await waiting).toBe(false);
  });
});
