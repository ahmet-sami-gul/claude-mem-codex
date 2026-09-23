/**
 * The observer's own jail is never observed (M4, plan 3.10).
 *
 * Every ingest path — the PostToolUse route and the transcript processor's
 * direct call — funnels through ingestObservation. A tool event whose cwd is
 * OBSERVER_SESSIONS_DIR or anything under it is the memory observer's own
 * activity (the Claude SDK observer, or a `codex exec` in its per-session
 * jail); recording it would be the observer observing itself, and on Codex
 * every such observation would cost another paid exec. It is skipped before
 * anything is created, stored or queued. The check is the same `isWithin`
 * logic the hooks use (shouldTrackProject).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { DATA_DIR, OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { isObserverSessionCwd, shouldTrackProject } from '../../src/shared/should-track-project.js';
import { logger } from '../../src/utils/logger.js';

describe('ingestObservation — the observer session guard', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: unknown }>;
  let ensureGeneratorRunning: ReturnType<typeof mock>;
  let createSession: ReturnType<typeof spyOn>;
  let spies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];
    queued = [];
    store = new SessionStore(new Database(':memory:'));
    createSession = spyOn(store, 'createSDKSession');
    ensureGeneratorRunning = mock(async () => {});
    setIngestContext({
      sessionManager: {
        queueObservation: async (sessionDbId: number, data: unknown) => {
          queued.push({ sessionDbId, data });
        },
      } as never,
      dbManager: { getSessionStore: () => store } as never,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as never,
      ensureGeneratorRunning,
    });
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    createSession.mockRestore();
    store?.close();
    store = undefined;
  });

  const payload = (cwd: string) => ({
    contentSessionId: 'content-guard-1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolResponse: { stdout: 'a' },
    cwd,
    toolUseId: `toolu_${Math.random().toString(36).slice(2)}`,
  });

  it('skips an event from a codex jail before creating, storing or queueing anything', async () => {
    const result = await ingestObservation(payload(join(OBSERVER_SESSIONS_DIR, '4127')));

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'observer_session' });
    expect(createSession).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();
    expect(store!.queryToolUses({})).toHaveLength(0);
  });

  it('skips the observer sessions directory itself and anything nested under it', async () => {
    for (const cwd of [
      OBSERVER_SESSIONS_DIR,
      join(OBSERVER_SESSIONS_DIR, 'codex-selfcheck'),
      join(OBSERVER_SESSIONS_DIR, '12', 'deeper'),
      `${OBSERVER_SESSIONS_DIR}/a/../b`,
    ]) {
      expect(await ingestObservation(payload(cwd))).toEqual({ ok: true, status: 'skipped', reason: 'observer_session' });
    }
    expect(queued).toHaveLength(0);
  });

  it('still ingests the user\'s own work, including look-alike paths outside the jail', async () => {
    for (const cwd of [
      '/workspace/claude-mem',
      DATA_DIR,
      `${OBSERVER_SESSIONS_DIR}-archive`,
      `${OBSERVER_SESSIONS_DIR}/../project`,
    ]) {
      const result = await ingestObservation(payload(cwd));
      expect(result.ok).toBe(true);
      expect('status' in result && result.status === 'skipped' && result.reason === 'observer_session').toBe(false);
    }
    expect(queued).toHaveLength(4);
  });

  it('agrees with the hooks: the same paths shouldTrackProject refuses', () => {
    const jail = join(OBSERVER_SESSIONS_DIR, '9');
    expect(isObserverSessionCwd(jail)).toBe(true);
    expect(shouldTrackProject(jail)).toBe(false);
    expect(isObserverSessionCwd('')).toBe(false);
    expect(isObserverSessionCwd('/workspace/claude-mem')).toBe(false);
  });

  it('covers the transcript processor, which calls ingestObservation directly', async () => {
    const schema: TranscriptSchema = {
      name: 'guard-schema',
      events: [{
        name: 'tool-result',
        match: { path: 'role', equals: 'tool' },
        action: 'tool_result',
        fields: {
          sessionId: { value: 'transcript-session-guard' },
          toolId: 'message.toolUseId',
          toolName: 'message.name',
          toolResponse: 'message.content',
        },
      }],
    };
    const watch = (workspace: string): WatchTarget => ({
      name: 'guard-watch',
      path: join(DATA_DIR, 'transcripts', '*.jsonl'),
      schema: 'guard-schema',
      workspace,
    });
    const entry = { role: 'tool', message: { toolUseId: 'toolu_t1', name: 'Read', content: 'ok' } };

    await new TranscriptEventProcessor().processEntry(entry, watch(join(OBSERVER_SESSIONS_DIR, '55')), schema);
    expect(queued).toHaveLength(0);
    expect(createSession).not.toHaveBeenCalled();

    // The same event from the user's workspace is ingested.
    await new TranscriptEventProcessor().processEntry(entry, watch('/workspace/project'), schema);
    expect(queued).toHaveLength(1);
  });
});
