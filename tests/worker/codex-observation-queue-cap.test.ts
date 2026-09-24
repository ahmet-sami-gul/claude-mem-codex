/**
 * The codex observation queue cap (CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS).
 *
 * The buffer is RAM-only and, before this cap, unbounded: on 2026-09-24 about
 * 3,140 events piled up during a pause — hundreds to thousands of plan
 * messages had they been sent. Pinned here: the resolver (codex only, 0 turns
 * it off, bad values clamp or fall back with one warning, 1-49 is raised to
 * 50), the short cache in front of it, and SessionManager's enforcement (the
 * OLDEST unclaimed observations go; claimed work and summarize requests never
 * do; the metric and the throttled warning).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import {
  CODEX_CONFIG_BOUNDS,
  CODEX_QUEUE_CAP_CACHE_MS,
  codexObservationQueueCapReader,
  resetCodexConfigWarnings,
  resolveCodexObservationQueueCap,
} from '../../src/services/worker/CodexProvider.js';
import { CodexMetrics } from '../../src/services/worker/codex/codex-metrics.js';
import { QUEUE_CAP_WARN_EVERY, SessionManager } from '../../src/services/worker/SessionManager.js';
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

let toolCounter = 0;
function obsData(name: string): ObservationData {
  toolCounter++;
  return {
    tool_name: name,
    tool_input: { n: toolCounter },
    tool_response: { ok: true },
    prompt_number: 1,
    cwd: '/repo',
    toolUseId: `cap-tu-${toolCounter}`,
  };
}

let settings: SettingsDefaults;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_PROVIDER: 'codex',
    CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS: '500',
  };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
  warn = spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  resetCodexConfigWarnings();
});

describe('resolveCodexObservationQueueCap', () => {
  it('defaults to 500 while codex is the provider', () => {
    expect(CODEX_CONFIG_BOUNDS.maxQueuedObservations.fallback).toBe(500);
    expect(resolveCodexObservationQueueCap()).toBe(500);
    settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS = '';
    expect(resolveCodexObservationQueueCap()).toBe(500);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['claude', 'gemini', 'openrouter', ''])('is off (0) while the provider is %p, whatever the setting', provider => {
    settings.CLAUDE_MEM_PROVIDER = provider;
    settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS = '50';
    expect(resolveCodexObservationQueueCap()).toBe(0);
  });

  it.each([
    ['0', 0],
    ['50', 50],
    [' 300 ', 300],
    ['100000', 100_000],
  ])('uses the valid value %p as %p, without a warning', (raw, cap) => {
    settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS = raw;
    expect(resolveCodexObservationQueueCap()).toBe(cap);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['10', 50],
    ['1', 50],
    ['49', 50],
    ['-5', 0],
    ['250000', 100_000],
    ['abc', 500],
    ['12.5', 500],
    [300, 500],
  ] as const)('reads the invalid value %p as %p and warns once', (raw, cap) => {
    settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS = raw as unknown as string;
    expect(resolveCodexObservationQueueCap()).toBe(cap);
    expect(resolveCodexObservationQueueCap()).toBe(cap);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS');
  });
});

describe('codexObservationQueueCapReader', () => {
  it('re-reads the setting at most once per ttl', () => {
    let now = 1_000;
    let reads = 0;
    let cap = 500;
    const read = codexObservationQueueCapReader(5_000, () => { reads++; return cap; }, () => now);

    expect(read()).toBe(500);
    cap = 50;
    now += 4_999;
    expect(read()).toBe(500);
    expect(reads).toBe(1);
    now += 1;
    expect(read()).toBe(50);
    expect(reads).toBe(2);
  });

  it('defaults to a few seconds over the live settings', () => {
    expect(CODEX_QUEUE_CAP_CACHE_MS).toBe(5_000);
    const read = codexObservationQueueCapReader();
    expect(read()).toBe(500);
    settings.CLAUDE_MEM_PROVIDER = 'claude';
    // Still the cached answer: no settings read per enqueue.
    expect(read()).toBe(500);
  });
});

describe('SessionManager observation queue cap', () => {
  const SESSION = 1;
  let sm: SessionManager;
  let metrics: CodexMetrics;

  beforeEach(() => {
    sm = new SessionManager(makeDbManager());
    sm.initializeSession(SESSION, 'prompt', 1);
    metrics = new CodexMetrics();
  });

  afterEach(() => {
    sm.getSession(SESSION)?.abortController.abort();
  });

  function queuedNames(sessionDbId = SESSION): string[] {
    return sm.getMessageBuffer().peekTypes(sessionDbId).map(m => m.tool_name ?? m.message_type);
  }

  async function claimHead(): Promise<PendingMessageWithId> {
    const next = await sm.getMessageIterator(SESSION).next();
    if (next.done) throw new Error('nothing queued');
    return next.value;
  }

  it('has no cap until one is installed', async () => {
    for (let i = 0; i < 60; i++) await sm.queueObservation(SESSION, obsData(`O${i}`));
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(60);
  });

  it('drops the oldest unclaimed observations, never the claimed one or a summarize request', async () => {
    sm.setObservationQueueCap(() => 3, metrics);
    await sm.queueObservation(SESSION, obsData('A'));
    const head = await claimHead();
    expect(head.tool_name).toBe('A');
    await sm.queueObservation(SESSION, obsData('B'));
    await sm.queueSummarize(SESSION, 'done');
    for (const name of ['C', 'D', 'E', 'F']) await sm.queueObservation(SESSION, obsData(name));

    // A is in flight; B and C were the oldest waiting observations.
    expect(queuedNames()).toEqual(['A', 'summarize', 'D', 'E', 'F']);
    expect(sm.getSession(SESSION)!.claimedMessageIds).toEqual([head._persistentId]);
    expect(metrics.snapshot().queuedObservationsDropped).toBe(2);
  });

  it('drops nothing while the cap is 0', async () => {
    sm.setObservationQueueCap(() => 0, metrics);
    for (let i = 0; i < 10; i++) await sm.queueObservation(SESSION, obsData(`O${i}`));
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(10);
    expect(metrics.snapshot().queuedObservationsDropped).toBe(0);
  });

  it('keeps a dropped tool use out when its hook reports it again', async () => {
    sm.setObservationQueueCap(() => 1, metrics);
    const dropped = obsData('A');
    await sm.queueObservation(SESSION, dropped);
    await sm.queueObservation(SESSION, obsData('B'));
    expect(queuedNames()).toEqual(['B']);
    await sm.queueObservation(SESSION, dropped);
    expect(queuedNames()).toEqual(['B']);
    expect(metrics.snapshot().queuedObservationsDropped).toBe(1);
  });

  it('warns the first time a session drops, then once per 100 drops, per session', async () => {
    sm.setObservationQueueCap(() => 1, metrics);
    for (let i = 0; i < 251; i++) await sm.queueObservation(SESSION, obsData(`O${i}`));

    // 250 dropped: warnings at the 1st, 100th and 200th.
    expect(QUEUE_CAP_WARN_EVERY).toBe(100);
    expect(metrics.snapshot().queuedObservationsDropped).toBe(250);
    const capWarnings = () => warn.mock.calls.filter(call => String(call[1]).startsWith('CAP_DROPPED'));
    expect(capWarnings().map(call => (call[2] as { droppedTotal: number }).droppedTotal)).toEqual([1, 100, 200]);
    expect(capWarnings()[0][2]).toEqual({ sessionId: SESSION, droppedTotal: 1, cap: 1 });

    // Another session starts its own count.
    sm.initializeSession(2, 'prompt', 1);
    await sm.queueObservation(2, obsData('X'));
    await sm.queueObservation(2, obsData('Y'));
    expect(capWarnings()).toHaveLength(4);
    expect(capWarnings()[3][2]).toEqual({ sessionId: 2, droppedTotal: 1, cap: 1 });
    sm.getSession(2)?.abortController.abort();
  });

  it('applies only while codex is the provider (the worker wiring)', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS = '50';
    sm.setObservationQueueCap(codexObservationQueueCapReader(0), metrics);

    settings.CLAUDE_MEM_PROVIDER = 'claude';
    for (let i = 0; i < 60; i++) await sm.queueObservation(SESSION, obsData(`O${i}`));
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(60);

    settings.CLAUDE_MEM_PROVIDER = 'codex';
    await sm.queueObservation(SESSION, obsData('next'));
    expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(50);
    expect(queuedNames().at(-1)).toBe('next');
    expect(metrics.snapshot().queuedObservationsDropped).toBe(11);
  });
});
