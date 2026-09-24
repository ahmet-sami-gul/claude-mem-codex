/**
 * CLAUDE_MEM_SUBAGENT_EVENTS at the one ingest choke point.
 *
 * Most captured tool uses come from subagents, and most of those are reads
 * and searches that each cost the observer a call. The setting decides which
 * subagent tool uses (an event with a non-empty agentId) reach the observer:
 * `all` (default, unchanged behaviour), `writes` (Edit / Write / MultiEdit /
 * NotebookEdit only) or `none`. Main-session events are never filtered.
 *
 * A filtered event is still written raw to the durable `tool_uses` index, but
 * it is never queued, never starts a generator and is never broadcast. The
 * checks that already ran before the dual-write keep their order.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  SUBAGENT_WRITE_TOOLS,
  ingestObservation,
  resolveSubagentEventsMode,
  setIngestContext,
} from '../../src/services/worker/http/shared.js';
import { codexMetrics } from '../../src/services/worker/codex/codex-metrics.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { DATA_DIR } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';

const SKIP_MESSAGE = 'Subagent tool use kept out of the observer (CLAUDE_MEM_SUBAGENT_EVENTS)';

describe('ingestObservation — CLAUDE_MEM_SUBAGENT_EVENTS', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: any }>;
  let ensureGeneratorRunning: ReturnType<typeof mock>;
  let broadcastObservationQueued: ReturnType<typeof mock>;
  let debug: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let spies: Array<ReturnType<typeof spyOn>> = [];
  let settingsSpy: ReturnType<typeof spyOn> | undefined;
  let priorEnv: string | undefined;
  let toolUseSeq = 0;

  beforeEach(() => {
    debug = spyOn(logger, 'debug').mockImplementation(() => {});
    info = spyOn(logger, 'info').mockImplementation(() => {});
    warn = spyOn(logger, 'warn').mockImplementation(() => {});
    spies = [
      debug,
      info,
      warn,
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];
    // The environment wins over the file; keep a developer's shell out of it.
    priorEnv = process.env.CLAUDE_MEM_SUBAGENT_EVENTS;
    delete process.env.CLAUDE_MEM_SUBAGENT_EVENTS;

    queued = [];
    store = new SessionStore(new Database(':memory:'));
    ensureGeneratorRunning = mock(async () => {});
    broadcastObservationQueued = mock(() => {});
    setIngestContext({
      sessionManager: {
        queueObservation: async (sessionDbId: number, data: any) => {
          queued.push({ sessionDbId, data });
        },
      } as never,
      dbManager: { getSessionStore: () => store } as never,
      eventBroadcaster: { broadcastObservationQueued } as never,
      ensureGeneratorRunning,
    });
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    settingsSpy?.mockRestore();
    settingsSpy = undefined;
    if (priorEnv === undefined) delete process.env.CLAUDE_MEM_SUBAGENT_EVENTS;
    else process.env.CLAUDE_MEM_SUBAGENT_EVENTS = priorEnv;
    store?.close();
    store = undefined;
  });

  /** settings.json as ingest reads it, with the given CLAUDE_MEM_SUBAGENT_EVENTS (undefined = key absent). */
  function useSetting(value: unknown): void {
    settingsSpy?.mockRestore();
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
      CLAUDE_MEM_SUBAGENT_EVENTS: value as string,
    }) as SettingsDefaults);
  }

  const subagent = (toolName: string, overrides: Record<string, unknown> = {}) => ({
    contentSessionId: 'content-subagent-1',
    toolName,
    toolInput: { file_path: '/workspace/project/a.ts', command: 'git status' },
    toolResponse: { ok: true },
    cwd: '/workspace/project',
    agentId: 'agent-7f3a',
    agentType: 'general-purpose',
    toolUseId: `toolu_sub_${++toolUseSeq}`,
    ...overrides,
  });

  const mainSession = (toolName: string) => subagent(toolName, { agentId: undefined, agentType: undefined });

  const skipped = { ok: true, status: 'skipped', reason: 'subagent_filtered' };

  it("'all' (the default) sends every subagent tool use, exactly as before", async () => {
    for (const value of [undefined, '', 'all']) {
      useSetting(value);
      const result = await ingestObservation(subagent('Bash'));
      expect(result).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    }
    expect(queued).toHaveLength(3);
    expect(queued[0].data).toMatchObject({ tool_name: 'Bash', agentId: 'agent-7f3a', agentType: 'general-purpose' });
    expect(ensureGeneratorRunning).toHaveBeenCalledTimes(3);
    expect(broadcastObservationQueued).toHaveBeenCalledTimes(3);
    expect(debug.mock.calls.some(call => call[1] === SKIP_MESSAGE)).toBe(false);
  });

  it('never filters main-session tool uses, whatever the mode', async () => {
    for (const mode of ['writes', 'none']) {
      useSetting(mode);
      for (const toolName of ['Bash', 'Read', 'WebFetch', 'Edit']) {
        const result = await ingestObservation(mainSession(toolName));
        expect(result).toEqual({ ok: true, sessionDbId: expect.any(Number) });
      }
      // An empty agentId is not a subagent either.
      expect(await ingestObservation(subagent('Bash', { agentId: '' }))).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    }
    expect(queued).toHaveLength(10);
    expect(ensureGeneratorRunning).toHaveBeenCalledTimes(10);
  });

  it("'writes' keeps a subagent's Edit, Write, MultiEdit and NotebookEdit", async () => {
    useSetting('writes');
    expect([...SUBAGENT_WRITE_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

    for (const toolName of SUBAGENT_WRITE_TOOLS) {
      const result = await ingestObservation(subagent(toolName));
      expect(result).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    }
    expect(queued.map(entry => entry.data.tool_name)).toEqual([...SUBAGENT_WRITE_TOOLS]);
  });

  it("'writes' skips every other subagent tool use, Bash (git commit included) and WebFetch among them", async () => {
    useSetting('writes');
    for (const toolName of ['Bash', 'WebFetch', 'Read', 'Grep', 'Glob', 'mcp__notion__search']) {
      expect(await ingestObservation(subagent(toolName))).toEqual(skipped);
    }
    expect(await ingestObservation(subagent('Bash', { toolInput: { command: 'git commit -m "fix"' } }))).toEqual(skipped);
    expect(queued).toHaveLength(0);
  });

  it("'none' skips every subagent tool use, file writes included", async () => {
    useSetting('none');
    for (const toolName of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read']) {
      expect(await ingestObservation(subagent(toolName))).toEqual(skipped);
    }
    expect(queued).toHaveLength(0);
  });

  it('keeps a skipped tool use in tool_uses, but never queues, starts a generator or broadcasts it', async () => {
    useSetting('writes');
    const result = await ingestObservation(subagent('Bash', {
      toolUseId: 'toolu_sub_kept',
      toolInput: { command: 'git commit -m "fix"' },
      toolResponse: { stdout: '[main abc123] fix' },
    }));

    expect(result).toEqual(skipped);
    expect(queued).toHaveLength(0);
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();
    expect(broadcastObservationQueued).not.toHaveBeenCalled();

    const rows = store!.queryToolUses({ contentSessionId: 'content-subagent-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_use_id: 'toolu_sub_kept',
      tool_name: 'Bash',
      agent_id: 'agent-7f3a',
      agent_type: 'general-purpose',
      observation_id: null,
    });
    expect(JSON.parse(rows[0].tool_input!)).toEqual({ command: 'git commit -m "fix"' });
    expect(JSON.parse(rows[0].tool_response!)).toEqual({ stdout: '[main abc123] fix' });
  });

  it('counts each skip in codexMetrics.subagentEventsSkipped and logs it at debug only', async () => {
    useSetting('writes');
    const before = codexMetrics.snapshot().subagentEventsSkipped;

    await ingestObservation(subagent('Bash'));
    await ingestObservation(subagent('WebFetch'));
    await ingestObservation(subagent('Edit'));        // kept: not counted
    await ingestObservation(mainSession('Bash'));     // main session: not counted

    expect(codexMetrics.snapshot().subagentEventsSkipped - before).toBe(2);
    const skipLogs = debug.mock.calls.filter(call => call[1] === SKIP_MESSAGE);
    expect(skipLogs).toHaveLength(2);
    expect(skipLogs[0][0]).toBe('INGEST');
    expect(skipLogs[0][2]).toMatchObject({ toolName: 'Bash', agentType: 'general-purpose', mode: 'writes' });
    // No per-event info/warn line about it (other, unrelated warnings may fire).
    const aboutSubagents = (spy: ReturnType<typeof spyOn>) =>
      spy.mock.calls.filter(call => /subagent/i.test(String(call[1])));
    expect(aboutSubagents(warn)).toHaveLength(0);
    expect(aboutSubagents(info)).toHaveLength(0);
  });

  it('reads an invalid value as all, with one warning per distinct value', async () => {
    const invalid = `reads-only-${toolUseSeq}`;
    useSetting(invalid);

    expect(await ingestObservation(subagent('Bash'))).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    expect(await ingestObservation(subagent('Read'))).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    expect(queued).toHaveLength(2);

    const warnings = warn.mock.calls.filter(call => String(call[1]).includes('CLAUDE_MEM_SUBAGENT_EVENTS'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toBe('INGEST');
    expect(warnings[0][1]).toBe('Invalid CLAUDE_MEM_SUBAGENT_EVENTS; using all instead');
    expect(warnings[0][2]).toEqual({ configured: invalid });
  });

  it('reads a JSON non-string from a hand-edited file as all instead of throwing', async () => {
    useSetting(7700 + toolUseSeq);
    expect(await ingestObservation(subagent('Bash'))).toEqual({ ok: true, sessionDbId: expect.any(Number) });
    expect(queued).toHaveLength(1);
    expect(warn.mock.calls.filter(call => String(call[1]).includes('CLAUDE_MEM_SUBAGENT_EVENTS'))).toHaveLength(1);
  });

  it('resolves the mode leniently: trimmed, case-insensitive, empty means all', () => {
    expect(resolveSubagentEventsMode(' Writes ')).toBe('writes');
    expect(resolveSubagentEventsMode('NONE')).toBe('none');
    expect(resolveSubagentEventsMode('all')).toBe('all');
    expect(resolveSubagentEventsMode('')).toBe('all');
    expect(resolveSubagentEventsMode('   ')).toBe('all');
    expect(resolveSubagentEventsMode(undefined)).toBe('all');
    expect(resolveSubagentEventsMode(null)).toBe('all');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is read from the environment too (file/env)', async () => {
    // No stub: the real loader, with the worker environment over the file.
    process.env.CLAUDE_MEM_SUBAGENT_EVENTS = 'none';
    expect(await ingestObservation(subagent('Edit'))).toEqual(skipped);
    expect(queued).toHaveLength(0);
  });

  it('leaves the earlier checks in front: a skipped tool is refused before anything is stored', async () => {
    useSetting('none');
    const result = await ingestObservation(subagent('TodoWrite'));

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(store!.queryToolUses({})).toHaveLength(0);
  });

  it('covers the transcript processor, which calls ingestObservation directly', async () => {
    useSetting('writes');
    const schema: TranscriptSchema = {
      name: 'subagent-events-schema',
      events: [{
        name: 'tool-result',
        match: { path: 'role', equals: 'tool' },
        action: 'tool_result',
        fields: {
          sessionId: { value: 'transcript-session-subagent' },
          toolId: 'message.toolUseId',
          toolName: 'message.name',
          toolResponse: 'message.content',
        },
      }],
    };
    const watch = (agentId?: string): WatchTarget => ({
      name: 'subagent-events-watch',
      path: join(DATA_DIR, 'transcripts', '*.jsonl'),
      schema: 'subagent-events-schema',
      workspace: '/workspace/project',
      agentId,
    });
    const entry = (toolUseId: string, name: string) => ({ role: 'tool', message: { toolUseId, name, content: 'ok' } });

    // A watch with an agent identity is filtered like any other agent event...
    await new TranscriptEventProcessor().processEntry(entry('toolu_t1', 'Read'), watch('521e962d-2ec3-4488-bfbc-54d5209ce118'), schema);
    expect(queued).toHaveLength(0);
    expect(store!.queryToolUses({ contentSessionId: 'transcript-session-subagent' })).toHaveLength(1);

    // ...its file writes still go through...
    await new TranscriptEventProcessor().processEntry(entry('toolu_t2', 'Edit'), watch('521e962d-2ec3-4488-bfbc-54d5209ce118'), schema);
    expect(queued).toHaveLength(1);

    // ...and a watch without one is a main session.
    await new TranscriptEventProcessor().processEntry(entry('toolu_t3', 'Read'), watch(undefined), schema);
    expect(queued).toHaveLength(2);
  });
});
