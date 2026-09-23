/**
 * SessionRoutes, M3 (plan 3.5 / 3.6): the non-blocking codex gate, the
 * `.finally()` pause bookings, and the resume scheduler wired end to end.
 *
 * The codex agent is a double with the readiness surface CodexProvider
 * exposes (readinessSnapshot / verifyLockdown), so the route builds its real
 * gate; failures are raised through the REAL shared provider error policy and,
 * for the circuit, the REAL codex quota preflight — the same path a codex
 * refusal takes in the worker. Nothing spawns codex. Provider selection is
 * settings-driven (a restorable spy), not a process-global module mock.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../src/utils/logger.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { codexQuotaCircuitPreflight } from '../../../../src/services/worker/CodexProvider.js';
import { handleSessionError } from '../../../../src/services/worker/session/provider-error-policy.js';
import type { CodexReadinessSnapshot } from '../../../../src/services/worker/session/codex-readiness-gate.js';
import type { CodexLockdownResult } from '../../../../src/services/worker/codex/codex-self-check.js';
import { ClassifiedProviderError } from '../../../../src/services/worker/provider-errors.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../../../src/shared/SettingsDefaultsManager.js';
import {
  clearQuotaCooldown,
  getQuotaCooldown,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
  quotaCooldownResumeAtMs,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../../../src/shared/quota-cooldown.js';
import { notifyObserverTurnAnswered } from '../../../../src/services/worker/session/observer-turn-signal.js';
import {
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  getDependencyStatus,
  recordCodexAuthRequired,
  resetDependencyStatusesForTesting,
} from '../../../../src/shared/dependency-health.js';
import {
  isObserverUnhealthy,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
  renderObserverHealthWarning,
  renderObserverQuotaCooldownNotice,
  workerRestartUrl,
} from '../../../../src/shared/observer-health.js';
import { paths } from '../../../../src/shared/paths.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const healthPath = (): string => join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);

/** Timers the test fires by hand; only the ones armed before each call run. */
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

function passedVerdict(): CodexLockdownResult {
  return {
    state: 'passed',
    binaryPath: '/opt/codex/bin/codex',
    cacheKey: 'key',
    version: '0.144.4',
    authMethod: 'chatgpt',
    failure: null,
    warnings: [],
    startedAt: 0,
    finishedAt: 1,
  };
}

type StartSession = (session: ActiveSession) => Promise<void>;

/** A live generator that never finishes on its own. */
const runsForever: StartSession = () => new Promise<void>(() => {});

function build(options: {
  sessions: ActiveSession[];
  snapshot?: CodexReadinessSnapshot;
  startSession?: StartSession;
  /** The Claude agent's run, for the non-codex pins. */
  claudeStartSession?: StartSession;
  /** The resume scheduler's clock (Date.now when omitted). */
  now?: () => number;
}) {
  const sessions = new Map(options.sessions.map(session => [session.sessionDbId, session]));
  const pending = new Map(options.sessions.map(session => [session.sessionDbId, 2]));
  let snapshot: CodexReadinessSnapshot = options.snapshot ?? { state: 'passed' };
  let finishCheck: ((result: CodexLockdownResult | null) => void) | null = null;

  const codexAgent = {
    startSession: mock(options.startSession ?? runsForever),
    readinessSnapshot: mock(() => snapshot),
    verifyLockdown: mock((_options?: { force?: boolean }) => new Promise<CodexLockdownResult | null>((resolve) => {
      finishCheck = resolve;
    })),
  };
  const sessionManager = {
    getSession: (id: number) => sessions.get(id),
    getMessageBuffer: () => ({ getPendingCount: (id: number) => pending.get(id) ?? 0, peekTypes: () => [] }),
    removeSessionImmediate: mock((id: number) => {
      sessions.delete(id);
    }),
    listSessionIdsWithPendingWork: () => [...sessions.values()]
      .filter(session => !session.generatorPromise && (pending.get(session.sessionDbId) ?? 0) > 0)
      .map(session => session.sessionDbId),
  };
  const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
  const timers = new ManualTimers();

  const claudeAgent = { startSession: mock(options.claudeStartSession ?? (() => Promise.resolve())) };
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    claudeAgent as any,
    { startSession: mock(() => Promise.resolve()) } as any,
    { startSession: mock(() => Promise.resolve()) } as any,
    {} as any,
    {} as any,
    completionHandler as any,
    codexAgent as any,
    {
      resumeSchedulerDeps: {
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        ...(options.now ? { now: options.now } : {}),
      },
    },
  );

  return {
    routes,
    codexAgent,
    claudeAgent,
    sessionManager,
    completionHandler,
    timers,
    setSnapshot(next: CodexReadinessSnapshot) {
      snapshot = next;
    },
    async finishSelfCheck(result: CodexLockdownResult | null) {
      if (!finishCheck) throw new Error('no self-check is running');
      finishCheck(result);
      finishCheck = null;
      await flush();
    },
  };
}

/** Let every queued promise chain (ensureGeneratorRunning, .catch/.finally) run. */
async function flush(): Promise<void> {
  await Bun.sleep(5);
}

/** Start the observer for a session and wait for that run to fully exit. */
async function runToExit(routes: SessionRoutes, session: ActiveSession, source = 'observation'): Promise<void> {
  await routes.ensureGeneratorRunning(session.sessionDbId, source);
  const running = session.generatorPromise;
  if (running) await running;
}

/** What a codex failure does inside CodexProvider: stash, label, abort, rethrow. */
function failWith(error: ClassifiedProviderError, providerName = 'Codex'): StartSession {
  return async (session) => {
    handleSessionError(error, session, providerName);
  };
}

/** A refusal only a real exec produces; the self-check passes straight through it. */
function lockdownBreach(): ClassifiedProviderError {
  return new ClassifiedProviderError('Codex lockdown breach: 2 forbidden tool attempts in session', {
    kind: 'setup_required',
    cause: null,
    code: 'codex_lockdown_breach',
    action: 'See observer-audit.log; the provider stays disabled until the self-check passes again.',
  });
}

/** Run `startSession` doubles in order; the last one repeats. */
function inSequence(...runs: StartSession[]): StartSession {
  let call = 0;
  return (session) => runs[Math.min(call++, runs.length - 1)](session);
}

let settings: SettingsDefaults;
let spies: ReturnType<typeof spyOn>[] = [];
const realDateNow = Date.now;

guardSharedQuotaCooldownSingleton('session-routes-codex-m3.test.ts');

describe('SessionRoutes — codex M3', () => {
  let built: ReturnType<typeof build> | null = null;

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
    built?.routes.dispose();
    built = null;
    spies.forEach(spy => spy.mockRestore());
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  describe('the non-blocking codex gate', () => {
    it('never starts an unverified codex, never makes ingest wait for the self-check, and drains once it passes', async () => {
      const session = makeSession(1);
      built = build({ sessions: [session], snapshot: { state: 'unverified' } });
      const { routes, codexAgent, timers } = built;

      // The self-check promise never settles until the test says so; ingest
      // must return regardless.
      const outcome = await Promise.race([
        routes.ensureGeneratorRunning(1, 'observation').then(() => 'returned'),
        Bun.sleep(1_000).then(() => 'blocked'),
      ]);
      expect(outcome).toBe('returned');
      expect(codexAgent.startSession).not.toHaveBeenCalled();
      expect(codexAgent.verifyLockdown).toHaveBeenCalledTimes(1);

      // More tool calls while it runs: no second check, no start.
      await routes.ensureGeneratorRunning(1, 'observation');
      await routes.ensureGeneratorRunning(1, 'observation');
      expect(codexAgent.verifyLockdown).toHaveBeenCalledTimes(1);
      expect(codexAgent.startSession).not.toHaveBeenCalled();

      built.setSnapshot({ state: 'passed' });
      await built.finishSelfCheck(passedVerdict());
      // The pass resumes the waiting session with no new tool call.
      timers.runOnce(0);
      await flush();

      expect(codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(session.currentProvider).toBe('codex');
    });

    it('holds starts inside the codex_cli backoff without reading readiness or probing', async () => {
      const session = makeSession(2);
      built = build({ sessions: [session] });
      recordCodexAuthRequired('Codex is not logged in');

      await built.routes.ensureGeneratorRunning(2, 'observation');
      await built.routes.ensureGeneratorRunning(2, 'observation');

      expect(built.codexAgent.startSession).not.toHaveBeenCalled();
      expect(built.codexAgent.readinessSnapshot).not.toHaveBeenCalled();
      expect(built.codexAgent.verifyLockdown).not.toHaveBeenCalled();
      // A re-check is still arranged for when the backoff lifts.
      expect(built.routes.resumeScheduler.snapshot().dependencyAtMs).not.toBeNull();
    });

    it('restarts a lapsed self-check instead of booking a setup problem when the provider refuses a start', async () => {
      const session = makeSession(3);
      built = build({
        sessions: [session],
        startSession: async (s) => {
          // The cached pass lapsed between the gate and the provider's own check.
          built!.setSnapshot({ state: 'unverified' });
          const notReady = new ClassifiedProviderError('Codex observer is not ready: its lockdown self-check has not finished yet', {
            kind: 'setup_required',
            cause: new Error('codex observer not configured'),
            code: 'codex_setup_required',
          });
          s.lastProviderError = notReady;
          throw notReady;
        },
      });

      await runToExit(built.routes, session);

      expect(built.codexAgent.verifyLockdown).toHaveBeenCalledTimes(1);
      expect(getDependencyStatus('codex_cli')).toBeNull();
      expect(existsSync(healthPath())).toBe(false);
      // The buffered work survives for the resume.
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
      expect(session.generatorPromise).toBeNull();
      expect(session.lastProviderError).toBeNull();
    });
  });

  describe('.finally() pause bookings', () => {
    it("books Codex's own quota message and resume time, and schedules the probe for then", async () => {
      const session = makeSession(10);
      const refusal = new ClassifiedProviderError(
        "Codex usage limit reached: You've hit your usage limit. Try again at 4:35 PM.",
        {
          kind: 'quota_exhausted',
          cause: null,
          code: 'codex_usage_limit',
          retryAfterMs: 4 * HOUR,
          action: 'The observer pauses until the Codex usage window resets.',
        },
      );
      built = build({ sessions: [session], startSession: failWith(refusal) });

      const before = Date.now();
      await runToExit(built.routes, session);

      const breaker = getQuotaCooldown('codex')!;
      expect(breaker.message).toBe(refusal.message);
      expect(breaker.resumeAtMs).toBeGreaterThanOrEqual(before + 4 * HOUR);
      expect(breaker.resumeAtMs).toBeLessThanOrEqual(Date.now() + 4 * HOUR);

      const health = readObserverHealth(healthPath())!;
      expect(health.lastErrorMessage).toBe(refusal.message);
      expect(health.lastErrorKind).toBe('quota_exhausted');
      expect(health.lastErrorCode).toBe('codex_usage_limit');
      expect(health.lastErrorAction).toBe('The observer pauses until the Codex usage window resets.');
      // The banner counts down to the real time, not armedAt + 30 minutes.
      expect(health.quotaCooldown!.until).toBe(breaker.resumeAtMs!);

      expect(built.routes.resumeScheduler.snapshot().quota.codex).toBe(breaker.resumeAtMs!);
      // Paused, not finalized, and the per-run state does not outlive the run.
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
      expect(session.lastProviderError).toBeNull();
      expect(session.quotaProbeClaimId ?? null).toBeNull();
    });

    it('does not re-arm or re-book the breaker for a refusal its own circuit raised', async () => {
      const session = makeSession(11);
      let armedAtMs = 0;
      let resumeAtMs = 0;
      built = build({
        sessions: [session],
        startSession: async (s) => {
          // Another session's refusal arms the breaker while this generator runs.
          const armed = recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', Date.now(), Date.now() + 2 * HOUR);
          armedAtMs = armed.armedAtMs;
          resumeAtMs = armed.resumeAtMs!;
          try {
            codexQuotaCircuitPreflight({} as never, { sessionDbId: s.sessionDbId, purpose: 'observation', session: s });
          } catch (error) {
            handleSessionError(error, s, 'Codex');
          }
          throw new Error('the circuit should have refused this call');
        },
      });

      await runToExit(built.routes, session);

      const breaker = getQuotaCooldown('codex')!;
      expect(breaker.armedAtMs).toBe(armedAtMs);
      expect(breaker.message).toBe("You've hit your usage limit");
      expect(breaker.resumeAtMs).toBe(resumeAtMs);
      // No second failure booked for a pause the ledger already shows.
      expect(readObserverHealth(healthPath())?.consecutiveFailures ?? 0).toBe(0);
      expect(built.routes.resumeScheduler.snapshot().quota.codex).toBe(resumeAtMs);
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
    });

    it('books a Codex login failure the banner shows at once, and holds further starts', async () => {
      const session = makeSession(12);
      const authError = new ClassifiedProviderError(
        'Codex authentication failed: Your access token could not be refreshed. Please sign in again.',
        { kind: 'auth_invalid', cause: null, code: 'codex_auth_invalid', action: 'Run `codex login` (ChatGPT sign-in).' },
      );
      built = build({ sessions: [session], startSession: failWith(authError) });

      await runToExit(built.routes, session);

      expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'auth_required', message: authError.message });
      const health = readObserverHealth(healthPath())!;
      expect(health.lastErrorProvider).toBe('codex');
      expect(health.lastErrorKind).toBe('auth_invalid');
      // The real message, through the ledger's credential scrubber (which
      // elides the word after "token").
      expect(health.lastErrorMessage).toContain('Codex authentication failed');
      expect(health.lastErrorMessage).toContain('Please sign in again.');
      expect(health.lastErrorAction).toContain('codex login');
      expect(isObserverUnhealthy(health)).toBe(true);
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();

      // The re-check is armed for the end of the backoff...
      const recheckAt = built.routes.resumeScheduler.snapshot().dependencyAtMs!;
      expect(recheckAt - Date.now()).toBeGreaterThan(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS - 1_000);
      // ...and until then the next tool call spawns nothing.
      const snapshotsBefore = built.codexAgent.readinessSnapshot.mock.calls.length;
      await built.routes.ensureGeneratorRunning(12, 'observation');
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(built.codexAgent.readinessSnapshot.mock.calls.length).toBe(snapshotsBefore);
    });

    it('books transport failures from the third in a row, with the real message, and backs off each resume', async () => {
      const session = makeSession(13);
      const transient = new ClassifiedProviderError('Codex stream disconnected: stream disconnected before completion', {
        kind: 'transient',
        cause: null,
        code: 'codex_transient',
      });
      // One frozen instant for the scheduler and the ledger alike, so every
      // delay is exact rather than "at least".
      const t0 = realDateNow();
      Date.now = () => t0;
      built = build({ sessions: [session], startSession: failWith(transient), now: () => t0 });
      const delays: number[] = [];

      for (let exit = 1; exit <= 3; exit += 1) {
        await runToExit(built.routes, session);
        expect(session.consecutiveTransportExits).toBe(exit);
        delays.push(built.routes.resumeScheduler.snapshot().sessions[13] - t0);
        if (exit < 3) {
          // A blip heals on the scheduled resume; it must not raise the banner.
          expect(readObserverHealth(healthPath())?.consecutiveFailures ?? 0).toBe(0);
        }
      }

      expect(delays).toEqual([60_000, 120_000, 240_000]);

      const health = readObserverHealth(healthPath())!;
      expect(health.lastErrorMessage).toBe(transient.message);
      expect(health.lastErrorKind).toBe('transient');
      expect(health.lastErrorCode).toBe('codex_transient');
      // All three exits are counted, so the banner says "3 times in a row".
      expect(health.consecutiveFailures).toBe(3);
      expect(isObserverUnhealthy(health)).toBe(true);
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
      // Booked as held for retry, with the instant of the scheduled resume, so
      // the banner says the work is kept and retried — and offers no restart,
      // which would discard exactly that work.
      expect(health.lastErrorHeldForRetry).toBe(true);
      expect(health.lastErrorRetryAt).toBe(t0 + 240_000);
      const banner = renderObserverHealthWarning(health, t0);
      expect(banner).toContain("held in the worker's memory");
      expect(banner).toContain(new Date(t0 + 240_000).toISOString());
      expect(banner).toContain('discards the');
      expect(banner).not.toContain(workerRestartUrl());
      expect(banner).not.toContain('nothing from this session');
    });

    it('ends a transport streak on any other exit', async () => {
      const session = makeSession(14);
      session.consecutiveTransportExits = 2;
      built = build({ sessions: [session], startSession: async () => {} });

      await runToExit(built.routes, session);

      expect(session.consecutiveTransportExits).toBe(0);
    });
  });

  describe('quota admission and the probe', () => {
    it('logs the retry time from the stated resume time and hands the wait to the scheduler', async () => {
      const session = makeSession(20);
      built = build({ sessions: [session] });
      const armed = recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', Date.now(), Date.now() + 4 * HOUR);

      await built.routes.ensureGeneratorRunning(20, 'observation');

      expect(built.codexAgent.startSession).not.toHaveBeenCalled();
      const warn = (logger.warn as unknown as ReturnType<typeof mock>).mock.calls
        .find(([, message]) => message === 'Skipping generator start while the provider quota cooldown is active');
      expect(warn).toBeDefined();
      const retryInMs = (warn![2] as { retryInMs: number }).retryInMs;
      // Not the fixed window's "at most 30 minutes".
      expect(retryInMs).toBeGreaterThan(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
      expect(retryInMs).toBeGreaterThan(4 * HOUR - MINUTE);
      expect(built.routes.resumeScheduler.snapshot().quota.codex).toBe(armed.resumeAtMs!);
    });

    it('gives the probe claim to its session, so the codex circuit lets exactly that generator through', async () => {
      const session = makeSession(21);
      const bystander = makeSession(22);
      const seen: { claim: number | null | undefined; breakerClaim: number | null | undefined; ownerPassed: boolean; bystanderCode?: string } = {
        claim: undefined,
        breakerClaim: undefined,
        ownerPassed: false,
      };
      built = build({
        sessions: [session, bystander],
        startSession: async (s) => {
          seen.claim = s.quotaProbeClaimId;
          seen.breakerClaim = getQuotaCooldown('codex')?.probeClaimId;
          codexQuotaCircuitPreflight({} as never, { sessionDbId: s.sessionDbId, purpose: 'observation', session: s });
          seen.ownerPassed = true;
          try {
            codexQuotaCircuitPreflight({} as never, { sessionDbId: 22, purpose: 'observation', session: bystander });
          } catch (error) {
            seen.bystanderCode = (error as ClassifiedProviderError).code;
          }
        },
      });
      // A window that has already elapsed: the next start is the single probe.
      recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - MINUTE);

      await runToExit(built.routes, session);

      expect(typeof seen.claim).toBe('number');
      expect(seen.claim).toBe(seen.breakerClaim);
      expect(seen.ownerPassed).toBe(true);
      expect(seen.bystanderCode).toBe('codex_quota_probe_in_flight');
      // Released on exit, and not left on the session.
      expect(getQuotaCooldown('codex')!.probeInFlightSinceMs).toBeNull();
      expect(session.quotaProbeClaimId ?? null).toBeNull();
    });

    it('probes ONE waiting session when the window ends, then starts the rest once the probe stores', async () => {
      const first = makeSession(31);
      const second = makeSession(32);
      built = build({ sessions: [first, second] });
      const { routes, codexAgent, timers } = built;
      const t0 = realDateNow();
      Date.now = () => t0;
      recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', t0, t0 + 10 * MINUTE);

      await routes.ensureGeneratorRunning(31, 'observation');
      await routes.ensureGeneratorRunning(32, 'observation');
      expect(codexAgent.startSession).not.toHaveBeenCalled();
      expect(routes.resumeScheduler.snapshot().quota.codex).toBe(t0 + 10 * MINUTE);

      // The window ends; no tool call arrives.
      Date.now = () => t0 + 10 * MINUTE + 1;
      timers.runOnce(10 * MINUTE);
      timers.runOnce(0);
      await flush();

      expect(codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(codexAgent.startSession.mock.calls[0][0]).toBe(first);
      expect(first.quotaProbeClaimId).toBe(getQuotaCooldown('codex')!.probeClaimId);

      // The probe stores: ResponseProcessor clears the breaker.
      clearQuotaCooldown('codex');
      timers.runOnce(0);
      await flush();

      expect(codexAgent.startSession).toHaveBeenCalledTimes(2);
      expect(codexAgent.startSession.mock.calls[1][0]).toBe(second);
      expect(routes.resumeScheduler.snapshot().quota.codex).toBeUndefined();
    });
  });
  describe('the codex gate runs before quota admission', () => {
    // After a worker restart the breaker is rehydrated from disk while the
    // self-check cache is empty. A held start must not take the single
    // post-cooldown probe: nothing would run to release it.
    it('an unverified codex start never takes the probe claim of an elapsed breaker', async () => {
      const session = makeSession(40);
      built = build({ sessions: [session], snapshot: { state: 'unverified' } });
      recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - MINUTE);

      await built.routes.ensureGeneratorRunning(40, 'observation');

      const breaker = getQuotaCooldown('codex')!;
      expect(breaker.probeInFlightSinceMs).toBeNull();
      expect(breaker.probeClaimId).toBeNull();
      expect(built.codexAgent.startSession).not.toHaveBeenCalled();
      expect(built.codexAgent.verifyLockdown).toHaveBeenCalledTimes(1);
    });

    it('nor does a start held inside a codex_cli login backoff', async () => {
      const session = makeSession(41);
      built = build({ sessions: [session] });
      recordCodexAuthRequired('Codex is not logged in');
      recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - MINUTE);

      await built.routes.ensureGeneratorRunning(41, 'observation');

      const breaker = getQuotaCooldown('codex')!;
      expect(breaker.probeInFlightSinceMs).toBeNull();
      expect(breaker.probeClaimId).toBeNull();
      expect(built.codexAgent.startSession).not.toHaveBeenCalled();
      expect(built.codexAgent.verifyLockdown).not.toHaveBeenCalled();
    });
  });

  describe('the other providers keep their pre-M3 behaviour (plan question 8 is open)', () => {
    beforeEach(() => {
      settings = { ...settings, CLAUDE_MEM_PROVIDER: 'claude' };
    });

    it('a Claude 429 arms the fixed 30-minute breaker with the generic text — its Retry-After is not a resume time', async () => {
      const session = makeSession(70);
      const tooMany = new ClassifiedProviderError('429 Too Many Requests', {
        kind: 'rate_limit',
        cause: null,
        retryAfterMs: 5_000,
        code: 'x',
      });
      built = build({ sessions: [session], claudeStartSession: failWith(tooMany, 'Claude') });

      await runToExit(built.routes, session);

      expect(built.claudeAgent.startSession).toHaveBeenCalledTimes(1);
      const breaker = getQuotaCooldown('claude')!;
      expect(breaker.message).toBe('Provider reported the inference allowance exhausted');
      expect(breaker.resumeAtMs).toBeUndefined();
      expect(quotaCooldownResumeAtMs(breaker)).toBe(breaker.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
      const health = readObserverHealth(healthPath())!;
      expect(health.lastErrorMessage).toBe('Provider reported the inference allowance exhausted');
      expect(health.quotaCooldown!.until).toBe(breaker.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
    });

    it('a Claude quota pause arms no resume timer: it waits for the next tool call, as before M3', async () => {
      const session = makeSession(71);
      built = build({
        sessions: [session],
        claudeStartSession: async (s) => {
          // ClaudeProvider's proactive guard (92-95% utilization).
          s.abortReason = 'quota:seven_day';
          s.abortController.abort();
        },
      });

      await runToExit(built.routes, session);
      // A later tool call is refused by the breaker: still no timer.
      await built.routes.ensureGeneratorRunning(71, 'observation');

      expect(built.claudeAgent.startSession).toHaveBeenCalledTimes(1);
      expect(built.routes.resumeScheduler.snapshot()).toEqual({
        quota: {},
        sessions: {},
        dependencyAtMs: null,
        listeningForQuotaClears: false,
      });
      expect(built.timers.armed.size).toBe(0);
      // And the notice keeps the pre-M3 wording: the allowance is not used up
      // and nothing resumes on its own.
      const notice = renderObserverQuotaCooldownNotice(readObserverHealth(healthPath())!);
      expect(notice).toContain('The memory observer is waiting out a quota cooldown on claude (seven_day) until');
      expect(notice).not.toContain('used up');
      expect(notice).not.toContain('resumes on its own');
    });

    it('Claude transport pauses get no health record and no resume timer', async () => {
      const session = makeSession(72);
      const transient = new ClassifiedProviderError('529 Overloaded', { kind: 'transient', cause: null, code: 'overloaded' });
      built = build({ sessions: [session], claudeStartSession: failWith(transient, 'Claude') });

      for (let exit = 1; exit <= 4; exit += 1) {
        await runToExit(built.routes, session);
      }

      expect(built.claudeAgent.startSession).toHaveBeenCalledTimes(4);
      expect(session.consecutiveTransportExits).toBe(4);
      expect(readObserverHealth(healthPath())?.consecutiveFailures ?? 0).toBe(0);
      expect(built.routes.resumeScheduler.snapshot().sessions).toEqual({});
      expect(built.timers.armed.size).toBe(0);
      expect(built.completionHandler.finalizeSession).not.toHaveBeenCalled();
    });
  });

  describe('codex rate limits', () => {
    it("books a codex capacity refusal as a rate limit, with Codex's own words and stated resume time", async () => {
      const session = makeSession(73);
      const capacity = new ClassifiedProviderError('Codex is at capacity: Selected model is at capacity. Please try a different model.', {
        kind: 'rate_limit',
        cause: null,
        code: 'codex_rate_limit',
        retryAfterMs: 45 * MINUTE,
      });
      const t0 = realDateNow();
      Date.now = () => t0;
      built = build({ sessions: [session], startSession: failWith(capacity), now: () => t0 });

      await runToExit(built.routes, session);

      const breaker = getQuotaCooldown('codex')!;
      expect(breaker.window).toBe('rate_limit');
      expect(breaker.message).toBe(capacity.message);
      expect(breaker.resumeAtMs).toBe(t0 + 45 * MINUTE);
      expect(built.routes.resumeScheduler.snapshot().quota.codex).toBe(t0 + 45 * MINUTE);
      const notice = renderObserverQuotaCooldownNotice(readObserverHealth(healthPath())!, t0);
      expect(notice).toContain('rate-limited on codex');
      expect(notice).not.toContain('used up');
    });
  });

  describe('the codex re-check after a setup/login hold', () => {
    it('re-checks when the backoff ends even if the oldest waiting session is overflow-paused', async () => {
      const oldest = makeSession(50);
      oldest.overflowPausedUntilMs = realDateNow() + 10 * MINUTE;
      const held = makeSession(51);
      let now = realDateNow();
      Date.now = () => now;
      built = build({ sessions: [oldest, held] });
      recordCodexAuthRequired('Codex is not logged in');

      await built.routes.ensureGeneratorRunning(51, 'observation');
      expect(built.routes.resumeScheduler.snapshot().dependencyAtMs).toBe(now + CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);

      // The user logs in; the backoff ends with no tool call.
      now += CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
      built.timers.runOnce(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);
      await flush();

      // The gate re-checked directly — the overflow-paused session could not
      // swallow it.
      expect(built.codexAgent.verifyLockdown.mock.calls).toEqual([[{ force: true }]]);

      await built.finishSelfCheck(passedVerdict());
      built.timers.runOnce(0);
      await flush();

      expect(getDependencyStatus('codex_cli')).toBeNull();
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(built.codexAgent.startSession.mock.calls[0][0]).toBe(held);
    });
  });

  describe('a problem only a real exec can see', () => {
    it('re-enables ONE session as a canary, and the rest only once its model answers', async () => {
      const first = makeSession(60);
      const second = makeSession(61);
      const third = makeSession(62);
      let now = realDateNow();
      Date.now = () => now;
      built = build({
        sessions: [first, second, third],
        startSession: inSequence(async (s) => {
          const breach = lockdownBreach();
          s.lastProviderError = breach;
          throw breach;
        }, runsForever),
      });

      // The breach books an exec-time problem; the next tool calls are held.
      await runToExit(built.routes, first);
      expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
      await built.routes.ensureGeneratorRunning(61, 'observation');
      await built.routes.ensureGeneratorRunning(62, 'observation');
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(1);

      // The backoff ends; the model-free re-check passes (it passed before the
      // breach too).
      const starts = spyOn(built.routes, 'ensureGeneratorRunning');
      now += CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
      built.timers.runOnce(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);
      await flush();
      await built.finishSelfCheck(passedVerdict());
      built.timers.runOnce(0);
      await flush();

      // Exactly one session was started, as the canary — and only one was
      // even asked to start.
      expect(starts.mock.calls).toEqual([[60, 'codex-canary']]);
      starts.mockRestore();
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(2);
      expect(built.codexAgent.startSession.mock.calls[1][0]).toBe(first);
      // Everyone else waits for its answer, tool calls included.
      await built.routes.ensureGeneratorRunning(61, 'observation');
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(2);
      expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(true);

      // The canary's model answers.
      notifyObserverTurnAnswered({ sessionDbId: 60, provider: 'codex' });
      built.timers.runOnce(0);
      await flush();

      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(4);
      expect(built.codexAgent.startSession.mock.calls.slice(2).map(([s]) => s)).toEqual([second, third]);
      expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(false);
    });
  });

  describe('the quota watchdog and a live probe', () => {
    it('never starts a second probe while the first probe run is still going, however long it takes', async () => {
      const prober = makeSession(80);
      const waiting = makeSession(81);
      let now = realDateNow();
      Date.now = () => now;
      built = build({ sessions: [prober, waiting], now: () => now });
      recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', now, now + 10 * MINUTE);
      await built.routes.ensureGeneratorRunning(80, 'observation');
      await built.routes.ensureGeneratorRunning(81, 'observation');

      // The window ends: the scheduler probes with the oldest session, whose
      // run then takes a long time (a slow init exec plus a slow observation).
      now += 10 * MINUTE;
      built.timers.runOnce(10 * MINUTE);
      built.timers.runOnce(0);
      await flush();
      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(typeof prober.quotaProbeClaimId).toBe('number');

      // Its claim goes stale while it is still running; the watchdog fires.
      now += QUOTA_PROBE_STALE_MS + 1;
      built.timers.runOnce(QUOTA_PROBE_STALE_MS);
      built.timers.runOnce(0);
      await flush();

      expect(built.codexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')!.probeClaimId).toBe(prober.quotaProbeClaimId!);
    });
  });
});
