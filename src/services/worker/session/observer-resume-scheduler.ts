/**
 * Observer resume scheduler: drain-on-clear (M3, plan 3.5).
 *
 * THE GAP IT CLOSES. A paused observer keeps the session and its in-RAM buffer
 * alive (GeneratorExitHandler's preserve list), but nothing ever started it
 * again: a generator only starts from an ingest, `/summarize` or `/init`. So a
 * session that ended during a pause — the common case on a Plus plan, where a
 * five-hour Codex window runs out mid-afternoon — kept its last observations
 * in memory until the worker restarted and threw them away, while the
 * session-start banner promised "Incoming observations stay queued and will be
 * written". This makes that sentence true.
 *
 * WHO IT SERVES. The mechanism is provider-agnostic, but the route only hands
 * it Codex pauses: whether other providers get timer-driven resumes is plan
 * question 8, still the user's to answer, and until then claude, gemini and
 * openrouter keep their pre-M3 behaviour (a pause waits for the next captured
 * tool call).
 *
 * WHAT IT DOES, per pause kind:
 *
 *   - quota: ONE unref'd timer per provider, at the breaker's resume time —
 *     the provider's stated time when it gave one, else the fixed 30-minute
 *     window. When it fires, exactly ONE session with pending work is started;
 *     the route's normal admission (`tryAdmitQuotaProbe`) turns that start into
 *     the single probe. When the breaker is cleared (a successful store, or a
 *     Codex answer), EVERY session with pending work is started. A probe that
 *     is refused again re-arms the breaker, and the route notes the pause
 *     again, which re-arms this timer. A probe that does neither is re-probed
 *     by a watchdog that backs off (5, 10, 20 min) and gives up after
 *     QUOTA_RESUME_MAX_UNRESOLVED_PROBES, rotating through the waiting
 *     sessions and skipping any that cannot usefully probe.
 *   - transport: one delayed resume of THAT session, 60 s doubling to 5 min
 *     with consecutive transport exits, then every 30 min once the streak
 *     passes TRANSPORT_RESUME_MAX_EXITS (see there). It never stops: the
 *     buffer of a session that has already ended has no other way out.
 *   - codex setup / login: the codex readiness gate owns the verdict. When a
 *     problem is recorded it asks for a re-check at the end of its backoff
 *     (`noteDependencyPause`); the timer asks the gate directly
 *     (`recheckDependency`), never through one session's start, which an
 *     overflow pause could swallow. When a check passes the gate asks for
 *     every waiting session to start (`resumeAllPending`), or, for a problem
 *     only a real run can show, for ONE canary first (`resumeOnePending`).
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - decide anything about admission. It only calls `ensureGeneratorRunning`,
 *     so every gate the route has (overflow pause, Claude setup, codex
 *     readiness, quota admission) still applies to a resumed start exactly as
 *     it does to an ingest. A resume can never be the thing that spends a paid
 *     call the breaker would have refused.
 *   - start anything without pending work. A timer that fires into an empty
 *     worker does nothing; the next captured tool call is then the probe, as
 *     it was before M3.
 *   - survive the process. Timers are in memory and unref'd, like the buffer
 *     they serve: a worker restart loses both together, and the banner says so.
 *   - resume an exhausted overflow pause. That pause exists to stop one spawn
 *     per captured tool call on a conversation that cannot fit; restarting it
 *     on a timer would bring back the same spawn loop without the tool calls.
 */

import { logger } from '../../../utils/logger.js';
import {
  getQuotaCooldown as defaultGetQuotaCooldown,
  onQuotaCooldownCleared as defaultOnQuotaCooldownCleared,
  quotaCooldownResumeAtMs,
  QUOTA_PROBE_STALE_MS,
  type QuotaCooldownClearedListener,
  type QuotaCooldownState,
  type QuotaProvider,
} from '../../../shared/quota-cooldown.js';

/** Why a resume was triggered; passed through as ensureGeneratorRunning's `source`. */
export type ObserverResumeSource =
  /** The single probe once a quota window elapsed. */
  | 'quota-resume'
  /** Every waiting session, after a breaker cleared (or was found gone). */
  | 'quota-cleared'
  /** One session, after its transport backoff ran out. */
  | 'transport-resume'
  /** Every waiting session, after the codex self-check or re-check passed. */
  | 'codex-ready'
  /**
   * Every waiting session, when the codex re-check window arrives and there is
   * no direct re-check hook (or codex is no longer the selected provider).
   */
  | 'codex-recheck'
  /** ONE session, to confirm a fix only a real Codex run can prove. */
  | 'codex-canary';

/**
 * Every `source` this scheduler (or the route's own immediate recycle resume)
 * passes to ensureGeneratorRunning. Anything else is a captured tool call or
 * an explicit /summarize or /init — "fresh activity" — which the codex gate
 * treats differently once its automatic re-enables are spent.
 */
const AUTOMATIC_RESUME_SOURCES: ReadonlySet<string> = new Set<string>([
  'quota-resume',
  'quota-cleared',
  'transport-resume',
  'codex-ready',
  'codex-recheck',
  'codex-canary',
  'overflow-recycle',
]);

/** True for a start this scheduler (or a recycle) made, as opposed to fresh activity. */
export function isAutomaticResumeSource(source: string): boolean {
  return AUTOMATIC_RESUME_SOURCES.has(source);
}

/** First transport resume delay; doubles per consecutive transport exit. */
export const TRANSPORT_RESUME_BASE_DELAY_MS = 60_000;

/** Ceiling for the transport resume delay. */
export const TRANSPORT_RESUME_MAX_DELAY_MS = 5 * 60_000;

/**
 * Transport exits in a row that are resumed on the fast backoff (60 s doubling
 * to 5 min). Past it the session is still resumed — every
 * TRANSPORT_RESUME_SLOW_DELAY_MS — but no longer every five minutes.
 *
 * Roughly half an hour of fast retrying (60+120+240+300×5 s plus the runs
 * themselves) covers a dropped Wi-Fi or a provider blip. What the fast cadence
 * must not cover is a failure that only LOOKS transient and is really
 * deterministic — a batch that times out every time, a hard cap that never
 * frees — because on Codex every resume is a subprocess against the user's
 * plan, and a five-minute cadence is 60 wasted execs per five-hour window.
 *
 * It must not STOP either (plan 3.5 arms the resume on every exit): a session
 * that has already ended gets no further tool call, so a stopped timer strands
 * its buffer until a restart discards it. The slow cadence keeps that buffer
 * draining at about ten attempts per five hours.
 *
 * DEVIATION TO CONFIRM WITH THE USER: plan 3.5 caps the backoff at five
 * minutes and says nothing about slowing down; the half-hour tail is a cost
 * bound added here.
 */
export const TRANSPORT_RESUME_MAX_EXITS = 8;

/** The resume cadence once a transport streak passes TRANSPORT_RESUME_MAX_EXITS. */
export const TRANSPORT_RESUME_SLOW_DELAY_MS = 30 * 60_000;

/**
 * Transport exits in a row after which the route books an observer-health
 * failure (then one per further exit). The first two are held back: a single
 * dropped connection heals on the scheduled resume and must not raise the
 * session-start banner.
 */
export const TRANSPORT_HEALTH_RECORD_AFTER_EXITS = 3;

/** setTimeout's ceiling; a later instant is reached in hops. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Probes the quota watchdog sends under one armed breaker window that neither
 * stored (clearing it) nor were refused (re-arming it). After that many it
 * stops probing on a timer and leaves the next probe to a captured tool call,
 * as before M3; a clear or a re-armed window starts the count again.
 *
 * Such a probe is usually one whose run ended on a deterministic "transient"
 * (a batch that times out every time): without a cap the watchdog re-probed
 * the same session every five minutes, forever, on an idle machine.
 */
export const QUOTA_RESUME_MAX_UNRESOLVED_PROBES = 3;

/**
 * The delay before resuming a session after its `consecutiveExits`-th
 * transport exit in a row: the fast backoff, then the slow cadence.
 */
export function transportResumeDelayMs(consecutiveExits: number): number {
  const exits = Number.isFinite(consecutiveExits) && consecutiveExits >= 1 ? Math.floor(consecutiveExits) : 1;
  if (exits > TRANSPORT_RESUME_MAX_EXITS) return TRANSPORT_RESUME_SLOW_DELAY_MS;
  return Math.min(TRANSPORT_RESUME_BASE_DELAY_MS * 2 ** (exits - 1), TRANSPORT_RESUME_MAX_DELAY_MS);
}

export interface ObserverResumeSchedulerDeps {
  /** Start (or leave running) a generator for one session: the route's ensureGeneratorRunning. */
  resume: (sessionDbId: number, source: ObserverResumeSource) => Promise<void> | void;
  /** Sessions holding buffered work with no generator draining it. */
  listSessionIdsWithPendingWork: () => number[];
  /**
   * Whether a waiting session is worth starting ALONE — as the single quota
   * probe or the codex canary. False for one that would return before doing
   * anything (an active overflow pause) or that keeps failing on its own
   * (a transport streak past TRANSPORT_RESUME_MAX_EXITS): choosing it would
   * spend the one attempt and leave everyone else waiting. Default: all are.
   */
  isSingleResumeCandidate?: (sessionDbId: number) => boolean;
  /**
   * Whether the generator holding `provider`'s probe claim is still running.
   * The watchdog never takes over a live probe, however long it has run.
   * Default: never (only the claim's staleness decides).
   */
  isQuotaProbeHolderActive?: (provider: QuotaProvider, claimId: number) => boolean;
  /**
   * Re-check codex readiness NOW (the gate's requestRecheck), when the
   * dependency re-check window arrives with work waiting. Without it the
   * scheduler falls back to starting one waiting session, whose gate check
   * re-checks — which an overflow-paused first session can swallow.
   */
  recheckDependency?: () => void;
  /** Test seams: clock, timers, and the breaker module. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  getQuotaCooldown?: (provider: QuotaProvider) => QuotaCooldownState | null;
  onQuotaCooldownCleared?: (listener: QuotaCooldownClearedListener) => () => void;
}

/** What is armed right now; for logs and tests. */
export interface ObserverResumeSchedule {
  quota: Partial<Record<QuotaProvider, number>>;
  sessions: Record<number, number>;
  dependencyAtMs: number | null;
  listeningForQuotaClears: boolean;
}

interface ArmedTimer {
  handle: unknown;
  atMs: number;
}

/** What the scheduler tracks for one provider's armed breaker. */
interface QuotaWatch {
  /** The next look at the breaker; null once automatic probing gave up. */
  timer: ArmedTimer | null;
  /** `armedAtMs` of the breaker window the probes below were sent under. */
  roundArmedAtMs: number | null;
  /** Probes sent under that window that neither stored nor were refused. */
  unresolvedProbes: number;
  /** The session the last probe went to, so the next one rotates past it. */
  lastProbeSessionId: number | null;
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  const handle = setTimeout(callback, delayMs);
  // Unref'd: a pending resume must never be the thing keeping a worker (or a
  // test process) alive. The buffer it would drain dies with the process anyway.
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export class ObserverResumeScheduler {
  private readonly quotaWatches = new Map<QuotaProvider, QuotaWatch>();
  private readonly sessionTimers = new Map<number, ArmedTimer>();
  private dependencyTimer: ArmedTimer | null = null;
  /** Deferred triggers not yet run, so dispose() can cancel them too. */
  private readonly soon = new Set<unknown>();
  private unsubscribeQuotaClears: (() => void) | null = null;
  private disposed = false;

  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly getQuotaCooldown: (provider: QuotaProvider) => QuotaCooldownState | null;
  private readonly subscribeToQuotaClears: (listener: QuotaCooldownClearedListener) => () => void;

  constructor(private readonly deps: ObserverResumeSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.clearTimer = deps.clearTimer ?? defaultClearTimer;
    this.getQuotaCooldown = deps.getQuotaCooldown ?? defaultGetQuotaCooldown;
    this.subscribeToQuotaClears = deps.onQuotaCooldownCleared ?? defaultOnQuotaCooldownCleared;
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  /**
   * A session paused on `provider`'s quota, or a start was refused by its
   * breaker. Arms (or keeps) the provider's single timer for the moment the
   * breaker next lets a call through, and listens for the breaker clearing.
   *
   * Idempotent: every paused session and every refused ingest calls this, and
   * they all compute the same instant from the same breaker.
   */
  noteQuotaPause(provider: QuotaProvider, sessionDbId?: number): void {
    if (this.disposed) return;
    const state = this.readQuotaCooldown(provider);
    if (!state) {
      // The breaker is already gone: another session's store cleared it between
      // this session's refusal and its exit, so the clear this pause would wait
      // for has already happened. Nothing withholds the provider any more —
      // but, like every other trigger here, only a session that still has
      // work waiting is started: a start with nothing buffered would spend a
      // Codex init exec for nothing.
      if (sessionDbId !== undefined && this.listPending().includes(sessionDbId)) {
        this.trigger(sessionDbId, 'quota-cleared');
      }
      return;
    }
    this.listenForQuotaClears();
    const watch = this.watchFor(provider);
    if (watch.roundArmedAtMs !== null && watch.roundArmedAtMs !== state.armedAtMs) {
      // A re-armed window is a resolved probe (a refusal): start counting again.
      watch.roundArmedAtMs = null;
      watch.unresolvedProbes = 0;
    }
    this.armQuotaTimer(provider, watch, this.nextQuotaCheckAt(state, this.now()));
  }

  /**
   * When the breaker next lets a call through: its resume time; or, once that
   * has passed but someone else's probe is still out, the moment that probe's
   * claim goes stale; or now.
   */
  private nextQuotaCheckAt(state: QuotaCooldownState, nowMs: number): number {
    const resumeAtMs = quotaCooldownResumeAtMs(state);
    if (nowMs < resumeAtMs) return resumeAtMs;
    const inFlight = state.probeInFlightSinceMs;
    if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS) return inFlight + QUOTA_PROBE_STALE_MS;
    return nowMs;
  }

  private watchFor(provider: QuotaProvider): QuotaWatch {
    let watch = this.quotaWatches.get(provider);
    if (!watch) {
      watch = { timer: null, roundArmedAtMs: null, unresolvedProbes: 0, lastProbeSessionId: null };
      this.quotaWatches.set(provider, watch);
    }
    return watch;
  }

  private armQuotaTimer(provider: QuotaProvider, watch: QuotaWatch, atMs: number): void {
    const existing = watch.timer;
    if (existing && existing.atMs === atMs) return;
    if (existing) this.clearTimer(existing.handle);
    const handle = this.schedule(atMs, () => this.onQuotaTimer(provider));
    watch.timer = { handle, atMs };
  }

  private forgetQuotaWatch(provider: QuotaProvider): void {
    const watch = this.quotaWatches.get(provider);
    if (watch?.timer) this.clearTimer(watch.timer.handle);
    this.quotaWatches.delete(provider);
  }

  private onQuotaTimer(provider: QuotaProvider): void {
    const watch = this.quotaWatches.get(provider);
    if (!watch) return;
    watch.timer = null;
    if (this.disposed) return;

    const state = this.readQuotaCooldown(provider);
    if (!state) {
      // Cleared without this scheduler hearing it (e.g. before it listened).
      this.forgetQuotaWatch(provider);
      this.drain('quota-cleared', { provider });
      this.stopListeningIfIdle();
      return;
    }

    const nowMs = this.now();
    const nextAt = this.nextQuotaCheckAt(state, nowMs);
    if (nextAt > nowMs) {
      // Re-armed with a later time, or another session's probe is still out:
      // its outcome decides, and this looks again when its claim would lapse.
      this.armQuotaTimer(provider, watch, nextAt);
      return;
    }

    // A claim whose holder is still running is never taken over, however long
    // it has been out: a slow probe is still the probe, and a takeover would
    // put a second paid exec alongside it.
    const claimId = state.probeClaimId;
    if (claimId !== null && state.probeInFlightSinceMs !== null && this.isProbeHolderActive(provider, claimId)) {
      this.armQuotaTimer(provider, watch, nowMs + QUOTA_PROBE_STALE_MS);
      return;
    }

    const waiting = this.listPending();
    if (waiting.length === 0) {
      logger.debug('SESSION', 'Quota window elapsed with no buffered work waiting; the next captured tool call will probe', {
        provider,
      });
      this.forgetQuotaWatch(provider);
      this.stopListeningIfIdle();
      return;
    }

    if (watch.roundArmedAtMs !== state.armedAtMs) {
      watch.roundArmedAtMs = state.armedAtMs;
      watch.unresolvedProbes = 0;
    }
    if (watch.unresolvedProbes >= QUOTA_RESUME_MAX_UNRESOLVED_PROBES) {
      // Keep the watch (and the clear listener): if a captured tool call's
      // probe clears the breaker later, everyone waiting is still drained.
      logger.warn('SESSION', 'Quota probes keep ending without an answer; no further automatic probe until a captured tool call or a new window', {
        provider,
        unresolvedProbes: watch.unresolvedProbes,
        waitingSessions: waiting.length,
      });
      return;
    }

    const probeSessionId = this.pickSingle(waiting, watch.lastProbeSessionId);
    if (probeSessionId === null) {
      // Everyone waiting is overflow-paused or failing on its own transport;
      // none of them can usefully probe right now. Look again later without
      // spending one of the probes.
      logger.debug('SESSION', 'Quota window elapsed but no waiting session can probe right now; looking again later', {
        provider,
        waitingSessions: waiting.length,
      });
      this.armQuotaTimer(provider, watch, nowMs + QUOTA_PROBE_STALE_MS);
      return;
    }

    watch.unresolvedProbes += 1;
    watch.lastProbeSessionId = probeSessionId;
    logger.info('SESSION', 'Quota window elapsed; resuming one waiting session as the single probe', {
      provider,
      sessionId: probeSessionId,
      waitingSessions: waiting.length,
      probe: watch.unresolvedProbes,
    });
    this.trigger(probeSessionId, 'quota-resume');
    // Watchdog. The probe normally ends this either way — a store or a Codex
    // answer clears the breaker (drain below), a refusal re-arms it (the route
    // notes the pause again, which starts a new round). If it does neither (it
    // could not start, or its run ended without an answer), look again —
    // 5, 10, then 20 minutes out — instead of leaving everyone else waiting on
    // a tool call that may never come, but not forever.
    this.armQuotaTimer(provider, watch, nowMs + QUOTA_PROBE_STALE_MS * 2 ** (watch.unresolvedProbes - 1));
  }

  private isProbeHolderActive(provider: QuotaProvider, claimId: number): boolean {
    if (!this.deps.isQuotaProbeHolderActive) return false;
    try {
      return this.deps.isQuotaProbeHolderActive(provider, claimId);
    } catch (error: unknown) {
      logger.warn('SESSION', 'Could not tell whether the quota probe is still running', { provider },
        error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** The breaker-cleared listener: start every session that waited behind it. */
  private readonly onQuotaCleared = (provider: QuotaProvider): void => {
    if (this.disposed) return;
    // Only a pause this scheduler is tracking. A healthy provider clears on
    // every store, but the module only announces clears of an ARMED breaker,
    // and an untracked one has nobody waiting on it here.
    if (!this.quotaWatches.has(provider)) return;
    this.forgetQuotaWatch(provider);
    this.drain('quota-cleared', { provider });
    this.stopListeningIfIdle();
  };

  private listenForQuotaClears(): void {
    if (this.unsubscribeQuotaClears) return;
    this.unsubscribeQuotaClears = this.subscribeToQuotaClears(this.onQuotaCleared);
  }

  private stopListeningIfIdle(): void {
    if (this.quotaWatches.size > 0 || !this.unsubscribeQuotaClears) return;
    this.unsubscribeQuotaClears();
    this.unsubscribeQuotaClears = null;
  }

  private readQuotaCooldown(provider: QuotaProvider): QuotaCooldownState | null {
    try {
      return this.getQuotaCooldown(provider);
    } catch (error: unknown) {
      logger.warn('SESSION', 'Could not read the quota breaker for the resume scheduler', {
        provider,
      }, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * A session paused on a transport failure for the `consecutiveExits`-th time
   * in a row. Arms one delayed resume for it and returns the delay.
   */
  noteTransportPause(sessionDbId: number, consecutiveExits: number): number | null {
    if (this.disposed) return null;
    const delayMs = transportResumeDelayMs(consecutiveExits);
    if (consecutiveExits === TRANSPORT_RESUME_MAX_EXITS + 1) {
      logger.warn('SESSION', 'Observer transport keeps failing; retrying this session every 30 minutes from now on — its buffered work stays queued', {
        sessionId: sessionDbId,
        consecutiveTransportExits: consecutiveExits,
        retryInMs: delayMs,
      });
    }
    const atMs = this.now() + delayMs;
    this.cancelSessionTimer(sessionDbId);
    const handle = this.schedule(atMs, () => this.onSessionTimer(sessionDbId, 'transport-resume'));
    this.sessionTimers.set(sessionDbId, { handle, atMs });
    return delayMs;
  }

  private onSessionTimer(sessionDbId: number, source: ObserverResumeSource): void {
    this.sessionTimers.delete(sessionDbId);
    if (this.disposed) return;
    if (!this.listPending().includes(sessionDbId)) {
      // Drained by an ingest meanwhile, running again, or gone: nothing to do.
      logger.debug('SESSION', 'Scheduled observer resume found nothing waiting', { sessionId: sessionDbId, source });
      return;
    }
    logger.info('SESSION', 'Resuming the observer after its backoff', { sessionId: sessionDbId, source });
    this.trigger(sessionDbId, source);
  }

  private cancelSessionTimer(sessionDbId: number): void {
    const armed = this.sessionTimers.get(sessionDbId);
    if (!armed) return;
    this.clearTimer(armed.handle);
    this.sessionTimers.delete(sessionDbId);
  }

  // -------------------------------------------------------------------------
  // Codex setup / login (driven by the codex readiness gate)
  // -------------------------------------------------------------------------

  /**
   * Codex is held for setup or login until `retryAtMs`. Arms one re-check for
   * then, so the gate re-checks even if no tool call arrives; a later instant
   * replaces an earlier one.
   */
  noteDependencyPause(retryAtMs: number): void {
    if (this.disposed) return;
    const existing = this.dependencyTimer;
    if (existing && existing.atMs === retryAtMs) return;
    if (existing) this.clearTimer(existing.handle);
    const handle = this.schedule(retryAtMs, () => this.onDependencyTimer());
    this.dependencyTimer = { handle, atMs: retryAtMs };
  }

  private onDependencyTimer(): void {
    this.dependencyTimer = null;
    if (this.disposed) return;
    const waiting = this.listPending();
    if (waiting.length === 0) {
      logger.debug('SESSION', 'Codex re-check window reached with no buffered work waiting; the next captured tool call will re-check', {});
      return;
    }
    if (this.deps.recheckDependency) {
      // Straight to the gate. Routing the re-check through one session's start
      // let that session swallow it: an overflow-paused session returns before
      // it reaches the gate, and nothing then re-checked or re-armed.
      logger.info('SESSION', 'Codex re-check window reached; re-checking readiness for the waiting sessions', {
        waitingSessions: waiting.length,
      });
      try {
        this.deps.recheckDependency();
      } catch (error: unknown) {
        logger.error('SESSION', 'Codex re-check could not be started', {},
          error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const sessionDbId = this.pickSingle(waiting, null) ?? waiting[0];
    logger.info('SESSION', 'Codex re-check window reached; resuming one waiting session so the gate re-checks', {
      sessionId: sessionDbId,
      waitingSessions: waiting.length,
    });
    this.trigger(sessionDbId, 'codex-recheck');
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /** Start every session with pending work. Returns how many were started. */
  resumeAllPending(source: ObserverResumeSource): number {
    if (this.disposed) return 0;
    return this.drain(source, {});
  }

  /**
   * Start ONE session with pending work — the one that has waited longest
   * among those that can usefully run alone. Returns it, or null when none.
   * The codex gate's canary: one real run to prove a fix before everyone goes.
   */
  resumeOnePending(source: ObserverResumeSource): number | null {
    if (this.disposed) return null;
    const sessionDbId = this.pickSingle(this.listPending(), null);
    if (sessionDbId === null) return null;
    logger.info('SESSION', 'Resuming one waiting session', { sessionId: sessionDbId, source });
    this.trigger(sessionDbId, source);
    return sessionDbId;
  }

  private drain(source: ObserverResumeSource, context: Record<string, unknown>): number {
    const waiting = this.listPending();
    if (waiting.length > 0) {
      logger.info('SESSION', 'Resuming every session that waited on the paused observer', {
        ...context,
        source,
        sessions: waiting.length,
      });
    }
    for (const sessionDbId of waiting) this.trigger(sessionDbId, source);
    return waiting.length;
  }

  /**
   * The waiting session to start alone: the first candidate after `after` in
   * waiting order (oldest first), wrapping round, so repeated single starts
   * rotate instead of hammering the same session. Null when no candidate.
   */
  private pickSingle(waiting: number[], after: number | null): number | null {
    const candidates = waiting.filter(sessionDbId => this.isSingleResumeCandidate(sessionDbId));
    if (candidates.length === 0) return null;
    if (after === null) return candidates[0];
    const index = waiting.indexOf(after);
    if (index < 0) return candidates[0];
    for (let step = 1; step <= waiting.length; step += 1) {
      const sessionDbId = waiting[(index + step) % waiting.length];
      if (candidates.includes(sessionDbId)) return sessionDbId;
    }
    return candidates[0];
  }

  private isSingleResumeCandidate(sessionDbId: number): boolean {
    if (!this.deps.isSingleResumeCandidate) return true;
    try {
      return this.deps.isSingleResumeCandidate(sessionDbId);
    } catch (error: unknown) {
      logger.warn('SESSION', 'Could not tell whether a waiting session can be resumed alone', { sessionId: sessionDbId },
        error instanceof Error ? error : new Error(String(error)));
      return true;
    }
  }

  private listPending(): number[] {
    try {
      return this.deps.listSessionIdsWithPendingWork();
    } catch (error: unknown) {
      logger.warn('SESSION', 'Could not list sessions with pending observer work', {},
        error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Resume one session on the next tick, never inline: the caller may be deep
   * inside another session's generator (the breaker clears from
   * ResponseProcessor), and starting generators from there would re-enter the
   * route while that generator's own state is mid-update.
   */
  private trigger(sessionDbId: number, source: ObserverResumeSource): void {
    const handle = this.setTimer(() => {
      this.soon.delete(handle);
      if (this.disposed) return;
      Promise.resolve()
        .then(() => this.deps.resume(sessionDbId, source))
        .catch((error: unknown) => {
          logger.error('SESSION', 'Scheduled observer resume failed', {
            sessionId: sessionDbId,
            source,
          }, error instanceof Error ? error : new Error(String(error)));
        });
    }, 0);
    this.soon.add(handle);
  }

  /** Run `callback` at `atMs`, in hops when the delay exceeds setTimeout's range. */
  private schedule(atMs: number, callback: () => void): unknown {
    const delayMs = Math.max(0, atMs - this.now());
    if (delayMs <= MAX_TIMER_DELAY_MS) return this.setTimer(callback, delayMs);
    // Only reachable for a far-future resume time; the hop fires early and the
    // handler re-derives the real instant from the breaker.
    return this.setTimer(callback, MAX_TIMER_DELAY_MS);
  }

  /** What is armed right now. */
  snapshot(): ObserverResumeSchedule {
    const quota: Partial<Record<QuotaProvider, number>> = {};
    for (const [provider, watch] of this.quotaWatches) {
      if (watch.timer) quota[provider] = watch.timer.atMs;
    }
    const sessions: Record<number, number> = {};
    for (const [sessionDbId, armed] of this.sessionTimers) sessions[sessionDbId] = armed.atMs;
    return {
      quota,
      sessions,
      dependencyAtMs: this.dependencyTimer?.atMs ?? null,
      listeningForQuotaClears: this.unsubscribeQuotaClears !== null,
    };
  }

  /** Cancel every timer and stop listening. For worker shutdown and tests. */
  dispose(): void {
    this.disposed = true;
    for (const watch of this.quotaWatches.values()) {
      if (watch.timer) this.clearTimer(watch.timer.handle);
    }
    this.quotaWatches.clear();
    for (const armed of this.sessionTimers.values()) this.clearTimer(armed.handle);
    this.sessionTimers.clear();
    if (this.dependencyTimer) this.clearTimer(this.dependencyTimer.handle);
    this.dependencyTimer = null;
    for (const handle of this.soon) this.clearTimer(handle);
    this.soon.clear();
    if (this.unsubscribeQuotaClears) {
      this.unsubscribeQuotaClears();
      this.unsubscribeQuotaClears = null;
    }
  }
}
