import { EventEmitter } from 'events';
import type { PendingMessage, PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

interface BufferedMessage {
  id: number;
  message: PendingMessage;
  claimed: boolean;
  enqueuedAt: number;
}

export interface DrainOptions {
  sessionDbId: number;
  signal: AbortSignal;
  onIdleTimeout?: () => void;
  idleTimeoutMs?: number;
}

/**
 * Per-session in-RAM observation buffer. This replaces the durable
 * `pending_messages` SQLite queue (and the BullMQ engine that mirrored it).
 *
 * Why in-RAM and not durable: a buffered message is one tool-use fragment fed
 * to a stateful, non-deterministic reducer (the memory agent batches N
 * tool-uses into M observations using in-memory conversation context). The old
 * durable queue persisted the fragments but threw away the reducer state, so
 * "replaying" pending rows after a crash regenerated different/duplicate
 * observations or looped forever — that was the retry storm. The Claude Code
 * transcript JSONL is the real durable source of truth, and transcript replay
 * is the recovery path. So this buffer deliberately holds work only for the
 * worker process lifetime: no 'processing' state to resurrect on restart, no
 * startup sweep, no respawn-on-pending. If the worker dies, the buffer is gone
 * and recovery is a transcript replay.
 *
 * confirm()/resetClaimed() exist only as in-process control flow within a
 * single live generator pass (drop a stored batch; re-yield a batch that
 * couldn't be stored yet because the memory session id wasn't captured). They
 * never cross a process boundary.
 */
export class SessionMessageBuffer {
  private readonly buffers = new Map<number, BufferedMessage[]>();
  private readonly events = new Map<number, EventEmitter>();
  private readonly seenToolUseIds = new Map<number, Set<string>>();
  private nextId = 1;

  constructor(private readonly onMutate?: () => void) {}

  /**
   * Append a message. Returns the assigned id, or 0 if suppressed as a
   * duplicate. Dedup matches the old partial UNIQUE(content_session_id,
   * tool_use_id) index: only observations that carry a toolUseId are deduped,
   * and only against others in the same session for this worker's lifetime.
   */
  enqueue(sessionDbId: number, message: PendingMessage): number {
    const toolUseId = message.toolUseId;
    if (toolUseId) {
      const seen = this.getSeen(sessionDbId);
      if (seen.has(toolUseId)) {
        return 0;
      }
      seen.add(toolUseId);
    }

    const id = this.nextId++;
    this.getList(sessionDbId).push({ id, message, claimed: false, enqueuedAt: Date.now() });
    this.onMutate?.();
    this.signal(sessionDbId);
    return id;
  }

  /** Remove a stored message by id. Returns 1 if found, 0 otherwise. */
  confirm(messageId: number): number {
    for (const list of this.buffers.values()) {
      const idx = list.findIndex(m => m.id === messageId);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.onMutate?.();
        return 1;
      }
    }
    return 0;
  }

  /** Un-claim all messages for a session so the iterator re-yields them. */
  resetClaimed(sessionDbId: number): number {
    const list = this.buffers.get(sessionDbId);
    if (!list) return 0;
    let reset = 0;
    for (const m of list) {
      if (m.claimed) {
        m.claimed = false;
        reset++;
      }
    }
    if (reset > 0) {
      this.onMutate?.();
      this.signal(sessionDbId);
    }
    return reset;
  }

  /** Drop everything buffered for a session. */
  clear(sessionDbId: number): number {
    const cleared = this.buffers.get(sessionDbId)?.length ?? 0;
    this.buffers.delete(sessionDbId);
    // Mirror dispose(): drop the dedup set too. Otherwise a clear() not followed
    // by dispose() leaves seenToolUseIds intact, so a later enqueue carrying a
    // previously-seen toolUseId is silently suppressed (returns 0) and lost.
    this.seenToolUseIds.delete(sessionDbId);
    if (cleared > 0) {
      this.onMutate?.();
    }
    return cleared;
  }

  /** Forget a session entirely (buffer, dedup set, event emitter). */
  dispose(sessionDbId: number): void {
    this.buffers.delete(sessionDbId);
    this.seenToolUseIds.delete(sessionDbId);
    this.events.get(sessionDbId)?.removeAllListeners();
    this.events.delete(sessionDbId);
  }

  getPendingCount(sessionDbId: number): number {
    return this.buffers.get(sessionDbId)?.length ?? 0;
  }

  /**
   * Buffered messages no generator has claimed yet — the work that is actually
   * waiting, as opposed to getPendingCount, which also counts the batch a
   * generator is processing right now.
   */
  getUnclaimedCount(sessionDbId: number): number {
    let unclaimed = 0;
    for (const m of this.buffers.get(sessionDbId) ?? []) {
      if (!m.claimed) unclaimed++;
    }
    return unclaimed;
  }

  getTotalDepth(): number {
    let total = 0;
    for (const list of this.buffers.values()) {
      total += list.length;
    }
    return total;
  }

  getMessagesByIds(sessionDbId: number, messageIds: number[]): PendingMessageWithId[] {
    if (messageIds.length === 0) {
      return [];
    }

    const lookup = new Map<number, PendingMessageWithId>();
    for (const buffered of this.buffers.get(sessionDbId) ?? []) {
      lookup.set(buffered.id, {
        ...buffered.message,
        _persistentId: buffered.id,
        _originalTimestamp: buffered.enqueuedAt,
      });
    }

    const messages: PendingMessageWithId[] = [];
    for (const messageId of messageIds) {
      const message = lookup.get(messageId);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }

  peekTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    return (this.buffers.get(sessionDbId) ?? []).map(m => ({
      message_type: m.message.type,
      tool_name: m.message.tool_name ?? null
    }));
  }

  /**
   * Drain buffered messages as they arrive. Yields one unclaimed message at a
   * time; when the buffer is empty it waits on the per-session event emitter
   * until a new message is enqueued, the abort signal fires, or the idle
   * timeout elapses (which triggers onIdleTimeout and ends the iterator so the
   * SDK subprocess is killed).
   */
  async *drain(options: DrainOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout, idleTimeoutMs = IDLE_TIMEOUT_MS } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      const claimed = this.claimNext(sessionDbId);
      if (claimed) {
        lastActivityTime = Date.now();
        yield {
          ...claimed.message,
          _persistentId: claimed.id,
          _originalTimestamp: claimed.enqueuedAt
        };
        continue;
      }

      const received = await this.waitForMessage(sessionDbId, signal, idleTimeoutMs);
      if (!received && !signal.aborted) {
        const idleDuration = Date.now() - lastActivityTime;
        if (idleDuration >= idleTimeoutMs) {
          logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
            sessionDbId,
            idleDurationMs: idleDuration,
            thresholdMs: idleTimeoutMs
          });
          onIdleTimeout?.();
          return;
        }
      } else {
        lastActivityTime = Date.now();
      }
    }
  }

  /**
   * Claim further buffered messages, in FIFO order, for the batch a generator
   * is building (M4 observation batching).
   *
   * Walks the unclaimed messages oldest first and claims each one `accept`
   * says yes to, up to `max`. It stops at the FIRST message `accept` rejects
   * and never looks past it: a batch is always a contiguous run of the queue,
   * so a summarize request (or an observation from another prompt, agent or
   * directory) is never skipped over and answered out of order — it simply
   * ends the batch, and the drain yields it next.
   *
   * `accept` is called at most once per message, in queue order, and not at
   * all once the batch is full or a message has been rejected, so it may keep
   * running totals (a character budget) across calls.
   */
  claimContiguous(
    sessionDbId: number,
    accept: (message: PendingMessageWithId) => boolean,
    max: number,
  ): PendingMessageWithId[] {
    const claimed: PendingMessageWithId[] = [];
    const list = this.buffers.get(sessionDbId);
    if (!list || !(max > 0)) return claimed;

    for (const entry of list) {
      if (claimed.length >= max) break;
      // Already claimed: the batch being built (or an unconfirmed earlier
      // one). Claimed work is in flight, not waiting, so it neither joins nor
      // ends this batch.
      if (entry.claimed) continue;
      const view = this.toPendingWithId(entry);
      if (!accept(view)) break;
      entry.claimed = true;
      claimed.push(view);
    }

    if (claimed.length > 0) {
      this.onMutate?.();
    }
    return claimed;
  }

  /**
   * Wait until a message is enqueued for this session (true), or until the
   * signal aborts or `timeoutMs` passes (false). The batch linger's view of
   * the same wait the drain uses between messages.
   *
   * Unlike the private wait it wraps, an already-aborted signal or a
   * non-positive timeout answers false at once instead of sitting out the
   * whole timeout.
   */
  waitForNewMessage(sessionDbId: number, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (signal.aborted || !(timeoutMs > 0)) {
      return Promise.resolve(false);
    }
    return this.waitForMessage(sessionDbId, signal, timeoutMs);
  }

  private toPendingWithId(buffered: BufferedMessage): PendingMessageWithId {
    return {
      ...buffered.message,
      _persistentId: buffered.id,
      _originalTimestamp: buffered.enqueuedAt,
    };
  }

  private claimNext(sessionDbId: number): BufferedMessage | null {
    const list = this.buffers.get(sessionDbId);
    if (!list) return null;
    const next = list.find(m => !m.claimed);
    if (!next) return null;
    next.claimed = true;
    this.onMutate?.();
    return next;
  }

  private waitForMessage(sessionDbId: number, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const events = this.getEvents(sessionDbId);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      const onMessage = () => {
        cleanup();
        resolve(true);
      };
      const onAbort = () => {
        cleanup();
        resolve(false);
      };
      const onTimeout = () => {
        cleanup();
        resolve(false);
      };

      events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }

  private getList(sessionDbId: number): BufferedMessage[] {
    let list = this.buffers.get(sessionDbId);
    if (!list) {
      list = [];
      this.buffers.set(sessionDbId, list);
    }
    return list;
  }

  private getSeen(sessionDbId: number): Set<string> {
    let seen = this.seenToolUseIds.get(sessionDbId);
    if (!seen) {
      seen = new Set<string>();
      this.seenToolUseIds.set(sessionDbId, seen);
    }
    return seen;
  }

  private getEvents(sessionDbId: number): EventEmitter {
    let events = this.events.get(sessionDbId);
    if (!events) {
      events = new EventEmitter();
      this.events.set(sessionDbId, events);
    }
    return events;
  }

  private signal(sessionDbId: number): void {
    this.events.get(sessionDbId)?.emit('message');
  }
}
