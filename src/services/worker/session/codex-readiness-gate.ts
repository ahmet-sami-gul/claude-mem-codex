/**
 * The non-blocking codex readiness gate (M3, plan 3.5).
 *
 * Sits beside the Claude setup gate in SessionRoutes and answers one question
 * before a Codex generator may start: is there a resolved binary that has
 * PASSED the lockdown self-check, and if not, may the worker look again yet?
 *
 * THREE CONSTRAINTS SHAPE IT.
 *
 *   1. Ingest awaits it. `ingestObservation` awaits `ensureGeneratorRunning`
 *      (http/shared.ts), so `check()` is synchronous and never waits on a
 *      probe: a self-check that has not run yet is STARTED in the background
 *      (single-flight) and the start is simply refused for now. When the check
 *      finishes, the `onReady` hook starts every session that waited — the
 *      hold costs a second or two of latency, never a lost observation.
 *   2. No per-tool-call cost while broken. A logged-out or missing Codex is a
 *      normal state (a Plus user who has not run `codex login` yet), so a held
 *      gate answers from memory: the in-flight flag, then the `codex_cli`
 *      dependency record and its backoff. Only once the backoff lifts does it
 *      touch the filesystem or start another (model-free) re-check. The
 *      backoff starts at 30 s and doubles per failed re-check cycle (however
 *      many sessions one cycle let through) up to
 *      CODEX_GATE_RECHECK_MAX_BACKOFF_MS; only an answered turn from a run
 *      admitted after the problem resets it.
 *   3. It never spends. Nothing here runs `codex exec`: the snapshot reads
 *      caches, and the re-check is the five-probe self-check (`--version`,
 *      `login status`, `debug models`, `features list`, `debug prompt-input`),
 *      none of which reaches the user's plan.
 *
 * Every problem it finds ends in exactly one place: a `codex_cli` dependency
 * record (the backoff) plus an observer-health record with alert threshold 1
 * (plan 3.6 (b): the gate stops further attempts, so the default "3 in a row"
 * would never be reached and the banner would never show).
 *
 * TWO KINDS OF PROBLEM. A problem the self-check can see (no binary, logged
 * out, an API-key login, a failed probe) is fixed when a re-check passes, and
 * every waiting session is started at once. A problem only a real exec can
 * see (a lockdown breach, a model the server rejects, a plan without Codex, a
 * 401 while `codex login status` still reports ChatGPT) is NOT disproved by a
 * passing self-check — it passed before the problem too. For those the gate
 * lets ONE waiting session through as a canary and starts the rest only once
 * the canary's model has actually answered (observer-turn-signal). Automatic
 * re-enables of that kind are capped per problem streak
 * (CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES); past the cap only fresh activity
 * (a captured tool call, /summarize, /init) tries again. Without this, a
 * deterministic exec-time failure turned the gate into a timer that started
 * every waiting session — each paying an exec — every few minutes, forever.
 */

import { logger } from '../../../utils/logger.js';
import type { ClassifiedProviderError } from '../provider-errors.js';
import type { CodexLockdownResult } from '../codex/codex-self-check.js';
import { isAutomaticResumeSource } from './observer-resume-scheduler.js';
import { onObserverTurnAnswered, type ObserverTurnAnsweredListener } from './observer-turn-signal.js';
import {
  CODEX_CLI_AUTH_REMEDIATION,
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  CODEX_CLI_SETUP_REMEDIATION,
  clearDependencyStatus,
  getDependencyStatus,
  isDependencyStatusInCooldown,
  recordCodexAuthRequired,
  recordCodexCliSetupRequired,
  type DependencyStatus,
} from '../../../shared/dependency-health.js';
import {
  OBSERVER_GATED_FAILURE_ALERT_THRESHOLD,
  recordObserverFailure,
  recordObserverRecovered,
} from '../../../shared/observer-health.js';

/** What the provider can say about its readiness without spawning anything. */
export type CodexReadinessSnapshot =
  | { state: 'passed' }
  /** No self-check has run for the current binary/login fingerprint (or it expired). */
  | { state: 'unverified' }
  /** A self-check for the current fingerprint is running. */
  | { state: 'pending' }
  | { state: 'binary_missing'; message: string }
  | { state: 'failed'; result: CodexLockdownResult };

/** Implemented by CodexProvider; a plain object in tests. */
export interface CodexReadinessSource {
  /** Cheap, synchronous, never spawns. */
  readinessSnapshot(): CodexReadinessSnapshot;
  /** Start or join the self-check; `force` re-runs a cached verdict. Never spends. */
  verifyLockdown(options?: { force?: boolean }): Promise<CodexLockdownResult | null>;
  /**
   * Optional. Cheap, synchronous, never spawns: the key a verdict would be
   * cached under right now (binary, login, codex settings) — the same value a
   * finished check reports as `cacheKey`. Lets the gate notice a changed setup
   * once an exec-time problem has used up its automatic re-checks.
   */
  readinessFingerprint?(): string | null;
}

export function isCodexReadinessSource(value: unknown): value is CodexReadinessSource {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<CodexReadinessSource>).readinessSnapshot === 'function'
    && typeof (value as Partial<CodexReadinessSource>).verifyLockdown === 'function';
}

export type CodexProblemKind = 'setup_required' | 'auth_required';

/**
 * Where a problem was seen. `'self_check'`: the model-free self-check (or the
 * binary resolution) sees it, so a passing re-check disproves it. `'exec'`: only
 * a real exec saw it, so only a real run the model answers disproves it.
 */
export type CodexProblemOrigin = 'self_check' | 'exec';

export interface CodexProblem {
  kind: CodexProblemKind;
  message: string;
  code?: string;
  action?: string;
  /** Defaults to `'self_check'`. */
  origin?: CodexProblemOrigin;
}

/** Ceiling for the doubling re-check backoff. */
export const CODEX_GATE_RECHECK_MAX_BACKOFF_MS = 10 * 60_000;

/**
 * How long a passing snapshot is trusted without asking again. The snapshot
 * itself is cheap but not free (a settings read, a realpath and two stats), and
 * the provider re-verifies at `startSession` anyway, so the gate only needs to
 * be right often enough not to hold a healthy observer.
 */
export const CODEX_GATE_READY_TTL_MS = 30_000;

/**
 * Book a codex setup/login problem where the gate and the user both see it:
 * the `codex_cli` dependency record (whose age drives the gate's backoff and
 * which /api/health shows) and the observer-health ledger (which drives the
 * session-start banner), alerting at the first occurrence and without a
 * restart remedy.
 *
 * Standalone so the route can book an exec-time login failure even for a codex
 * agent that has no gate.
 */
export function recordCodexProblem(problem: CodexProblem): DependencyStatus {
  const auth = problem.kind === 'auth_required';
  const status = auth ? recordCodexAuthRequired(problem.message) : recordCodexCliSetupRequired(problem.message);
  recordObserverFailure('codex', {
    message: problem.message,
    kind: auth ? 'auth_invalid' : 'setup_required',
    ...(problem.code ? { code: problem.code } : {}),
    action: problem.action ?? (auth ? CODEX_CLI_AUTH_REMEDIATION : CODEX_CLI_SETUP_REMEDIATION),
    alertThreshold: OBSERVER_GATED_FAILURE_ALERT_THRESHOLD,
    awaitingUserFix: true,
    // Persisted so a passing self-check after a worker restart (the gate's
    // own memory is gone by then) can tell whether it may clear the banner.
    origin: problem.origin === 'exec' ? 'run' : 'check',
  });
  return status;
}

/** A logged-out, API-key or rejected login is a login problem; the rest is setup. */
function isLoginFailure(error: ClassifiedProviderError | null | undefined): boolean {
  return error?.kind === 'auth_invalid' || error?.code === 'codex_api_key_login';
}

/** The problem a failed self-check verdict describes. */
export function codexProblemFromLockdown(result: CodexLockdownResult): CodexProblem {
  const failure = result.failure;
  const auth = result.authMethod === 'not_logged_in'
    || result.authMethod === 'api_key'
    || isLoginFailure(failure?.error);
  return {
    kind: auth ? 'auth_required' : 'setup_required',
    message: `Codex lockdown self-check failed at the ${failure?.step ?? 'unknown'} step: ${failure?.error.message ?? 'no detail'}`,
    ...(failure?.error.code ? { code: failure.error.code } : {}),
    action: auth ? CODEX_CLI_AUTH_REMEDIATION : (failure?.error.action ?? CODEX_CLI_SETUP_REMEDIATION),
  };
}

/** The problem an exec-time refusal describes (lockdown breach, bad invocation, login lost mid-session...). */
export function codexProblemFromError(error: ClassifiedProviderError): CodexProblem {
  const auth = isLoginFailure(error);
  return {
    kind: auth ? 'auth_required' : 'setup_required',
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    action: auth ? CODEX_CLI_AUTH_REMEDIATION : (error.action ?? CODEX_CLI_SETUP_REMEDIATION),
    origin: 'exec',
  };
}

/** The provider's own "not ready" refusal (CodexProvider.missingApiKeyError). */
const CODEX_NOT_READY_CODE = 'codex_setup_required';

export type CodexGateBlockReason =
  /** A self-check or re-check is running; its result will resume or re-hold. */
  | 'self_check_running'
  /** A recorded setup/login problem is inside its backoff. */
  | 'backoff'
  /** No verdict yet: a self-check was just started. */
  | 'self_check_started'
  /** The backoff lifted: a forced re-check was just started. */
  | 'recheck_started'
  | 'binary_missing'
  | 'self_check_failed'
  /** The provider could not even report its readiness. */
  | 'readiness_unavailable'
  /** Another session is the canary proving an exec-time fix; wait for its answer. */
  | 'canary_running'
  /**
   * An exec-time problem used up its automatic re-enables; only fresh activity
   * (a captured tool call, /summarize, /init) tries again.
   */
  | 'awaiting_activity';

export type CodexGateDecision =
  | { proceed: true }
  | { proceed: false; reason: CodexGateBlockReason; retryAtMs?: number };

/**
 * What a ready gate wants started: `'all'` — every waiting session (a problem
 * the self-check disproved, or a canary that answered); `'canary'` — ONE
 * waiting session, to prove an exec-time fix before the rest go.
 */
export type CodexReadyScope = 'all' | 'canary';

export interface CodexReadinessGateHooks {
  /** Codex became usable after a hold: start the waiting sessions (see CodexReadyScope). */
  onReady?: (scope: CodexReadyScope) => void;
  /** Codex is held until `retryAtMs`: arrange a re-check for then. */
  onHeld?: (retryAtMs: number) => void;
}

export interface CodexReadinessGateOptions {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  readyTtlMs?: number;
  /** Cap on automatic re-enables per exec-time problem streak. */
  maxAutomaticExecReenables?: number;
  /** Test seam: where "the model answered a turn" is heard. */
  onTurnAnswered?: (listener: ObserverTurnAnsweredListener) => () => void;
}

/**
 * Automatic re-enables (scheduler-driven re-checks that let a canary through)
 * allowed per exec-time problem streak. A lockdown breach costs its canary up
 * to three execs (init plus two tool-attempt turns), so this bounds an idle
 * machine with a deterministic exec-time failure to about nine execs per
 * streak; after that only fresh activity — which the user is present for —
 * tries again, at most once per (capped) backoff.
 */
export const CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES = 3;

export class CodexReadinessGate {
  /** The background self-check / re-check, if one is running. */
  private inFlight: Promise<void> | null = null;
  /** Whether the running check was started by the scheduler rather than fresh activity. */
  private inFlightAutomatic = false;
  /** A passing snapshot is trusted until then. */
  private readyUntilMs = 0;
  /** Re-check cycles in a row that found (or were followed by) a problem; drives the backoff. */
  private consecutiveProblems = 0;
  /**
   * An exec-time problem was booked and no run has answered since. Sticky
   * across a self-check problem that arrives meanwhile (a logout during the
   * wait): passing the self-check afterwards still proves only the model-free
   * half, so the next re-enable is still a canary.
   */
  private execProofOwed = false;
  /**
   * Bumped on every problem booked. A run admitted at the current value has
   * seen no problem since it was let through, which is what lets its answer
   * end the streak (a run admitted before the problem proves nothing).
   */
  private problemSeq = 0;
  /**
   * Bumped each time starts are re-enabled after a problem (a passing re-check
   * or a canary). Exec-time problems count toward the streak once per value:
   * N sessions refused after one re-enable are one failed cycle, not N.
   */
  private enableEpoch = 0;
  /** `enableEpoch` at which an exec-time problem last counted toward the streak. */
  private execProblemEpoch = -1;
  /** Automatic re-enables spent on the current exec-time problem streak. */
  private automaticExecReenables = 0;
  /**
   * The self-check key (binary, login, codex settings) the last canary was let
   * through under. Once the automatic re-enables are spent, a different key is
   * a changed setup — worth trying again without waiting for a tool call.
   */
  private canaryFingerprint: string | null = null;
  /**
   * The canary proving an exec-time fix: the one session let through
   * (`sessionDbId`, null until one claims it) while everyone else waits.
   */
  private canary: { sessionDbId: number | null } | null = null;
  /** sessionDbId -> `problemSeq` when its current run was admitted. */
  private readonly admissions = new Map<number, number>();
  private unsubscribeTurns: (() => void) | null = null;

  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly readyTtlMs: number;
  private readonly maxAutomaticExecReenables: number;
  private readonly subscribeToTurns: (listener: ObserverTurnAnsweredListener) => () => void;

  constructor(
    private readonly source: CodexReadinessSource,
    private readonly hooks: CodexReadinessGateHooks = {},
    options: CodexReadinessGateOptions = {},
  ) {
    this.baseBackoffMs = options.baseBackoffMs ?? CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS;
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? CODEX_GATE_RECHECK_MAX_BACKOFF_MS);
    this.readyTtlMs = options.readyTtlMs ?? CODEX_GATE_READY_TTL_MS;
    this.maxAutomaticExecReenables = options.maxAutomaticExecReenables ?? CODEX_GATE_MAX_AUTOMATIC_EXEC_REENABLES;
    this.subscribeToTurns = options.onTurnAnswered ?? onObserverTurnAnswered;
  }

  /** The hold that applies to the current problem streak. */
  backoffMs(): number {
    const streak = Math.max(1, this.consecutiveProblems);
    return Math.min(this.baseBackoffMs * 2 ** (streak - 1), this.maxBackoffMs);
  }

  /** True while a background self-check or re-check is running. */
  isChecking(): boolean {
    return this.inFlight !== null;
  }

  /** The session currently allowed through as the canary, or null (none, or not claimed yet). */
  canarySessionId(): number | null {
    return this.canary?.sessionDbId ?? null;
  }

  /** True while an exec-time fix is waiting for its canary's answer. */
  isAwaitingCanary(): boolean {
    return this.canary !== null;
  }

  /**
   * May a Codex generator start now? Synchronous by contract — see the module
   * header. A refusal starts whatever background work will lift it.
   *
   * A `proceed` is an admission: the route must call `releaseStart` if the
   * start then does not happen (a quota refusal after the gate), and
   * `noteRunEnded` when the run it started ends.
   */
  check(sessionDbId: number, source: string): CodexGateDecision {
    const decision = this.decide(sessionDbId, source);
    if (decision.proceed) this.admissions.set(sessionDbId, this.problemSeq);
    return decision;
  }

  private decide(sessionDbId: number, source: string): CodexGateDecision {
    if (this.inFlight) {
      logger.debug('SESSION', 'Holding the Codex generator start while its readiness check runs', { sessionId: sessionDbId, source });
      return { proceed: false, reason: 'self_check_running' };
    }

    const problem = currentCodexProblem();
    if (problem) {
      const backoffMs = this.backoffMs();
      if (isDependencyStatusInCooldown(problem, backoffMs)) {
        const retryAtMs = problem.recordedAtMs + backoffMs;
        logger.debug('SESSION', 'Holding the Codex generator start until its setup/login problem is re-checked', {
          sessionId: sessionDbId,
          source,
          status: problem.kind,
          retryInMs: Math.max(0, retryAtMs - Date.now()),
        });
        // Idempotent: keeps a re-check armed for when this lifts even if the
        // timer that was armed with the record has since fired early.
        this.hooks.onHeld?.(retryAtMs);
        return { proceed: false, reason: 'backoff', retryAtMs };
      }
      if (this.automaticReenablesSpent(source)) {
        logger.debug('SESSION', 'Holding the Codex generator start: its exec-time problem used up its automatic re-checks; the next captured tool call re-checks', {
          sessionId: sessionDbId,
          source,
          automaticReenables: this.automaticExecReenables,
        });
        return { proceed: false, reason: 'awaiting_activity' };
      }
      return this.evaluate(sessionDbId, source, true);
    }

    if (this.canary) {
      if (this.canary.sessionDbId === null || this.canary.sessionDbId === sessionDbId) {
        if (this.canary.sessionDbId === null) {
          logger.info('SESSION', 'Letting one Codex session through as the canary for an exec-time fix; the rest wait for its answer', {
            sessionId: sessionDbId,
            source,
          });
        }
        this.canary.sessionDbId = sessionDbId;
        return { proceed: true };
      }
      logger.debug('SESSION', 'Holding the Codex generator start while another session proves the fix', {
        sessionId: sessionDbId,
        source,
        canarySessionId: this.canary.sessionDbId,
      });
      return { proceed: false, reason: 'canary_running' };
    }

    if (Date.now() < this.readyUntilMs) return { proceed: true };
    return this.evaluate(sessionDbId, source, false);
  }

  /**
   * True when an exec-time problem has used up its automatic re-enables and
   * this attempt is automatic too. Fresh activity is never refused here: the
   * user is present for it, and the backoff still bounds it.
   */
  private automaticReenablesSpent(source: string): boolean {
    if (!this.execProofOwed || !isAutomaticResumeSource(source)) return false;
    if (this.automaticExecReenables < this.maxAutomaticExecReenables) return false;
    if (this.setupChangedSinceCanary()) {
      logger.info('SESSION', 'Codex binary, login or settings changed since its last canary; re-checking on its own again', {
        automaticReenables: this.automaticExecReenables,
      });
      this.automaticExecReenables = 0;
      return false;
    }
    return true;
  }

  /** A changed self-check key since the last canary; false when either is unknown. */
  private setupChangedSinceCanary(): boolean {
    if (this.canaryFingerprint === null || !this.source.readinessFingerprint) return false;
    let current: string | null;
    try {
      current = this.source.readinessFingerprint();
    } catch (error: unknown) {
      logger.debug('SESSION', 'Could not fingerprint the Codex setup', {},
        error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    return current !== null && current !== this.canaryFingerprint;
  }

  /**
   * The re-check window arrived (the resume scheduler's dependency timer): look
   * again NOW, without routing through one session's start — an
   * overflow-paused session would return before reaching the gate, and nothing
   * would then re-check or re-arm. Every path ends in a running check, a
   * re-armed hold, a drain, or (past the automatic cap) an explicit wait for
   * fresh activity.
   */
  requestRecheck(): void {
    if (this.inFlight) return;
    const problem = currentCodexProblem();
    if (!problem) {
      // Nothing on record any more (cleared meanwhile). Offer the canary slot
      // if one is open, otherwise start whoever is still waiting.
      if (this.canary) {
        if (this.canary.sessionDbId === null) this.hooks.onReady?.('canary');
        return;
      }
      this.hooks.onReady?.('all');
      return;
    }
    const backoffMs = this.backoffMs();
    if (isDependencyStatusInCooldown(problem, backoffMs)) {
      this.hooks.onHeld?.(problem.recordedAtMs + backoffMs);
      return;
    }
    if (this.automaticReenablesSpent('codex-recheck')) {
      logger.info('SESSION', 'Codex exec-time problem used up its automatic re-checks; waiting for a captured tool call or a changed Codex setup before trying again', {
        automaticReenables: this.automaticExecReenables,
        status: problem.kind,
      });
      // Keep looking for a changed binary, login or settings at the slowest
      // cadence — a fingerprint read, nothing spawned — so a fix the user makes
      // while no tool call arrives is still noticed.
      this.hooks.onHeld?.(Date.now() + this.maxBackoffMs);
      return;
    }
    this.evaluate(null, 'codex-recheck', true);
  }

  /**
   * Boot: when nothing is known yet, start the self-check in the background so
   * the verdict (and a stale fix-it banner left in observer-health.json by the
   * previous process) is settled before the first session asks. Never blocks,
   * never spends; a no-op when a check or a recorded problem already owns it.
   */
  warmUp(): void {
    if (this.inFlight || currentCodexProblem()) return;
    let snapshot: CodexReadinessSnapshot;
    try {
      snapshot = this.source.readinessSnapshot();
    } catch (error: unknown) {
      logger.debug('SESSION', 'Could not read Codex readiness at boot; the first start will check', {},
        error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (snapshot.state === 'unverified' || snapshot.state === 'pending') {
      this.startCheck(false, null, 'boot');
    } else if (snapshot.state === 'passed') {
      recordObserverRecovered('codex', 'check');
    }
  }

  /**
   * The provider refused a start with `setup_required` after the gate let it
   * through (the route's `.catch`). Sorts "not verified YET" — a cached pass
   * that lapsed, a login that rewrote auth.json — from a real problem, so the
   * former restarts the check instead of raising the banner.
   */
  onStartRefused(error: ClassifiedProviderError, sessionDbId: number): void {
    this.readyUntilMs = 0;
    if (error.code !== CODEX_NOT_READY_CODE) {
      // Raised by a real exec (lockdown breach, rejected invocation, a plan
      // that does not include Codex...): the self-check can pass while this
      // keeps failing, so it is booked as an exec-time problem and backs off.
      this.noteProblem(codexProblemFromError(error), sessionDbId);
      return;
    }
    // A check already running, or a problem booked meanwhile (another
    // session's login failure), owns what happens next; re-evaluating here
    // could clear that fresh record on the strength of a stale cached pass.
    if (this.inFlight || currentCodexProblem()) return;
    if (this.canary) {
      // The canary's own start was refused as not-ready (its cached verdict
      // lapsed). Re-verify; the canary slot reopens when its run ends.
      this.startCheck(true, sessionDbId, 'start-refused');
      return;
    }
    const decision = this.evaluate(sessionDbId, 'start-refused', false);
    if (decision.proceed) {
      // The provider and the cache disagreed (a verdict that lapsed between the
      // two reads). Settle it with a fresh check rather than resume on a
      // verdict the provider just refused, which could loop.
      this.startCheck(true, sessionDbId, 'start-refused');
    }
  }

  /**
   * Book a codex problem (the gate's own finding, the route's auth pause, an
   * exec-time setup refusal) so it gets the same record, backoff and re-check.
   */
  noteProblem(problem: CodexProblem, sessionDbId?: number): void {
    const origin: CodexProblemOrigin = problem.origin ?? 'self_check';
    this.readyUntilMs = 0;
    this.problemSeq += 1;
    if (this.canary) {
      // The canary failed (or something else did while it ran): back to a
      // plain hold, and the next re-check decides again.
      logger.info('SESSION', 'Codex canary did not prove the fix; holding starts again', {
        ...(this.canary.sessionDbId !== null ? { canarySessionId: this.canary.sessionDbId } : {}),
      });
      this.canary = null;
    }
    if (origin === 'exec') {
      this.execProofOwed = true;
      // Once per re-enable: every session let through by one re-enable that
      // then fails is the same failed cycle.
      if (this.execProblemEpoch !== this.enableEpoch) {
        this.consecutiveProblems += 1;
        this.execProblemEpoch = this.enableEpoch;
      }
    } else {
      this.consecutiveProblems += 1;
    }
    const status = recordCodexProblem({ ...problem, origin });
    // From the record's own timestamp, the instant `check()` measures the
    // backoff from — not "now", which is later by however long the
    // observer-health write took, and would arm a re-check that `check()`
    // then answers with "still backing off".
    const retryAtMs = status.recordedAtMs + this.backoffMs();
    logger.warn('SESSION', problem.kind === 'auth_required'
      ? 'Codex needs a ChatGPT login; holding observer starts (buffered work is kept) until it is fixed'
      : 'Codex is not usable; holding observer starts (buffered work is kept) until it is fixed', {
      ...(sessionDbId !== undefined ? { sessionId: sessionDbId } : {}),
      status: problem.kind,
      origin,
      ...(problem.code ? { code: problem.code } : {}),
      error: problem.message,
      recheckInMs: Math.max(0, retryAtMs - Date.now()),
    });
    this.syncTurnSubscription();
    this.hooks.onHeld?.(retryAtMs);
  }

  /**
   * Unconditionally end the problem streak, so the next problem starts the
   * backoff from the bottom again. The route no longer calls this for every
   * exit: `noteTurnAnswered` does, and only for a run admitted after the last
   * problem whose model actually answered.
   */
  noteHealthyRun(): void {
    this.consecutiveProblems = 0;
    this.automaticExecReenables = 0;
    this.syncTurnSubscription();
  }

  /**
   * The observer's model answered a turn for `sessionDbId` (observer-turn-signal).
   * Proof the run works — but only for a run admitted after the last problem
   * was booked: one that was already running when the problem arose proves
   * nothing about it.
   */
  noteTurnAnswered(sessionDbId: number): void {
    const admittedAt = this.admissions.get(sessionDbId);
    if (admittedAt === undefined || admittedAt !== this.problemSeq) return;
    if (this.canary && this.canary.sessionDbId === sessionDbId) {
      this.confirmCanary(sessionDbId);
      return;
    }
    if (this.consecutiveProblems > 0) this.noteHealthyRun();
  }

  /**
   * A start the gate admitted did not happen after all (the quota breaker
   * refused it). Frees the canary slot if this session held it.
   */
  releaseStart(sessionDbId: number): void {
    this.admissions.delete(sessionDbId);
    if (this.canary && this.canary.sessionDbId === sessionDbId) this.canary.sessionDbId = null;
  }

  /**
   * A codex run the gate admitted has ended. Forgets its admission and, if it
   * was the canary and neither proved nor disproved the fix (its run paused on
   * quota or transport, idled out, crashed), reopens the canary slot. The next
   * start — that session's own scheduled resume, another session's tool call —
   * claims it; nothing is triggered from here, so an inconclusive canary
   * cannot become a loop.
   */
  noteRunEnded(sessionDbId: number): void {
    this.admissions.delete(sessionDbId);
    if (this.canary && this.canary.sessionDbId === sessionDbId) {
      logger.debug('SESSION', 'Codex canary run ended without an answer; the next start becomes the canary', {
        sessionId: sessionDbId,
      });
      this.canary.sessionDbId = null;
    }
  }

  /** Stop listening for answered turns. For worker shutdown and tests. */
  dispose(): void {
    if (this.unsubscribeTurns) {
      this.unsubscribeTurns();
      this.unsubscribeTurns = null;
    }
  }

  private evaluate(sessionDbId: number | null, source: string, recheck: boolean): CodexGateDecision {
    const logContext = sessionDbId !== null ? { sessionId: sessionDbId, source } : { source };
    let snapshot: CodexReadinessSnapshot;
    try {
      snapshot = this.source.readinessSnapshot();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('SESSION', 'Could not read Codex readiness; holding the generator start', logContext,
        error instanceof Error ? error : new Error(message));
      this.noteProblem({ kind: 'setup_required', message: `Codex readiness could not be read: ${message}` }, sessionDbId ?? undefined);
      return { proceed: false, reason: 'readiness_unavailable' };
    }

    switch (snapshot.state) {
      case 'passed':
        if (recheck) {
          // A problem is on record but the cached verdict says passed: it came
          // from a real exec (or predates this binary). Re-verify rather than
          // trust a verdict that did not stop the last failure.
          this.startCheck(true, sessionDbId, source);
          return { proceed: false, reason: 'recheck_started' };
        }
        this.markReady(false);
        return { proceed: true };
      case 'unverified':
      case 'pending':
        if (recheck && this.execProofOwed) {
          // No cached verdict for the CURRENT fingerprint: the binary, the
          // login or the codex settings changed since the problem (or the
          // verdict aged out). A changed setup earns a fresh set of automatic
          // re-enables.
          this.automaticExecReenables = 0;
        }
        this.startCheck(recheck, sessionDbId, source);
        return { proceed: false, reason: recheck ? 'recheck_started' : 'self_check_started' };
      case 'binary_missing':
        this.noteProblem({
          kind: 'setup_required',
          message: `Codex CLI could not be resolved: ${snapshot.message}`,
          code: 'codex_not_found',
          action: CODEX_CLI_SETUP_REMEDIATION,
          origin: 'self_check',
        }, sessionDbId ?? undefined);
        return { proceed: false, reason: 'binary_missing' };
      case 'failed':
        if (recheck) {
          this.startCheck(true, sessionDbId, source);
          return { proceed: false, reason: 'recheck_started' };
        }
        this.noteProblem({ ...codexProblemFromLockdown(snapshot.result), origin: 'self_check' }, sessionDbId ?? undefined);
        return { proceed: false, reason: 'self_check_failed' };
      default: {
        const exhaustive: never = snapshot;
        throw new Error(`unknown codex readiness ${String(exhaustive)}`);
      }
    }
  }

  /** Start (or join) the self-check in the background; never awaited by a caller. */
  private startCheck(force: boolean, sessionDbId: number | null, source: string): void {
    if (this.inFlight) return;
    logger.info('SESSION', force
      ? 'Re-checking Codex readiness in the background; the generator start is held until it finishes'
      : 'Codex readiness is not verified yet; running the lockdown self-check in the background and holding the generator start', {
      ...(sessionDbId !== null ? { sessionId: sessionDbId } : {}),
      source,
    });

    let run: Promise<CodexLockdownResult | null>;
    try {
      run = this.source.verifyLockdown(force ? { force: true } : {});
    } catch (error: unknown) {
      run = Promise.reject(error);
    }
    this.inFlightAutomatic = isAutomaticResumeSource(source);
    this.inFlight = run.then(
      (result) => this.onCheckFinished(result),
      (error: unknown) => {
        this.inFlight = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.error('SESSION', 'Codex lockdown self-check could not run', {},
          error instanceof Error ? error : new Error(message));
        this.noteProblem({ kind: 'setup_required', message: `Codex lockdown self-check could not run: ${message}` });
      },
    );
  }

  private onCheckFinished(result: CodexLockdownResult | null): void {
    // Cleared FIRST: onReady starts sessions whose own gate check must not find
    // this (finished) check still marked as running.
    this.inFlight = null;
    if (result === null) {
      this.noteProblem({
        kind: 'setup_required',
        message: 'Codex CLI could not be resolved when its self-check was due to run',
        code: 'codex_not_found',
        action: CODEX_CLI_SETUP_REMEDIATION,
        origin: 'self_check',
      });
      return;
    }
    if (result.state === 'passed') {
      if (this.execProofOwed && currentCodexProblem()) {
        // Passing proves only the model-free half. What failed was a real
        // exec, and the same check passed before it did.
        this.canaryFingerprint = result.cacheKey ?? null;
        this.enterCanary(this.inFlightAutomatic);
        return;
      }
      if (this.canary) {
        // A re-check during a canary (its start was refused as not-ready)
        // passed: offer the slot again rather than release everyone.
        if (this.canary.sessionDbId === null) this.hooks.onReady?.('canary');
        return;
      }
      this.markReady(true);
      return;
    }
    if (result.state === 'failed') {
      this.noteProblem({ ...codexProblemFromLockdown(result), origin: 'self_check' });
      return;
    }
    // verifyCodexLockdown resolves only with a finished verdict; if that ever
    // changes, look again after one backoff rather than stall.
    logger.warn('SESSION', 'Codex self-check resolved without a verdict; re-checking after a backoff', { state: result.state });
    this.hooks.onHeld?.(Date.now() + this.baseBackoffMs);
  }

  /** Clear a recorded problem and, if anything was held, start what waited. */
  private markReady(announce: boolean): void {
    const hadProblem = currentCodexProblem() !== null;
    if (hadProblem) {
      clearDependencyStatus('codex_cli');
      this.enableEpoch += 1;
    }
    this.readyUntilMs = Date.now() + this.readyTtlMs;
    if (announce || hadProblem) {
      // A finished, passing self-check disproves a setup or login problem the
      // self-check itself can see: drop that fix-it banner now instead of at
      // the next store, which may be hours away when nothing is pending — or
      // never, across a restart, since the banner's file outlives the process.
      recordObserverRecovered('codex', 'check');
      logger.info('SESSION', 'Codex is ready; resuming the sessions that waited for it', {});
      this.hooks.onReady?.('all');
    }
  }

  /** An exec-time problem passed its re-check: let ONE session prove it. */
  private enterCanary(automatic: boolean): void {
    clearDependencyStatus('codex_cli');
    this.enableEpoch += 1;
    this.readyUntilMs = 0;
    if (automatic) this.automaticExecReenables += 1;
    this.canary = { sessionDbId: null };
    this.syncTurnSubscription();
    logger.info('SESSION', 'Codex passed its re-check after a problem only a real run can show; resuming ONE waiting session to confirm before the rest', {
      automaticReenables: this.automaticExecReenables,
    });
    this.hooks.onReady?.('canary');
  }

  /** The canary's model answered: the exec-time problem is gone. Start everyone. */
  private confirmCanary(sessionDbId: number): void {
    this.canary = null;
    this.execProofOwed = false;
    this.readyUntilMs = Date.now() + this.readyTtlMs;
    this.noteHealthyRun();
    recordObserverRecovered('codex', 'run');
    logger.info('SESSION', 'Codex canary answered; resuming every session that waited for it', { canarySessionId: sessionDbId });
    this.hooks.onReady?.('all');
  }

  /** Listen for answered turns only while one could change something. */
  private syncTurnSubscription(): void {
    const wanted = this.canary !== null || this.consecutiveProblems > 0;
    if (wanted && !this.unsubscribeTurns) {
      this.unsubscribeTurns = this.subscribeToTurns((event) => {
        if (event.provider !== null && event.provider !== 'codex') return;
        this.noteTurnAnswered(event.sessionDbId);
      });
    } else if (!wanted && this.unsubscribeTurns) {
      this.unsubscribeTurns();
      this.unsubscribeTurns = null;
    }
  }
}

/** The recorded codex problem that gates starts, if any. */
function currentCodexProblem(): DependencyStatus | null {
  const status = getDependencyStatus('codex_cli');
  return status && (status.kind === 'setup_required' || status.kind === 'auth_required') ? status : null;
}
