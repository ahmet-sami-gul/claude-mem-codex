/**
 * SessionManager.listSessionIdsWithPendingWork (M3, plan 3.5).
 *
 * The resume scheduler's only view of "who is waiting": live sessions whose
 * in-RAM buffer holds work that no generator is draining.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

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

async function queue(sm: SessionManager, sessionDbId: number, toolUseId: string): Promise<void> {
  await sm.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId,
  });
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('SessionManager.listSessionIdsWithPendingWork', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
  });

  it('lists only sessions with buffered work and no generator draining it, oldest first', async () => {
    const sm = new SessionManager(makeDbManager());
    sm.initializeSession(1, 'prompt', 1);
    sm.initializeSession(2, 'prompt', 1);
    sm.initializeSession(3, 'prompt', 1);
    sm.initializeSession(4, 'prompt', 1);

    await queue(sm, 3, 'tu-3');
    await queue(sm, 1, 'tu-1');
    await queue(sm, 4, 'tu-4');
    // Session 4 has a live generator: it is already draining its own buffer.
    sm.getSession(4)!.generatorPromise = new Promise<void>(() => {});

    // Session 2 has nothing buffered.
    expect(sm.listSessionIdsWithPendingWork()).toEqual([1, 3]);
  });

  it('counts claimed-but-unconfirmed work as still waiting', async () => {
    const sm = new SessionManager(makeDbManager());
    await queue(sm, 5, 'tu-5');

    const iterator = sm.getMessageIterator(5);
    const claimed = await iterator.next();
    expect(claimed.done).toBe(false);
    await iterator.return?.();

    // A pause resets the claim to pending on the next start; until then the
    // message is still in the buffer and still needs a generator.
    expect(sm.listSessionIdsWithPendingWork()).toEqual([5]);
  });

  it('forgets a session once it is removed', async () => {
    const sm = new SessionManager(makeDbManager());
    await queue(sm, 6, 'tu-6');
    sm.removeSessionImmediate(6);

    expect(sm.listSessionIdsWithPendingWork()).toEqual([]);
  });
});
