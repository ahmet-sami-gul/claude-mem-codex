import { describe, test, expect } from 'bun:test';
import { SessionMessageBuffer } from '../../../src/services/worker/SessionMessageBuffer.js';
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

describe('SessionMessageBuffer.claimContiguous (M4 observation batching)', () => {
  function summarize(): PendingMessage {
    return { type: 'summarize', last_assistant_message: 'done' };
  }

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

    const claimed = buffer.claimContiguous(1, () => true, 10);
    expect(claimed.map(m => m.tool_name)).toEqual(['B', 'C']);
    // Same view the drain yields: persistent id + original enqueue time.
    expect(claimed[0]._persistentId).toBeGreaterThan(head._persistentId);
    expect(typeof claimed[0]._originalTimestamp).toBe('number');
    expect(buffer.getUnclaimedCount(1)).toBe(0);
    // Claimed is not confirmed: everything is still buffered.
    expect(buffer.getPendingCount(1)).toBe(3);
  });

  test('stops at the first rejected message and never claims past it (summarize is never skipped)', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, summarize());
    buffer.enqueue(1, obs('B'));

    const seen: string[] = [];
    const claimed = buffer.claimContiguous(1, (m) => {
      seen.push(m.type === 'summarize' ? 'summarize' : m.tool_name!);
      return m.type === 'observation';
    }, 10);

    expect(claimed.map(m => m.tool_name)).toEqual(['A']);
    // B sits behind the summarize request, so it is not even offered.
    expect(seen).toEqual(['A', 'summarize']);
    expect(buffer.getUnclaimedCount(1)).toBe(2);
  });

  test('respects max and does not consult accept once the batch is full', () => {
    const buffer = new SessionMessageBuffer();
    for (const name of ['A', 'B', 'C', 'D']) buffer.enqueue(1, obs(name));
    let calls = 0;
    const claimed = buffer.claimContiguous(1, () => { calls++; return true; }, 2);
    expect(claimed.map(m => m.tool_name)).toEqual(['A', 'B']);
    expect(calls).toBe(2);
    expect(buffer.claimContiguous(1, () => true, 0)).toEqual([]);
    expect(buffer.claimContiguous(99, () => true, 5)).toEqual([]);
  });

  test('notifies the mutation hook once per claim that took something', () => {
    let mutations = 0;
    const buffer = new SessionMessageBuffer(() => { mutations++; });
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    mutations = 0;
    buffer.claimContiguous(1, () => true, 5);
    expect(mutations).toBe(1);
    buffer.claimContiguous(1, () => true, 5);
    expect(mutations).toBe(1);
  });

  test('claimed batch members are confirmed and reset like drained ones', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('A'));
    buffer.enqueue(1, obs('B'));
    buffer.enqueue(1, obs('C'));
    const claimed = buffer.claimContiguous(1, () => true, 2);
    expect(buffer.resetClaimed(1)).toBe(2);
    const redrained = await drainAll(buffer, 1);
    expect(redrained.map(m => m.tool_name)).toEqual(['A', 'B', 'C']);
    for (const m of claimed) expect(buffer.confirm(m._persistentId)).toBe(1);
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
