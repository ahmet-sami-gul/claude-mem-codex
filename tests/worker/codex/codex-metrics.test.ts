/**
 * Codex observer counters (M4, plan 3.3 codex-metrics): what each exec was
 * for, what the cost levers saved, batching effectiveness, token totals —
 * counts only, never content.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import {
  CodexMetrics,
  startCodexMetricsReporter,
} from '../../../src/services/worker/codex/codex-metrics.js';

const T0 = Date.parse('2026-09-23T08:00:00.000Z');

const spies: Array<ReturnType<typeof spyOn>> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()!.mockRestore();
});

describe('CodexMetrics', () => {
  it('counts execs per call kind', () => {
    const metrics = new CodexMetrics({ now: () => T0 });
    metrics.recordExec('observation', 1);
    metrics.recordExec('observation', 3);
    metrics.recordExec('summary');
    metrics.recordExec('field_compression');
    metrics.recordExec('telegram_wrapup');
    metrics.recordExec('init');

    const snapshot = metrics.snapshot();
    expect(snapshot.execs).toBe(6);
    expect(snapshot.calls).toEqual({ init: 1, observation: 2, summary: 1, fieldCompression: 1, telegram: 1 });
    expect(snapshot.sinceMs).toBe(T0);
  });

  it('measures batching: observations per observation exec, the largest batch and the histogram', () => {
    const metrics = new CodexMetrics();
    metrics.recordExec('observation', 4);
    metrics.recordExec('observation', 4);
    metrics.recordExec('observation', 1);
    metrics.recordExec('observation', 15);
    // A summary carries no observations and does not dilute the ratio.
    metrics.recordExec('summary', 9);

    expect(metrics.snapshot().observations).toEqual({
      sent: 24,
      execs: 4,
      perExec: 6,
      maxPerExec: 15,
      batchSizes: { '1': 1, '4': 2, '12+': 1 },
    });
  });

  it('reads an observation exec with no stated count as one observation', () => {
    const metrics = new CodexMetrics();
    metrics.recordExec('observation');
    metrics.recordExec('observation', 0);
    expect(metrics.snapshot().observations).toMatchObject({ sent: 2, execs: 2, perExec: 1 });
    expect(new CodexMetrics().snapshot().observations.perExec).toBeNull();
  });

  it('counts the execs the levers saved, tokens, tool attempts and budget refusals', () => {
    const metrics = new CodexMetrics();
    metrics.recordInitSkipped();
    metrics.recordInitSkipped();
    metrics.recordFieldCompressionSkipped(2);
    metrics.recordFieldCompressionSkipped(0);
    metrics.recordUsage({ input: 9371, cached: 6912, output: 7, reasoning: 0 });
    metrics.recordUsage({ input: 100, cached: 0, output: 50, reasoning: 20 });
    metrics.recordUsage(null);
    metrics.recordToolAttempt();
    metrics.recordBudgetRefusal();
    metrics.recordBudgetRefusal();

    const snapshot = metrics.snapshot();
    expect(snapshot.skipped).toEqual({ init: 2, fieldCompression: 2 });
    expect(snapshot.tokens).toEqual({ input: 9471, cached: 6912, output: 57, reasoning: 20, turnsReported: 2 });
    expect(snapshot.toolAttempts).toBe(1);
    expect(snapshot.budgetRefusals).toBe(2);
  });

  it('counts the waiting observations the queue cap dropped', () => {
    const metrics = new CodexMetrics();
    expect(metrics.snapshot().queuedObservationsDropped).toBe(0);
    metrics.recordQueuedObservationsDropped(3);
    metrics.recordQueuedObservationsDropped(1);
    metrics.recordQueuedObservationsDropped(-2);
    metrics.recordQueuedObservationsDropped(Number.NaN);
    expect(metrics.snapshot().queuedObservationsDropped).toBe(4);
    metrics.reset();
    expect(metrics.snapshot().queuedObservationsDropped).toBe(0);
  });

  it('counts the subagent tool uses CLAUDE_MEM_SUBAGENT_EVENTS kept out of the observer', () => {
    const metrics = new CodexMetrics();
    expect(metrics.snapshot().subagentEventsSkipped).toBe(0);
    metrics.recordSubagentEventSkipped();
    metrics.recordSubagentEventSkipped();
    expect(metrics.snapshot().subagentEventsSkipped).toBe(2);
    metrics.reset();
    expect(metrics.snapshot().subagentEventsSkipped).toBe(0);
  });

  it('ignores garbage numbers rather than corrupting the totals', () => {
    const metrics = new CodexMetrics();
    metrics.recordUsage({ input: Number.NaN, cached: -4, output: Number.POSITIVE_INFINITY, reasoning: 2.9 });
    metrics.recordFieldCompressionSkipped(-3);
    expect(metrics.snapshot().tokens).toEqual({ input: 0, cached: 0, output: 0, reasoning: 2, turnsReported: 1 });
    expect(metrics.snapshot().skipped.fieldCompression).toBe(0);
  });

  it('hands out copies: a caller cannot change the counters through a snapshot', () => {
    const metrics = new CodexMetrics();
    metrics.recordExec('observation', 2);
    const snapshot = metrics.snapshot();
    snapshot.calls.observation = 99;
    snapshot.observations.batchSizes['2'] = 99;
    expect(metrics.snapshot().calls.observation).toBe(1);
    expect(metrics.snapshot().observations.batchSizes['2']).toBe(1);
  });

  it('holds numbers only — nothing a snapshot carries can be prompt content', () => {
    const metrics = new CodexMetrics();
    metrics.recordExec('observation', 2);
    metrics.recordUsage({ input: 1, cached: 1, output: 1, reasoning: 1 });
    const leaves: unknown[] = [];
    const walk = (value: unknown): void => {
      if (value && typeof value === 'object') Object.values(value).forEach(walk);
      else leaves.push(value);
    };
    walk(metrics.snapshot());
    expect(leaves.every(leaf => typeof leaf === 'number')).toBe(true);
  });

  it('reset starts a fresh count', () => {
    let now = T0;
    const metrics = new CodexMetrics({ now: () => now });
    metrics.recordExec('summary');
    now = T0 + 1000;
    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({ sinceMs: T0 + 1000, execs: 0 });
  });
});

describe('startCodexMetricsReporter', () => {
  function manualInterval() {
    let callback: (() => void) | null = null;
    let cleared = false;
    return {
      setInterval: (cb: () => void) => { callback = cb; return 1; },
      clearInterval: () => { cleared = true; },
      tick: () => callback?.(),
      get cleared() { return cleared; },
    };
  }

  it('logs periodically, only when something changed, and stops cleanly', () => {
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    spies.push(info);
    const metrics = new CodexMetrics({ now: () => T0 });
    const timer = manualInterval();
    const reporter = startCodexMetricsReporter({ metrics, intervalMs: 1000, ...timer });

    // Nothing happened yet: an idle worker (or another provider) stays quiet.
    timer.tick();
    expect(info).not.toHaveBeenCalled();

    metrics.recordExec('observation', 3);
    metrics.recordUsage({ input: 10, cached: 5, output: 2, reasoning: 0 });
    timer.tick();
    expect(info).toHaveBeenCalledTimes(1);
    const [component, message, fields] = info.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(component).toBe('SDK');
    expect(message).toBe('Codex observer usage');
    expect(fields).toMatchObject({ execs: 1, observationsPerExec: 3, tokens: { input: 10, cached: 5, output: 2, reasoning: 0, turnsReported: 1 } });

    // Unchanged since the last line: no repeat.
    timer.tick();
    expect(info).toHaveBeenCalledTimes(1);

    metrics.recordBudgetRefusal();
    timer.tick();
    expect(info).toHaveBeenCalledTimes(2);

    reporter.stop();
    reporter.stop();
    expect(timer.cleared).toBe(true);
  });

  it('logs at once on the first report when there is already something to say', () => {
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    spies.push(info);
    const metrics = new CodexMetrics();
    metrics.recordInitSkipped();
    const reporter = startCodexMetricsReporter({ metrics, ...manualInterval() });
    expect(reporter.report()).toBe(true);
    expect(reporter.report()).toBe(false);
    reporter.stop();
  });

  it('reports queue-cap drops even when no exec has run (a paused observer)', () => {
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    spies.push(info);
    const metrics = new CodexMetrics();
    metrics.recordQueuedObservationsDropped(7);
    const reporter = startCodexMetricsReporter({ metrics, ...manualInterval() });
    expect(reporter.report()).toBe(true);
    const [, , fields] = info.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(fields).toMatchObject({ execs: 0, queuedObservationsDropped: 7 });
    reporter.stop();
  });

  it('reports skipped subagent tool uses even when no exec has run', () => {
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    spies.push(info);
    const metrics = new CodexMetrics();
    metrics.recordSubagentEventSkipped();
    const reporter = startCodexMetricsReporter({ metrics, ...manualInterval() });
    expect(reporter.report()).toBe(true);
    const [, , fields] = info.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(fields).toMatchObject({ execs: 0, subagentEventsSkipped: 1 });
    reporter.stop();
  });
});
