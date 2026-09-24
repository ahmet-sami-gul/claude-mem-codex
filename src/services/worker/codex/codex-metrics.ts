/**
 * Codex observer counters (M4, plan 3.3 "codex-metrics").
 *
 * What the cost levers actually buy, measured in the two units a ChatGPT plan
 * can meter — messages (one per `codex exec`) and tokens — so the canary run
 * (M5) and a user watching their allowance can see it without reading logs:
 *
 *   - execs per call kind, counted when a process is spawned (the transport's
 *     `onSpawned`), so they are exactly the plan messages spent;
 *   - the execs the M4 levers avoided: init calls deferred into the first real
 *     call, and oversized fields that went to the prompt's head/tail
 *     truncation instead of a compression exec — each booked when the exec
 *     that carried it is spawned, so a call refused before any exec (quota
 *     circuit, local budget) and a turn rebuilt after a pause count nothing;
 *   - observations per observation exec (batching effectiveness), with the
 *     batch-size histogram;
 *   - input / cached-input / output / reasoning token totals from
 *     `turn.completed.usage`;
 *   - forbidden-tool attempts seen by the runner's guard, and calls the local
 *     5-hour budget refused;
 *   - waiting observations the queue cap dropped
 *     (CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS, SessionManager).
 *
 * Counts only: no prompt, reply, tool payload, session id or project name ever
 * reaches this module. The counters are process-lifetime and in memory (the
 * durable per-exec record is codex-usage.json, codex-budget.ts); they are
 * exposed on /api/health (`ai.codex.metrics`) and logged periodically by
 * `startCodexMetricsReporter` when they changed.
 */

import { logger } from '../../../utils/logger.js';
import type { CodexCallPurpose, CodexUsage } from './codex-transport.js';

/** Default interval of the periodic metrics log line. */
export const CODEX_METRICS_REPORT_INTERVAL_MS = 15 * 60_000;

/** Batch sizes above this share the last histogram bucket ("12+"). */
const MAX_BATCH_BUCKET = 12;

export interface CodexMetricsSnapshot {
  /** When counting started (worker start, or the last reset). */
  sinceMs: number;
  /** Every spawned exec, i.e. plan messages spent. */
  execs: number;
  /** Spawned execs per call kind. */
  calls: {
    init: number;
    observation: number;
    summary: number;
    fieldCompression: number;
    telegram: number;
  };
  /** Execs the M4 levers avoided, booked when the exec carrying the saving is spawned. */
  skipped: {
    /** Generator starts whose init turn rode along with the first real call instead of costing its own exec. */
    init: number;
    /** Oversized fields sent through the prompt's truncation instead of a compression exec. */
    fieldCompression: number;
  };
  /** Batching effectiveness, over observation execs only. */
  observations: {
    sent: number;
    execs: number;
    /** sent / execs, or null before the first observation exec. */
    perExec: number | null;
    maxPerExec: number;
    /** Observation execs by batch size; "12+" collects anything larger. */
    batchSizes: Record<string, number>;
  };
  /** Totals from turn.completed.usage, over the execs that reported it. */
  tokens: { input: number; cached: number; output: number; reasoning: number; turnsReported: number };
  /** Forbidden-tool attempts the runner's guard killed. */
  toolAttempts: number;
  /** Calls the local 5-hour exec budget refused (no exec spawned). */
  budgetRefusals: number;
  /** Waiting observations dropped by CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS (never sent). */
  queuedObservationsDropped: number;
}

function purposeKey(purpose: CodexCallPurpose): keyof CodexMetricsSnapshot['calls'] {
  switch (purpose) {
    case 'init': return 'init';
    case 'summary': return 'summary';
    case 'field_compression': return 'fieldCompression';
    case 'telegram_wrapup': return 'telegram';
    default: return 'observation';
  }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export class CodexMetrics {
  private readonly now: () => number;
  private state: CodexMetricsSnapshot;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.state = this.empty();
  }

  /**
   * One spawned exec. `observations` is how many tool uses an observation
   * exec carried (1 without batching); ignored for the other kinds.
   */
  recordExec(purpose: CodexCallPurpose, observations = 0): void {
    this.state.execs += 1;
    this.state.calls[purposeKey(purpose)] += 1;
    if (purposeKey(purpose) !== 'observation') return;
    const count = Math.max(1, safeCount(observations));
    const obs = this.state.observations;
    obs.execs += 1;
    obs.sent += count;
    obs.maxPerExec = Math.max(obs.maxPerExec, count);
    const bucket = count > MAX_BATCH_BUCKET ? `${MAX_BATCH_BUCKET}+` : String(count);
    obs.batchSizes[bucket] = (obs.batchSizes[bucket] ?? 0) + 1;
  }

  recordInitSkipped(): void {
    this.state.skipped.init += 1;
  }

  recordFieldCompressionSkipped(fields: number): void {
    this.state.skipped.fieldCompression += safeCount(fields);
  }

  recordUsage(usage: CodexUsage | null | undefined): void {
    if (!usage) return;
    const tokens = this.state.tokens;
    tokens.input += safeCount(usage.input);
    tokens.cached += safeCount(usage.cached);
    tokens.output += safeCount(usage.output);
    tokens.reasoning += safeCount(usage.reasoning);
    tokens.turnsReported += 1;
  }

  recordToolAttempt(): void {
    this.state.toolAttempts += 1;
  }

  recordBudgetRefusal(): void {
    this.state.budgetRefusals += 1;
  }

  recordQueuedObservationsDropped(count: number): void {
    this.state.queuedObservationsDropped += safeCount(count);
  }

  snapshot(): CodexMetricsSnapshot {
    const s = this.state;
    return {
      sinceMs: s.sinceMs,
      execs: s.execs,
      calls: { ...s.calls },
      skipped: { ...s.skipped },
      observations: {
        ...s.observations,
        perExec: s.observations.execs > 0
          ? Math.round((s.observations.sent / s.observations.execs) * 100) / 100
          : null,
        batchSizes: { ...s.observations.batchSizes },
      },
      tokens: { ...s.tokens },
      toolAttempts: s.toolAttempts,
      budgetRefusals: s.budgetRefusals,
      queuedObservationsDropped: s.queuedObservationsDropped,
    };
  }

  reset(): void {
    this.state = this.empty();
  }

  private empty(): CodexMetricsSnapshot {
    return {
      sinceMs: this.now(),
      execs: 0,
      calls: { init: 0, observation: 0, summary: 0, fieldCompression: 0, telegram: 0 },
      skipped: { init: 0, fieldCompression: 0 },
      observations: { sent: 0, execs: 0, perExec: null, maxPerExec: 0, batchSizes: {} },
      tokens: { input: 0, cached: 0, output: 0, reasoning: 0, turnsReported: 0 },
      toolAttempts: 0,
      budgetRefusals: 0,
      queuedObservationsDropped: 0,
    };
  }
}

/** The process-wide counters the provider records into and /api/health reads. */
export const codexMetrics = new CodexMetrics();

export interface CodexMetricsReporterOptions {
  metrics?: CodexMetrics;
  intervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Log the counters every `intervalMs` — only when something changed since the
 * last line, so an idle worker (or one on another provider) stays quiet. The
 * timer is unref'd. Returns a stop function, and `report()` to log now.
 */
export function startCodexMetricsReporter(options: CodexMetricsReporterOptions = {}): {
  stop: () => void;
  report: () => boolean;
} {
  const metrics = options.metrics ?? codexMetrics;
  const intervalMs = options.intervalMs ?? CODEX_METRICS_REPORT_INTERVAL_MS;
  const setTimer = options.setInterval ?? ((callback: () => void, ms: number) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimer = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let lastKey: string | null = null;
  const report = (): boolean => {
    const snapshot = metrics.snapshot();
    const { sinceMs: _since, ...counters } = snapshot;
    const key = JSON.stringify(counters);
    if (key === lastKey) return false;
    const first = lastKey === null;
    lastKey = key;
    // Nothing has happened at all yet: not worth a line.
    if (
      first
      && snapshot.execs === 0
      && snapshot.budgetRefusals === 0
      && snapshot.skipped.init === 0
      && snapshot.queuedObservationsDropped === 0
    ) return false;
    logger.info('SDK', 'Codex observer usage', {
      since: new Date(snapshot.sinceMs).toISOString(),
      execs: snapshot.execs,
      calls: snapshot.calls,
      skipped: snapshot.skipped,
      observationsPerExec: snapshot.observations.perExec,
      observationsSent: snapshot.observations.sent,
      batchSizes: snapshot.observations.batchSizes,
      tokens: snapshot.tokens,
      toolAttempts: snapshot.toolAttempts,
      budgetRefusals: snapshot.budgetRefusals,
      queuedObservationsDropped: snapshot.queuedObservationsDropped,
    });
    return true;
  };

  const handle = setTimer(() => { report(); }, intervalMs);
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimer(handle);
    },
    report,
  };
}
