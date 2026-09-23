/**
 * The local 5-hour Codex exec budget (M4) through the M3 pause machinery.
 *
 * A spent budget must behave exactly like a real Codex usage limit: the
 * generator pauses with its buffer kept, the route arms the quota breaker
 * until the moment the window has slid far enough, the banner says so, and the
 * resume scheduler probes at that moment and drains everyone once the probe
 * gets through — without a new tool call, and without dropping anything.
 *
 * The codex agent is a double whose run applies the REAL composed pre-flight
 * (the M3 quota circuit, then the M4 budget, as CodexProvider composes them)
 * and the REAL shared error policy; an exec is "spawned" by counting it in the
 * budget, as CodexProvider does from the transport's onSpawned. Nothing spawns
 * codex. Time is a single hand-driven clock shared by the budget, the route
 * and the scheduler.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../src/utils/logger.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import {
  CodexProvider,
  codexLocalBudgetPreflight,
  codexQuotaCircuitPreflight,
  composeCodexPreflights,
  resolveCodexMaxExecsPer5h,
  type CodexConfig,
} from '../../../../src/services/worker/CodexProvider.js';
import { CodexExecBudget, CODEX_BUDGET_WINDOW_MS } from '../../../../src/services/worker/codex/codex-budget.js';
import { CodexMetrics } from '../../../../src/services/worker/codex/codex-metrics.js';
import { handleSessionError } from '../../../../src/services/worker/session/provider-error-policy.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../../../src/shared/SettingsDefaultsManager.js';
import {
  clearQuotaCooldown,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
} from '../../../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../../../src/shared/dependency-health.js';
import { OBSERVER_HEALTH_FILENAME, readObserverHealth } from '../../../../src/shared/observer-health.js';
import { paths } from '../../../../src/shared/paths.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const healthPath = (): string => join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);

class ManualTimers {
  private nextId = 1;
  readonly armed = new Map<number, { delayMs: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.armed.set(id, { delayMs, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.armed.delete(handle as number);
  };

  runOnce(maxDelayMs = 0): number {
    const due = [...this.armed.entries()].filter(([, timer]) => timer.delayMs <= maxDelayMs);
    for (const [id, timer] of due) {
      this.armed.delete(id);
      timer.callback();
    }
    return due.length;
  }
}

function makeSession(sessionDbId: number): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
    memorySessionId: `memory-${sessionDbId}`,
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

async function flush(): Promise<void> {
  await Bun.sleep(5);
}

const realDateNow = Date.now;
let settings: SettingsDefaults;
let spies: ReturnType<typeof spyOn>[] = [];
let routes: SessionRoutes | null = null;

guardSharedQuotaCooldownSingleton('session-routes-codex-budget.test.ts');

describe('SessionRoutes — the codex exec budget pauses and resumes like a usage limit', () => {
  beforeEach(() => {
    settings = {
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    };
    spies = [
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  afterEach(() => {
    Date.now = realDateNow;
    routes?.dispose();
    routes = null;
    spies.forEach(spy => spy.mockRestore());
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  it('arms the breaker until the window slides, keeps the buffer, then probes once and drains the rest', async () => {
    let now = realDateNow();
    const t0 = now;
    Date.now = () => now;

    // CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = 2, both spent an hour ago.
    const config = { maxExecsPer5h: 2 } as CodexConfig;
    const budget = new CodexExecBudget({ persist: false, now: () => now });
    const metrics = new CodexMetrics();
    now = t0 - HOUR;
    budget.recordExec();
    budget.recordExec();
    now = t0;
    // Exactly what CodexProvider installs: circuit first, then the budget.
    const preflight = composeCodexPreflights(codexQuotaCircuitPreflight, codexLocalBudgetPreflight(budget, metrics));

    const first = makeSession(51);
    const second = makeSession(52);
    const sessions = new Map([first, second].map(session => [session.sessionDbId, session]));
    const spawned: number[] = [];
    const codexAgent = {
      startSession: mock(async (session: ActiveSession) => {
        try {
          await preflight(config, { sessionDbId: session.sessionDbId, purpose: 'observation', session });
        } catch (error) {
          handleSessionError(error, session, 'Codex');
        }
        // Spawned: counted once the process exists, like onSpawned.
        budget.recordExec();
        spawned.push(session.sessionDbId);
        // The exec stored an observation: ResponseProcessor clears the breaker.
        clearQuotaCooldown('codex');
        // ...and the generator keeps draining.
        await new Promise<void>(() => {});
      }),
      readinessSnapshot: mock(() => ({ state: 'passed' as const })),
      verifyLockdown: mock(() => Promise.resolve(null)),
    };
    const sessionManager = {
      getSession: (id: number) => sessions.get(id),
      getMessageBuffer: () => ({ getPendingCount: () => 3, peekTypes: () => [] }),
      removeSessionImmediate: mock(() => {}),
      listSessionIdsWithPendingWork: () => [...sessions.values()]
        .filter(session => !session.generatorPromise)
        .map(session => session.sessionDbId),
    };
    const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
    const timers = new ManualTimers();
    routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      {} as any,
      {} as any,
      completionHandler as any,
      codexAgent as any,
      { resumeSchedulerDeps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => now } },
    );

    // A tool call arrives: the budget is spent, so the generator pauses.
    await routes.ensureGeneratorRunning(51, 'observation');
    await first.generatorPromise;

    const expectedResumeAt = t0 - HOUR + CODEX_BUDGET_WINDOW_MS;
    expect(spawned).toEqual([]);
    expect(metrics.snapshot().budgetRefusals).toBe(1);
    // Booked like a real limit — NOT skipped as the circuit's own refusal.
    const breaker = getQuotaCooldown('codex')!;
    expect(breaker.message).toContain('Local Codex exec budget reached');
    expect(breaker.resumeAtMs).toBe(expectedResumeAt);
    const health = readObserverHealth(healthPath())!;
    expect(health.lastErrorKind).toBe('quota_exhausted');
    expect(health.lastErrorCode).toBe('local_budget');
    expect(health.quotaCooldown!.until).toBe(expectedResumeAt);
    // Paused, not finalized: the buffered observations are still there.
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
    expect(first.generatorPromise).toBeNull();
    // The scheduler will probe exactly when the oldest exec leaves the window.
    expect(routes.resumeScheduler.snapshot().quota.codex).toBe(expectedResumeAt);

    // More tool calls meanwhile: the breaker withholds them; nothing spends.
    await routes.ensureGeneratorRunning(52, 'observation');
    await routes.ensureGeneratorRunning(51, 'observation');
    expect(codexAgent.startSession).toHaveBeenCalledTimes(1);

    // The window slides; no tool call arrives. The scheduler probes ONE session.
    now = expectedResumeAt;
    timers.runOnce(expectedResumeAt - t0);
    timers.runOnce(0);
    await flush();
    expect(codexAgent.startSession).toHaveBeenCalledTimes(2);
    expect(spawned).toEqual([51]);

    // The probe stored, clearing the breaker: everyone else drains now.
    timers.runOnce(0);
    await flush();
    expect(codexAgent.startSession).toHaveBeenCalledTimes(3);
    expect(spawned).toEqual([51, 52]);
    expect(getQuotaCooldown('codex')).toBeNull();
    expect(routes.resumeScheduler.snapshot().quota.codex).toBeUndefined();
    expect(budget.usedInWindow()).toBe(2);
  });

  it('a budget spent again by the probe re-arms the breaker for the next slide', async () => {
    let now = realDateNow();
    const t0 = now;
    Date.now = () => now;

    // Limit 1; the one exec was 4 h 50 min ago, so the window frees in 10 min.
    const config = { maxExecsPer5h: 1 } as CodexConfig;
    const budget = new CodexExecBudget({ persist: false, now: () => now });
    now = t0 - CODEX_BUDGET_WINDOW_MS + 10 * MINUTE;
    budget.recordExec();
    now = t0;
    const preflight = composeCodexPreflights(codexQuotaCircuitPreflight, codexLocalBudgetPreflight(budget));

    const session = makeSession(61);
    const codexAgent = {
      startSession: mock(async (s: ActiveSession) => {
        try {
          await preflight(config, { sessionDbId: s.sessionDbId, purpose: 'observation', session: s });
        } catch (error) {
          handleSessionError(error, s, 'Codex');
        }
        // The probe's exec happens, but then (say) another session's exec is
        // counted before this one could store: the next call is refused again.
        budget.recordExec();
        try {
          await preflight(config, { sessionDbId: s.sessionDbId, purpose: 'observation', session: s });
        } catch (error) {
          handleSessionError(error, s, 'Codex');
        }
      }),
      readinessSnapshot: mock(() => ({ state: 'passed' as const })),
      verifyLockdown: mock(() => Promise.resolve(null)),
    };
    const sessionManager = {
      getSession: (id: number) => (id === 61 ? session : undefined),
      getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
      removeSessionImmediate: mock(() => {}),
      listSessionIdsWithPendingWork: () => (session.generatorPromise ? [] : [61]),
    };
    const timers = new ManualTimers();
    routes = new SessionRoutes(
      sessionManager as any, {} as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      {} as any, {} as any,
      { finalizeSession: mock(() => Promise.resolve()) } as any,
      codexAgent as any,
      { resumeSchedulerDeps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => now } },
    );

    await routes.ensureGeneratorRunning(61, 'observation');
    await session.generatorPromise;
    expect(getQuotaCooldown('codex')!.resumeAtMs).toBe(t0 + 10 * MINUTE);

    now = t0 + 10 * MINUTE;
    timers.runOnce(10 * MINUTE);
    timers.runOnce(0);
    await flush();
    const probeRun = session.generatorPromise;
    if (probeRun) await probeRun;
    await flush();

    // The probe spent the freed exec and was refused on its next call: the
    // breaker is re-armed for when THAT exec leaves the window, and the
    // scheduler follows it.
    expect(codexAgent.startSession).toHaveBeenCalledTimes(2);
    const rearmed = getQuotaCooldown('codex')!;
    expect(rearmed.resumeAtMs).toBe(t0 + 10 * MINUTE + CODEX_BUDGET_WINDOW_MS);
    expect(routes.resumeScheduler.snapshot().quota.codex).toBe(t0 + 10 * MINUTE + CODEX_BUDGET_WINDOW_MS);
    expect(rearmed.probeInFlightSinceMs).toBeNull();
  });
  it('a raised limit lifts the budget pause at the next tool call, not at the old resume time, and drains the rest', async () => {
    let now = realDateNow();
    const t0 = now;
    Date.now = () => now;

    // CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = 2, both spent an hour ago: paused for 4 h.
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '2';
    const config = {} as CodexConfig;
    const budget = new CodexExecBudget({ persist: false, now: () => now });
    now = t0 - HOUR;
    budget.recordExec();
    budget.recordExec();
    now = t0;
    // The provider's own composition: the limit is read live at each check.
    const preflight = composeCodexPreflights(
      codexQuotaCircuitPreflight,
      codexLocalBudgetPreflight(budget, undefined, () => resolveCodexMaxExecsPer5h()),
    );

    const first = makeSession(71);
    const second = makeSession(72);
    const sessions = new Map([first, second].map(session => [session.sessionDbId, session]));
    const spawned: number[] = [];
    const codexAgent = {
      startSession: mock(async (session: ActiveSession) => {
        try {
          await preflight(config, { sessionDbId: session.sessionDbId, purpose: 'observation', session });
        } catch (error) {
          handleSessionError(error, session, 'Codex');
        }
        budget.recordExec();
        spawned.push(session.sessionDbId);
        await new Promise<void>(() => {});
      }),
      // The REAL re-evaluation, over this test's budget.
      releaseStaleLocalBudgetHold: CodexProvider.prototype.releaseStaleLocalBudgetHold.bind({ budget } as unknown as CodexProvider),
      readinessSnapshot: mock(() => ({ state: 'passed' as const })),
      verifyLockdown: mock(() => Promise.resolve(null)),
    };
    const sessionManager = {
      getSession: (id: number) => sessions.get(id),
      getMessageBuffer: () => ({ getPendingCount: () => 2, peekTypes: () => [] }),
      removeSessionImmediate: mock(() => {}),
      listSessionIdsWithPendingWork: () => [...sessions.values()]
        .filter(session => !session.generatorPromise)
        .map(session => session.sessionDbId),
    };
    const timers = new ManualTimers();
    routes = new SessionRoutes(
      sessionManager as any, {} as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      {} as any, {} as any,
      { finalizeSession: mock(() => Promise.resolve()) } as any,
      codexAgent as any,
      { resumeSchedulerDeps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => now } },
    );

    await routes.ensureGeneratorRunning(71, 'observation');
    await first.generatorPromise;
    const breaker = getQuotaCooldown('codex')!;
    // Booked with its cause, which is what makes it re-evaluable.
    expect(breaker.code).toBe('local_budget');
    expect(breaker.resumeAtMs).toBe(t0 - HOUR + CODEX_BUDGET_WINDOW_MS);
    expect(spawned).toEqual([]);

    // Ten minutes later the user raises the limit; the next tool call arrives.
    now = t0 + 10 * MINUTE;
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '5';
    await routes.ensureGeneratorRunning(72, 'observation');
    await flush();

    // Admitted at once — hours before the stale resume time — and the clear
    // drains the session that paused.
    expect(getQuotaCooldown('codex')).toBeNull();
    expect(spawned).toEqual([72]);
    timers.runOnce(0);
    await flush();
    expect(spawned).toEqual([72, 71]);
    expect(budget.usedInWindow()).toBe(4);
  });
});
