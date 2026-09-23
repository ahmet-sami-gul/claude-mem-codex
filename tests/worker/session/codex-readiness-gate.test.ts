/**
 * The non-blocking codex readiness gate (M3, plan 3.5).
 *
 * The source is a plain double: nothing here spawns codex, and the gate's
 * contract is precisely that it never needs to — it reads a cached verdict,
 * starts the model-free self-check in the background, and books what it finds
 * where the backoff (dependency health) and the banner (observer health) read.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES,
  CODEX_GATE_RECHECK_MAX_BACKOFF_MS,
  CodexReadinessGate,
  codexProblemFromLockdown,
  isCodexReadinessSource,
  type CodexReadinessGateOptions,
  type CodexReadinessSnapshot,
} from '../../../src/services/worker/session/codex-readiness-gate.js';
import type { ObserverTurnAnsweredListener } from '../../../src/services/worker/session/observer-turn-signal.js';
import type { CodexLockdownResult } from '../../../src/services/worker/codex/codex-self-check.js';
import { ClassifiedProviderError } from '../../../src/services/worker/provider-errors.js';
import {
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  CODEX_CLI_SETUP_REMEDIATION,
  getDependencyStatus,
  recordCodexCliSetupRequired,
  resetDependencyStatusesForTesting,
} from '../../../src/shared/dependency-health.js';
import {
  isObserverUnhealthy,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
  recordObserverFailure,
} from '../../../src/shared/observer-health.js';
import { paths } from '../../../src/shared/paths.js';

const healthPath = (): string => join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);

function verdict(state: 'passed' | 'failed', overrides: Partial<CodexLockdownResult> = {}): CodexLockdownResult {
  return {
    state,
    binaryPath: '/opt/codex/bin/codex',
    cacheKey: 'key',
    version: '0.144.4',
    authMethod: state === 'passed' ? 'chatgpt' : 'unknown',
    failure: null,
    warnings: [],
    startedAt: 0,
    finishedAt: 1,
    ...overrides,
  };
}

function loggedOut(): CodexLockdownResult {
  return verdict('failed', {
    authMethod: 'not_logged_in',
    failure: {
      step: 'login_status',
      error: new ClassifiedProviderError('Codex is not logged in: Not logged in', {
        kind: 'auth_invalid',
        cause: null,
        code: 'codex_auth_invalid',
        action: 'Run `codex login` (ChatGPT sign-in).',
      }),
    },
  });
}

function versionTooNew(): CodexLockdownResult {
  return verdict('failed', {
    failure: {
      step: 'version',
      error: new ClassifiedProviderError('Codex CLI version is outside the tested range: codex-cli 0.150.0', {
        kind: 'setup_required',
        cause: null,
        code: 'codex_version_untested',
        action: 'Install a tested Codex CLI version or set CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION=true.',
      }),
    },
  });
}

/** A readiness source whose self-check the test finishes by hand. */
function fakeSource(initial: CodexReadinessSnapshot) {
  let snapshot = initial;
  let finish: ((result: CodexLockdownResult | null) => void) | null = null;
  const source = {
    readinessSnapshot: mock(() => snapshot),
    verifyLockdown: mock((_options?: { force?: boolean }) => new Promise<CodexLockdownResult | null>((resolve) => {
      finish = resolve;
    })),
  };
  return {
    source,
    setSnapshot(next: CodexReadinessSnapshot) {
      snapshot = next;
    },
    async finishCheck(result: CodexLockdownResult | null) {
      if (!finish) throw new Error('no self-check is running');
      const done = finish;
      finish = null;
      done(result);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

function buildGate(initial: CodexReadinessSnapshot, options: CodexReadinessGateOptions = {}) {
  const fake = fakeSource(initial);
  const onReady = mock((_scope?: 'all' | 'canary') => {});
  const onHeld = mock((_retryAtMs: number) => {});
  const gate = new CodexReadinessGate(fake.source, { onReady, onHeld }, options);
  return { ...fake, gate, onReady, onHeld };
}

/** Stands in for observer-turn-signal: "the model answered a turn for this session". */
function turnBus() {
  const listeners = new Set<ObserverTurnAnsweredListener>();
  return {
    subscribe: (listener: ObserverTurnAnsweredListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    answer(sessionDbId: number, provider: 'codex' | 'claude' = 'codex') {
      for (const listener of [...listeners]) listener({ sessionDbId, provider });
    },
    listening: () => listeners.size,
  };
}

/** A refusal only a real exec can produce: the self-check passes straight through it. */
function lockdownBreach(): ClassifiedProviderError {
  return new ClassifiedProviderError('Codex lockdown breach: 2 forbidden tool attempts in session 7', {
    kind: 'setup_required',
    cause: null,
    code: 'codex_lockdown_breach',
    action: 'See observer-audit.log; the provider stays disabled until the self-check passes again.',
  });
}

describe('CodexReadinessGate', () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  afterEach(() => {
    Date.now = realDateNow;
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  it('recognises a readiness source by shape', () => {
    expect(isCodexReadinessSource({ readinessSnapshot() {}, verifyLockdown() {} })).toBe(true);
    // The test doubles other suites pass as a codex agent.
    expect(isCodexReadinessSource({ startSession: async () => {} })).toBe(false);
    expect(isCodexReadinessSource(undefined)).toBe(false);
  });

  it('holds an unverified start, runs ONE background self-check, and answers synchronously', () => {
    const { gate, source } = buildGate({ state: 'unverified' });

    const first = gate.check(7, 'observation');
    expect(first).toEqual({ proceed: false, reason: 'self_check_started' });
    expect(source.verifyLockdown).toHaveBeenCalledTimes(1);
    expect(source.verifyLockdown.mock.calls[0][0]).toEqual({});
    expect(gate.isChecking()).toBe(true);

    // A burst of ingests while the check runs: no second check, no filesystem.
    for (let i = 0; i < 5; i += 1) {
      expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'self_check_running' });
    }
    expect(source.verifyLockdown).toHaveBeenCalledTimes(1);
    expect(source.readinessSnapshot).toHaveBeenCalledTimes(1);
  });

  it('joins a check someone else already started instead of starting another', () => {
    const { gate, source } = buildGate({ state: 'pending' });

    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'self_check_started' });
    expect(source.verifyLockdown).toHaveBeenCalledTimes(1);
  });

  it('resumes the waiting sessions when the self-check passes, then trusts the verdict for a while', async () => {
    const { gate, source, onReady, finishCheck, setSnapshot } = buildGate({ state: 'unverified' });
    gate.check(7, 'observation');

    setSnapshot({ state: 'passed' });
    await finishCheck(verdict('passed'));

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(gate.isChecking()).toBe(false);
    expect(gate.check(7, 'observation')).toEqual({ proceed: true });
    expect(gate.check(8, 'observation')).toEqual({ proceed: true });
    // The pass is memoized: no re-read per start.
    expect(source.readinessSnapshot).toHaveBeenCalledTimes(1);
    expect(getDependencyStatus('codex_cli')).toBeNull();
  });

  it('proceeds on a cached pass without starting anything or announcing a resume', () => {
    const { gate, source, onReady } = buildGate({ state: 'passed' });

    expect(gate.check(7, 'init')).toEqual({ proceed: true });
    expect(source.verifyLockdown).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('books a logged-out Codex as a login problem the banner shows at once', async () => {
    const { gate, onHeld, finishCheck } = buildGate({ state: 'unverified' });
    gate.check(7, 'observation');

    await finishCheck(loggedOut());

    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'auth_required' });
    const health = readObserverHealth(healthPath())!;
    expect(health.lastErrorProvider).toBe('codex');
    expect(health.lastErrorKind).toBe('auth_invalid');
    expect(health.lastErrorAction).toContain('codex login');
    expect(health.lastErrorAwaitingUserFix).toBe(true);
    expect(health.consecutiveFailures).toBe(1);
    // One is enough: the gate makes no second attempt that could be counted.
    expect(isObserverUnhealthy(health)).toBe(true);
    // ...and a re-check is arranged for when the backoff lifts.
    expect(onHeld).toHaveBeenCalledTimes(1);
    const retryAtMs = onHeld.mock.calls[0][0];
    expect(retryAtMs - Date.now()).toBeGreaterThan(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS - 1_000);
    expect(retryAtMs - Date.now()).toBeLessThanOrEqual(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);
  });

  it('books a missing binary with the install / CLAUDE_MEM_CODEX_PATH remedy, without probing', () => {
    const { gate, source } = buildGate({ state: 'binary_missing', message: 'codex not found on PATH' });

    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'binary_missing' });

    expect(source.verifyLockdown).not.toHaveBeenCalled();
    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
    const health = readObserverHealth(healthPath())!;
    expect(health.lastErrorKind).toBe('setup_required');
    expect(health.lastErrorAction).toContain('CLAUDE_MEM_CODEX_PATH');
    expect(health.lastErrorAction).toContain('Install the Codex CLI');
    expect(isObserverUnhealthy(health)).toBe(true);
  });

  it('answers from memory inside the backoff: no snapshot, no probe, no new record', () => {
    const { gate, source, onHeld } = buildGate({ state: 'binary_missing', message: 'codex not found on PATH' });
    gate.check(7, 'observation');
    const recordedAt = getDependencyStatus('codex_cli')!.recordedAtMs;

    for (let i = 0; i < 20; i += 1) {
      const decision = gate.check(7, 'observation');
      expect(decision.proceed).toBe(false);
      expect(!decision.proceed && decision.reason).toBe('backoff');
    }

    expect(source.readinessSnapshot).toHaveBeenCalledTimes(1);
    expect(source.verifyLockdown).not.toHaveBeenCalled();
    expect(readObserverHealth(healthPath())!.consecutiveFailures).toBe(1);
    expect(getDependencyStatus('codex_cli')!.recordedAtMs).toBe(recordedAt);
    // Each held call keeps the same re-check armed.
    expect(new Set(onHeld.mock.calls.map(([at]) => at)).size).toBe(1);
  });

  it('re-checks once the backoff lifts, and doubles the backoff while the problem persists', () => {
    const { gate, source } = buildGate({ state: 'binary_missing', message: 'codex not found on PATH' });
    const t0 = realDateNow();
    Date.now = () => t0;
    gate.check(7, 'observation');
    expect(gate.backoffMs()).toBe(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);

    Date.now = () => t0 + CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'binary_missing' });
    expect(source.readinessSnapshot).toHaveBeenCalledTimes(2);
    expect(gate.backoffMs()).toBe(2 * CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);

    // Still inside the doubled window.
    Date.now = () => t0 + 2 * CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
    expect(gate.check(7, 'observation')).toMatchObject({ proceed: false, reason: 'backoff' });
    expect(source.readinessSnapshot).toHaveBeenCalledTimes(2);

    Date.now = () => t0 + 3 * CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
    gate.check(7, 'observation');
    expect(source.readinessSnapshot).toHaveBeenCalledTimes(3);
  });

  it('caps the backoff, and a healthy run resets it', () => {
    const { gate } = buildGate({ state: 'passed' });
    for (let i = 0; i < 12; i += 1) {
      gate.noteProblem({ kind: 'auth_required', message: 'logged out' });
    }
    expect(gate.backoffMs()).toBe(CODEX_GATE_RECHECK_MAX_BACKOFF_MS);

    gate.noteHealthyRun();
    expect(gate.backoffMs()).toBe(CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS);
  });

  it('forces a fresh self-check when a problem is on record but the cached verdict says passed', async () => {
    const { gate, source, onReady, finishCheck } = buildGate({ state: 'passed' });
    const t0 = realDateNow();
    Date.now = () => t0;
    // A login problem on record while the old verdict is cached. (Booked
    // without an origin, i.e. one the self-check can see; the exec-time kind
    // — a 401 while `login status` still passes — gets a canary instead, see
    // the exec-time tests below.)
    gate.noteProblem({ kind: 'auth_required', message: 'Codex authentication failed: sign in again' });

    Date.now = () => t0 + CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
    expect(gate.check(7, 'codex-recheck')).toEqual({ proceed: false, reason: 'recheck_started' });
    expect(source.verifyLockdown.mock.calls[0][0]).toEqual({ force: true });

    await finishCheck(verdict('passed'));
    // Fixed: the record is cleared and everyone who waited is started.
    expect(getDependencyStatus('codex_cli')).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith('all');
  });

  it('books a self-check failure with the check\'s own remedy', async () => {
    const { gate, finishCheck } = buildGate({ state: 'unverified' });
    gate.check(7, 'observation');

    await finishCheck(versionTooNew());

    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
    const health = readObserverHealth(healthPath())!;
    expect(health.lastErrorMessage).toContain('version step');
    expect(health.lastErrorAction).toContain('CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION');
    expect(health.lastErrorCode).toBe('codex_version_untested');
  });

  it('treats an API-key login as a login problem, not an install problem', () => {
    const problem = codexProblemFromLockdown(verdict('failed', {
      authMethod: 'api_key',
      failure: {
        step: 'login_status',
        error: new ClassifiedProviderError('Codex is logged in with an API key, not ChatGPT', {
          kind: 'setup_required',
          cause: null,
          code: 'codex_api_key_login',
        }),
      },
    }));
    expect(problem.kind).toBe('auth_required');
    expect(problem.action).toContain('codex login');
  });

  it('restarts a check that merely had not run, instead of raising the banner', () => {
    const { gate, source } = buildGate({ state: 'unverified' });

    gate.onStartRefused(new ClassifiedProviderError('Codex observer is not ready: its lockdown self-check has not finished yet', {
      kind: 'setup_required',
      cause: null,
      code: 'codex_setup_required',
    }), 7);

    expect(source.verifyLockdown).toHaveBeenCalledTimes(1);
    expect(getDependencyStatus('codex_cli')).toBeNull();
    expect(existsSync(healthPath())).toBe(false);
  });

  it('settles a provider/cache disagreement with a forced check rather than looping', () => {
    const { gate, source, onReady } = buildGate({ state: 'passed' });

    gate.onStartRefused(new ClassifiedProviderError('Codex observer is not ready', {
      kind: 'setup_required',
      cause: null,
      code: 'codex_setup_required',
    }), 7);

    expect(source.verifyLockdown.mock.calls[0][0]).toEqual({ force: true });
    expect(onReady).not.toHaveBeenCalled();
    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'self_check_running' });
  });

  it('leaves a problem booked meanwhile alone when a start is refused as not-ready', () => {
    const { gate, source, onReady } = buildGate({ state: 'passed' });
    // Another session's exec hit a 401 while this start was on its way in.
    gate.noteProblem({ kind: 'auth_required', message: 'Codex authentication failed: sign in again' });

    gate.onStartRefused(new ClassifiedProviderError('Codex observer is not ready', {
      kind: 'setup_required',
      cause: null,
      code: 'codex_setup_required',
    }), 7);

    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'auth_required' });
    expect(source.verifyLockdown).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('books an exec-time setup failure (a lockdown breach) and backs off', () => {
    const { gate, onHeld } = buildGate({ state: 'passed' });

    gate.onStartRefused(new ClassifiedProviderError('Codex lockdown breach: repeated forbidden tool attempts', {
      kind: 'setup_required',
      cause: null,
      code: 'codex_lockdown_breach',
      action: 'See observer-audit.log; the provider stays disabled until the self-check passes again.',
    }), 7);

    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
    expect(readObserverHealth(healthPath())!.lastErrorCode).toBe('codex_lockdown_breach');
    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(gate.check(7, 'observation')).toMatchObject({ proceed: false, reason: 'backoff' });
  });

  it('books a self-check that could not even run, and does not stay "in flight"', async () => {
    const onReady = mock(() => {});
    const source = {
      readinessSnapshot: mock((): CodexReadinessSnapshot => ({ state: 'unverified' })),
      verifyLockdown: mock(() => Promise.reject(new Error('spawn EACCES'))),
    };
    const gate = new CodexReadinessGate(source, { onReady });

    gate.check(7, 'observation');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(gate.isChecking()).toBe(false);
    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
    expect(readObserverHealth(healthPath())!.lastErrorMessage).toContain('spawn EACCES');
  });

  it('never tells the user to restart for a setup problem the gate re-checks on its own', () => {
    expect(CODEX_CLI_SETUP_REMEDIATION).not.toContain('then restart');
    expect(CODEX_CLI_SETUP_REMEDIATION).toContain('CLAUDE_MEM_CODEX_PATH');
  });
});

describe('CodexReadinessGate — problems only a real exec can see', () => {
  const realDateNow = Date.now;
  const base = CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;

  beforeEach(() => {
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  afterEach(() => {
    Date.now = realDateNow;
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  it('lets ONE canary through when the re-check passes, and starts the rest only once it answers', async () => {
    const turns = turnBus();
    const { gate, onReady, finishCheck } = buildGate({ state: 'passed' }, { onTurnAnswered: turns.subscribe });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);

    now += base;
    expect(gate.check(7, 'codex-recheck')).toEqual({ proceed: false, reason: 'recheck_started' });
    await finishCheck(verdict('passed'));

    // The self-check passed before the breach too: one canary, not everyone.
    expect(onReady.mock.calls).toEqual([['canary']]);
    expect(gate.isAwaitingCanary()).toBe(true);
    expect(getDependencyStatus('codex_cli')).toBeNull();
    // A self-check cannot clear a banner a real run raised.
    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(true);

    // The first start becomes the canary; everyone else waits for its answer.
    expect(gate.check(8, 'codex-canary')).toEqual({ proceed: true });
    expect(gate.canarySessionId()).toBe(8);
    expect(gate.check(9, 'observation')).toEqual({ proceed: false, reason: 'canary_running' });
    expect(gate.check(8, 'observation')).toEqual({ proceed: true });

    // A bystander's answer, or another provider's, proves nothing.
    turns.answer(9);
    turns.answer(8, 'claude');
    expect(onReady).toHaveBeenCalledTimes(1);

    // The canary's model answers: everyone goes, and the banner clears.
    turns.answer(8);
    expect(onReady.mock.calls).toEqual([['canary'], ['all']]);
    expect(gate.isAwaitingCanary()).toBe(false);
    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(false);
    expect(gate.check(9, 'observation')).toEqual({ proceed: true });
    // Nothing left to listen for.
    expect(turns.listening()).toBe(0);
    expect(gate.backoffMs()).toBe(base);
  });

  it('holds everyone again, with a longer backoff, when the canary fails the same way', async () => {
    const turns = turnBus();
    const { gate, onHeld, finishCheck } = buildGate({ state: 'passed' }, { onTurnAnswered: turns.subscribe });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);
    now += base;
    gate.check(7, 'codex-recheck');
    await finishCheck(verdict('passed'));
    expect(gate.check(7, 'codex-canary')).toEqual({ proceed: true });

    gate.onStartRefused(lockdownBreach(), 7);
    gate.noteRunEnded(7);

    expect(gate.isAwaitingCanary()).toBe(false);
    expect(getDependencyStatus('codex_cli')).toMatchObject({ kind: 'setup_required' });
    expect(gate.backoffMs()).toBe(2 * base);
    expect(gate.check(8, 'observation')).toMatchObject({ proceed: false, reason: 'backoff' });
    expect(onHeld).toHaveBeenLastCalledWith(getDependencyStatus('codex_cli')!.recordedAtMs + 2 * base);
  });

  it('counts one failed cycle once, however many sessions it let through', () => {
    const { gate } = buildGate({ state: 'passed' });

    // Three running sessions hit the same exec-time problem.
    gate.onStartRefused(lockdownBreach(), 1);
    gate.onStartRefused(lockdownBreach(), 2);
    gate.onStartRefused(lockdownBreach(), 3);

    expect(gate.backoffMs()).toBe(base);
  });

  it('reopens the canary slot when the canary run ends without an answer, without starting anything itself', async () => {
    const { gate, onReady, finishCheck } = buildGate({ state: 'passed' });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);
    now += base;
    gate.check(7, 'codex-recheck');
    await finishCheck(verdict('passed'));
    expect(gate.check(7, 'codex-canary')).toEqual({ proceed: true });

    // Its run paused on transport (or idled out): inconclusive.
    gate.noteRunEnded(7);

    expect(gate.isAwaitingCanary()).toBe(true);
    expect(gate.canarySessionId()).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
    // The next start — that session's own scheduled resume, or another's
    // tool call — is the new canary.
    expect(gate.check(8, 'observation')).toEqual({ proceed: true });
    expect(gate.canarySessionId()).toBe(8);
  });

  it('frees the canary slot when the admitted start did not happen (a quota refusal after the gate)', async () => {
    const { gate, finishCheck } = buildGate({ state: 'passed' });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);
    now += base;
    gate.check(7, 'codex-recheck');
    await finishCheck(verdict('passed'));

    expect(gate.check(7, 'codex-canary')).toEqual({ proceed: true });
    gate.releaseStart(7);

    expect(gate.canarySessionId()).toBeNull();
    expect(gate.check(8, 'observation')).toEqual({ proceed: true });
  });

  it(`stops re-enabling on its own after ${CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES} automatic canaries, until fresh activity`, async () => {
    const { gate, source, onReady, finishCheck } = buildGate({ state: 'passed' });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);

    for (let cycle = 1; cycle <= CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES; cycle += 1) {
      now += gate.backoffMs();
      gate.requestRecheck();
      await finishCheck(verdict('passed'));
      expect(onReady).toHaveBeenLastCalledWith('canary');
      // The canary pays its exec and hits the breach again.
      expect(gate.check(7, 'codex-canary')).toEqual({ proceed: true });
      gate.onStartRefused(lockdownBreach(), 7);
      gate.noteRunEnded(7);
    }
    expect(source.verifyLockdown).toHaveBeenCalledTimes(CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES);

    // The re-check window arrives again: no self-check, no canary.
    now += gate.backoffMs();
    gate.requestRecheck();
    expect(source.verifyLockdown).toHaveBeenCalledTimes(CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES);
    expect(gate.check(7, 'codex-recheck')).toEqual({ proceed: false, reason: 'awaiting_activity' });
    expect(gate.check(7, 'quota-cleared')).toEqual({ proceed: false, reason: 'awaiting_activity' });
    expect(onReady).toHaveBeenCalledTimes(CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES);

    // A captured tool call still tries (bounded by the backoff).
    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'recheck_started' });
    expect(source.verifyLockdown).toHaveBeenCalledTimes(CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES + 1);
    await finishCheck(verdict('passed'));
    expect(onReady).toHaveBeenLastCalledWith('canary');
  });

  it('a changed binary, login or setting (no cached verdict) earns a fresh set of automatic re-enables', async () => {
    const { gate, source, setSnapshot, finishCheck } = buildGate({ state: 'passed' }, { maxAutomaticExecReenables: 1 });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);
    now += gate.backoffMs();
    gate.requestRecheck();
    await finishCheck(verdict('passed'));
    gate.check(7, 'codex-canary');
    gate.onStartRefused(lockdownBreach(), 7);
    gate.noteRunEnded(7);

    // Spent. A tool call arrives after the user updated codex: the verdict
    // cache has nothing for the new fingerprint.
    now += gate.backoffMs();
    setSnapshot({ state: 'unverified' });
    expect(gate.check(7, 'observation')).toEqual({ proceed: false, reason: 'recheck_started' });
    await finishCheck(verdict('passed'));
    gate.check(7, 'codex-canary');
    gate.onStartRefused(lockdownBreach(), 7);
    gate.noteRunEnded(7);

    // The automatic path works again for the new setup.
    now += gate.backoffMs();
    setSnapshot({ state: 'passed' });
    const before = source.verifyLockdown.mock.calls.length;
    gate.requestRecheck();
    expect(source.verifyLockdown).toHaveBeenCalledTimes(before + 1);
  });

  it('past the cap, polls the setup fingerprint cheaply and re-checks on its own once it changes', async () => {
    const { gate, source, onHeld, finishCheck } = buildGate({ state: 'passed' }, { maxAutomaticExecReenables: 1 });
    // What verdict('passed') reports as its cacheKey: the setup it verified.
    let fingerprint = 'key';
    const readinessFingerprint = mock(() => fingerprint);
    Object.assign(source, { readinessFingerprint });
    let now = realDateNow();
    Date.now = () => now;
    gate.onStartRefused(lockdownBreach(), 7);
    now += gate.backoffMs();
    gate.requestRecheck();
    await finishCheck(verdict('passed'));
    gate.check(7, 'codex-canary');
    gate.onStartRefused(lockdownBreach(), 7);
    gate.noteRunEnded(7);

    // Spent, same setup: no self-check — only a slow, spawn-free poll.
    now += gate.backoffMs();
    onHeld.mockClear();
    gate.requestRecheck();
    expect(source.verifyLockdown).toHaveBeenCalledTimes(1);
    expect(onHeld.mock.calls).toEqual([[now + CODEX_GATE_RECHECK_MAX_BACKOFF_MS]]);

    // The user updates codex (or logs in again). No tool call needed.
    fingerprint = 'key-after-update';
    now += CODEX_GATE_RECHECK_MAX_BACKOFF_MS;
    gate.requestRecheck();
    expect(source.verifyLockdown).toHaveBeenCalledTimes(2);
    expect(source.verifyLockdown.mock.calls[1][0]).toEqual({ force: true });
  });

  it('ends a problem streak only on an answer from a run admitted after the problem', async () => {
    const turns = turnBus();
    const { gate, finishCheck } = buildGate({ state: 'passed' }, { onTurnAnswered: turns.subscribe });
    let now = realDateNow();
    Date.now = () => now;

    // Admitted while healthy; then two problems are booked while it runs.
    expect(gate.check(5, 'observation')).toEqual({ proceed: true });
    gate.noteProblem({ kind: 'auth_required', message: 'Codex is not logged in' });
    gate.noteProblem({ kind: 'auth_required', message: 'Codex is not logged in' });
    expect(gate.backoffMs()).toBe(2 * base);

    // The run that predates the problem answers, then ends without a login
    // problem: neither is proof the problem is gone.
    turns.answer(5);
    gate.noteRunEnded(5);
    expect(gate.backoffMs()).toBe(2 * base);

    // The login is fixed and the re-check passes; a run admitted AFTER that
    // answers — that one ends the streak.
    now += 2 * base;
    expect(gate.check(6, 'observation')).toEqual({ proceed: false, reason: 'recheck_started' });
    await finishCheck(verdict('passed'));
    expect(gate.check(6, 'quota-cleared')).toEqual({ proceed: true });
    turns.answer(6);
    expect(gate.backoffMs()).toBe(base);
    expect(turns.listening()).toBe(0);
  });

  it('never ends the streak just because a run exited without a login problem', () => {
    const { gate } = buildGate({ state: 'passed' });
    gate.noteProblem({ kind: 'auth_required', message: 'Codex is not logged in' });
    gate.noteProblem({ kind: 'auth_required', message: 'Codex is not logged in' });

    gate.noteRunEnded(5);
    gate.noteRunEnded(6);

    expect(gate.backoffMs()).toBe(2 * base);
  });
});

describe('CodexReadinessGate — the direct re-check, boot warm-up and banner recovery', () => {
  const realDateNow = Date.now;
  const base = CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;

  beforeEach(() => {
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  afterEach(() => {
    Date.now = realDateNow;
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
  });

  it('requestRecheck re-arms the hold inside the backoff, without reading readiness', () => {
    const { gate, source, onHeld } = buildGate({ state: 'binary_missing', message: 'codex not found on PATH' });
    gate.check(7, 'observation');
    const snapshotsBefore = source.readinessSnapshot.mock.calls.length;
    onHeld.mockClear();

    gate.requestRecheck();

    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(onHeld.mock.calls[0][0]).toBe(getDependencyStatus('codex_cli')!.recordedAtMs + base);
    expect(source.readinessSnapshot.mock.calls.length).toBe(snapshotsBefore);
  });

  it('requestRecheck re-checks once the backoff lifts, with no session involved', async () => {
    const { gate, source, onReady, setSnapshot, finishCheck } = buildGate({ state: 'passed' });
    let now = realDateNow();
    Date.now = () => now;
    gate.noteProblem({ kind: 'auth_required', message: 'Codex is not logged in' });

    now += base;
    gate.requestRecheck();
    expect(source.verifyLockdown.mock.calls).toEqual([[{ force: true }]]);

    setSnapshot({ state: 'passed' });
    await finishCheck(verdict('passed'));
    expect(onReady.mock.calls).toEqual([['all']]);
  });

  it('requestRecheck with nothing on record starts whoever still waits', () => {
    const { gate, source, onReady } = buildGate({ state: 'passed' });
    gate.requestRecheck();
    expect(onReady.mock.calls).toEqual([['all']]);
    expect(source.verifyLockdown).not.toHaveBeenCalled();
  });

  it('clears the fix-it banner as soon as a re-check shows the login is fixed, even with nothing pending', async () => {
    const { gate, setSnapshot, finishCheck } = buildGate({ state: 'unverified' });
    let now = realDateNow();
    Date.now = () => now;
    gate.check(7, 'observation');
    await finishCheck(loggedOut());
    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(true);

    // The user runs `codex login`; the scheduled re-check passes.
    now += base;
    setSnapshot({ state: 'failed', result: loggedOut() });
    gate.requestRecheck();
    await finishCheck(verdict('passed'));

    const health = readObserverHealth(healthPath())!;
    expect(isObserverUnhealthy(health)).toBe(false);
    expect(health.lastErrorAwaitingUserFix).toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it('settles the verdict at boot and clears a stale fix-it banner left by the previous process', async () => {
    recordObserverFailure('codex', {
      message: 'Codex is not logged in',
      kind: 'auth_invalid',
      alertThreshold: 1,
      awaitingUserFix: true,
      origin: 'check',
    }, healthPath());
    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(true);
    const { gate, source, finishCheck } = buildGate({ state: 'unverified' });

    gate.warmUp();
    expect(source.verifyLockdown.mock.calls).toEqual([[{}]]);
    await finishCheck(verdict('passed'));

    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(false);
  });

  it('at boot, leaves a banner a real run raised for a real run to clear', async () => {
    recordObserverFailure('codex', {
      message: 'Codex lockdown breach',
      kind: 'setup_required',
      code: 'codex_lockdown_breach',
      alertThreshold: 1,
      awaitingUserFix: true,
      origin: 'run',
    }, healthPath());
    const { gate, finishCheck } = buildGate({ state: 'unverified' });

    gate.warmUp();
    await finishCheck(verdict('passed'));

    expect(isObserverUnhealthy(readObserverHealth(healthPath()))).toBe(true);
  });

  it('does nothing at boot when a check or a recorded problem already owns the verdict', () => {
    recordCodexCliSetupRequired('Codex CLI preflight failed: not found');
    const { gate, source } = buildGate({ state: 'unverified' });

    gate.warmUp();

    expect(source.readinessSnapshot).not.toHaveBeenCalled();
    expect(source.verifyLockdown).not.toHaveBeenCalled();
  });
});
