/**
 * Observer resume scheduler: drain-on-clear (M3, plan 3.5).
 *
 * Driven with a fake clock and fake timers against the REAL quota breaker
 * module, so "the stated resume time", "the fixed window" and "the breaker
 * cleared" mean exactly what they mean in the worker. `resume` is a mock: the
 * scheduler's whole contract is WHO it asks to start and WHEN — admission,
 * gates and spending are the route's business and are covered there.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import {
  ObserverResumeScheduler,
  QUOTA_RESUME_MAX_UNRESOLVED_PROBES,
  TRANSPORT_RESUME_BASE_DELAY_MS,
  TRANSPORT_RESUME_MAX_DELAY_MS,
  TRANSPORT_RESUME_MAX_EXITS,
  TRANSPORT_RESUME_SLOW_DELAY_MS,
  transportResumeDelayMs,
  type ObserverResumeSchedulerDeps,
  type ObserverResumeSource,
} from '../../../src/services/worker/session/observer-resume-scheduler.js';
import {
  clearQuotaCooldown,
  getQuotaCooldown,
  recordQuotaExhausted,
  releaseQuotaProbe,
  resetQuotaCooldownsForTesting,
  tryAdmitQuotaProbe,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
} from '../../../src/shared/quota-cooldown.js';
import { guardSharedQuotaCooldownSingleton } from '../../shared/quota-cooldown-singleton-guard.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A clock and a timer wheel the test advances by hand. */
class FakeClock {
  nowMs = Date.now();
  private readonly timers = new Map<number, { atMs: number; callback: () => void }>();
  private nextId = 1;

  now = (): number => this.nowMs;

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { atMs: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Move time forward, firing every timer that falls due (in order, including ones they arm). */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.atMs <= target && (timer.atMs < dueAt || (timer.atMs === dueAt && dueId !== null && id < dueId))) {
          dueId = id;
          dueAt = timer.atMs;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.nowMs = Math.max(this.nowMs, timer.atMs);
      timer.callback();
    }
    this.nowMs = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

/** Let the scheduler's deferred `resume` promise chains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

type OptionalDeps = Pick<ObserverResumeSchedulerDeps, 'isSingleResumeCandidate' | 'isQuotaProbeHolderActive' | 'recheckDependency'>;

function build(pendingIds: number[] = [11, 12, 13], extra: OptionalDeps = {}) {
  const clock = new FakeClock();
  let pending = [...pendingIds];
  const resume = mock((_sessionDbId: number, _source: ObserverResumeSource) => Promise.resolve());
  const scheduler = new ObserverResumeScheduler({
    ...extra,
    resume,
    listSessionIdsWithPendingWork: () => pending,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    resume,
    scheduler,
    setPending(ids: number[]) {
      pending = [...ids];
    },
    /** Advance, then let the resumed promise chains run. */
    async advance(ms: number) {
      clock.advance(ms);
      await settle();
    },
  };
}

guardSharedQuotaCooldownSingleton('observer-resume-scheduler.test.ts');

describe('ObserverResumeScheduler — quota pauses', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterEach(() => {
    harness?.scheduler.dispose();
    resetQuotaCooldownsForTesting();
  });

  it('probes exactly ONE waiting session when the stated resume time arrives', async () => {
    harness = build([11, 12, 13]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', clock.nowMs, clock.nowMs + 4 * HOUR);

    scheduler.noteQuotaPause('codex', 11);
    // Every other paused session and refused ingest notes the same breaker.
    scheduler.noteQuotaPause('codex', 12);
    scheduler.noteQuotaPause('codex');

    // The fixed window elapses long before the stated time: nothing may go out.
    await harness.advance(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + MINUTE);
    expect(resume).not.toHaveBeenCalled();

    await harness.advance(4 * HOUR - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - MINUTE);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(11, 'quota-resume');
  });

  it('falls back to the fixed 30-minute window when the provider stated no time', async () => {
    harness = build([21, 22]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', clock.nowMs);

    scheduler.noteQuotaPause('claude', 21);
    expect(scheduler.snapshot().quota.claude).toBe(clock.nowMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);

    await harness.advance(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    expect(resume).not.toHaveBeenCalled();
    await harness.advance(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(21, 'quota-resume');
  });

  it('starts EVERY waiting session once the breaker clears, and drops the probe timer', async () => {
    harness = build([11, 12, 13]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', clock.nowMs, clock.nowMs + HOUR);
    scheduler.noteQuotaPause('codex', 11);
    expect(scheduler.snapshot().listeningForQuotaClears).toBe(true);

    // What ResponseProcessor does on the probe's successful store.
    clearQuotaCooldown('codex');
    await harness.advance(0);

    expect(resume.mock.calls).toEqual([
      [11, 'quota-cleared'],
      [12, 'quota-cleared'],
      [13, 'quota-cleared'],
    ]);
    expect(scheduler.snapshot().quota.codex).toBeUndefined();
    expect(scheduler.snapshot().listeningForQuotaClears).toBe(false);

    // The cancelled probe timer must not fire a second wave later.
    await harness.advance(2 * HOUR);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the window elapses with no work waiting', async () => {
    harness = build([]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex');

    await harness.advance(10 * MINUTE);
    expect(resume).not.toHaveBeenCalled();
    // Nothing tracked any more: the next captured tool call is the probe.
    expect(scheduler.snapshot()).toEqual({ quota: {}, sessions: {}, dependencyAtMs: null, listeningForQuotaClears: false });

    clearQuotaCooldown('codex');
    await harness.advance(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it('never probes early when the breaker was re-armed with a later time', async () => {
    harness = build([31]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'first refusal', 'quota_exhausted', clock.nowMs, clock.nowMs + HOUR);
    scheduler.noteQuotaPause('codex', 31);

    // Re-armed with a later time by a path that did not note the pause.
    recordQuotaExhausted('codex', 'second refusal', 'quota_exhausted', clock.nowMs, clock.nowMs + 3 * HOUR);

    await harness.advance(HOUR);
    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.snapshot().quota.codex).toBe(clock.nowMs + 2 * HOUR);

    await harness.advance(2 * HOUR);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(31, 'quota-resume');
  });

  it("waits out another session's probe instead of sending a second one alongside it", async () => {
    harness = build([41, 42]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 41);

    // An ingest claims the single probe at the instant the window elapses.
    await harness.advance(10 * MINUTE - 1);
    const claim = tryAdmitQuotaProbe('codex', clock.nowMs + 1);
    expect(claim.admitted).toBe(true);

    await harness.advance(1);
    expect(resume).not.toHaveBeenCalled();
    // It looks again once that claim would have gone stale.
    expect(scheduler.snapshot().quota.codex).toBe(clock.nowMs + QUOTA_PROBE_STALE_MS);

    await harness.advance(QUOTA_PROBE_STALE_MS);
    expect(resume).toHaveBeenCalledTimes(1);
    releaseQuotaProbe('codex', claim.claimId);
  });

  it('probes again after a probe that neither stored nor was refused', async () => {
    harness = build([51, 52]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);

    await harness.advance(10 * MINUTE);
    expect(resume).toHaveBeenCalledTimes(1);

    // The breaker is still armed (no store cleared it, no refusal re-armed it).
    await harness.advance(QUOTA_PROBE_STALE_MS);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(getQuotaCooldown('codex')).not.toBeNull();
  });

  it('does not start a session with nothing waiting, even when its breaker is already gone', async () => {
    // The route notes the pause after the session's exit; if a store cleared
    // the breaker in between and this session has nothing buffered, a start
    // would spend a Codex init exec for nothing.
    harness = build([]);
    const { resume, scheduler } = harness;

    scheduler.noteQuotaPause('codex', 61);
    await harness.advance(0);

    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.snapshot().listeningForQuotaClears).toBe(false);
  });

  it('resumes a session at once when its breaker is already gone', async () => {
    harness = build([61]);
    const { resume, scheduler } = harness;

    scheduler.noteQuotaPause('codex', 61);
    await harness.advance(0);

    expect(resume).toHaveBeenCalledWith(61, 'quota-cleared');
    expect(scheduler.snapshot().listeningForQuotaClears).toBe(false);
  });

  it('ignores clears of a breaker it is not tracking', async () => {
    harness = build([71]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + HOUR);
    scheduler.noteQuotaPause('codex', 71);

    recordQuotaExhausted('openrouter', 'Spend cap reached', undefined, clock.nowMs);
    clearQuotaCooldown('openrouter');
    await harness.advance(0);

    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.snapshot().quota.codex).toBe(clock.nowMs + HOUR);
  });
});

describe('ObserverResumeScheduler — transport pauses', () => {
  let harness: ReturnType<typeof build>;

  afterEach(() => {
    harness?.scheduler.dispose();
  });

  // Plan 3.5 arms the resume on EVERY transport exit. Past the fast retries
  // the cadence slows to half-hourly rather than stopping: a stopped timer
  // stranded an ended session's buffer until a restart discarded it.
  it('backs off from 60 s to 5 min, then slows to every 30 min instead of stopping', () => {
    expect(transportResumeDelayMs(1)).toBe(TRANSPORT_RESUME_BASE_DELAY_MS);
    expect(transportResumeDelayMs(2)).toBe(2 * TRANSPORT_RESUME_BASE_DELAY_MS);
    expect(transportResumeDelayMs(3)).toBe(4 * TRANSPORT_RESUME_BASE_DELAY_MS);
    expect(transportResumeDelayMs(4)).toBe(TRANSPORT_RESUME_MAX_DELAY_MS);
    expect(transportResumeDelayMs(TRANSPORT_RESUME_MAX_EXITS)).toBe(TRANSPORT_RESUME_MAX_DELAY_MS);
    expect(transportResumeDelayMs(TRANSPORT_RESUME_MAX_EXITS + 1)).toBe(TRANSPORT_RESUME_SLOW_DELAY_MS);
    expect(transportResumeDelayMs(TRANSPORT_RESUME_MAX_EXITS + 50)).toBe(TRANSPORT_RESUME_SLOW_DELAY_MS);
  });

  it('resumes THAT session once, after its backoff', async () => {
    harness = build([81, 82]);
    const { resume, scheduler } = harness;

    expect(scheduler.noteTransportPause(81, 1)).toBe(60_000);

    await harness.advance(59_999);
    expect(resume).not.toHaveBeenCalled();
    await harness.advance(1);
    expect(resume.mock.calls).toEqual([[81, 'transport-resume']]);

    await harness.advance(HOUR);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('grows the delay with the streak, and a newer pause replaces the older timer', async () => {
    harness = build([91]);
    const { clock, resume, scheduler } = harness;

    scheduler.noteTransportPause(91, 1);
    expect(scheduler.noteTransportPause(91, 3)).toBe(240_000);
    expect(scheduler.snapshot().sessions[91]).toBe(clock.nowMs + 240_000);

    await harness.advance(240_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not resume a session that no longer has work waiting', async () => {
    harness = build([101]);
    const { resume, scheduler } = harness;

    scheduler.noteTransportPause(101, 2);
    harness.setPending([]);
    await harness.advance(TRANSPORT_RESUME_MAX_DELAY_MS);

    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps resuming past the fast retries, every 30 minutes, so an ended session still drains', async () => {
    harness = build([111]);
    const { clock, resume, scheduler } = harness;

    scheduler.noteTransportPause(111, 2);
    expect(scheduler.noteTransportPause(111, TRANSPORT_RESUME_MAX_EXITS + 1)).toBe(TRANSPORT_RESUME_SLOW_DELAY_MS);
    // The newer pause replaces the fast resume an earlier exit had armed.
    expect(scheduler.snapshot().sessions[111]).toBe(clock.nowMs + TRANSPORT_RESUME_SLOW_DELAY_MS);

    await harness.advance(TRANSPORT_RESUME_SLOW_DELAY_MS - 1);
    expect(resume).not.toHaveBeenCalled();
    await harness.advance(1);
    expect(resume.mock.calls).toEqual([[111, 'transport-resume']]);

    // And again after the next exit: it never stops on its own.
    expect(scheduler.noteTransportPause(111, TRANSPORT_RESUME_MAX_EXITS + 2)).toBe(TRANSPORT_RESUME_SLOW_DELAY_MS);
    await harness.advance(TRANSPORT_RESUME_SLOW_DELAY_MS);
    expect(resume).toHaveBeenCalledTimes(2);
  });
});

describe('ObserverResumeScheduler — codex setup / login pauses', () => {
  let harness: ReturnType<typeof build>;

  afterEach(() => {
    harness?.scheduler.dispose();
  });

  it('resumes one waiting session when the re-check window arrives, so the gate re-checks', async () => {
    harness = build([121, 122]);
    const { clock, resume, scheduler } = harness;

    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    // The gate re-notes the same instant on every held ingest: still one timer.
    scheduler.noteDependencyPause(clock.nowMs + 30_000);

    await harness.advance(30_000);
    expect(resume.mock.calls).toEqual([[121, 'codex-recheck']]);
  });

  it('starts every waiting session when told codex is ready', async () => {
    harness = build([131, 132]);
    const { resume, scheduler } = harness;

    expect(scheduler.resumeAllPending('codex-ready')).toBe(2);
    await harness.advance(0);

    expect(resume.mock.calls).toEqual([[131, 'codex-ready'], [132, 'codex-ready']]);
  });

  it('does not re-check on a timer when nothing is waiting', async () => {
    harness = build([]);
    const { clock, resume, scheduler } = harness;

    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    await harness.advance(30_000);

    expect(resume).not.toHaveBeenCalled();
  });
});

describe('ObserverResumeScheduler — lifecycle', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterEach(() => {
    resetQuotaCooldownsForTesting();
  });

  it('dispose cancels every timer and stops listening for clears', async () => {
    const harness = build([141]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + HOUR);
    scheduler.noteQuotaPause('codex', 141);
    scheduler.noteTransportPause(141, 1);
    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    scheduler.resumeAllPending('codex-ready');

    scheduler.dispose();
    expect(clock.pendingTimers()).toBe(0);

    clearQuotaCooldown('codex');
    await harness.advance(2 * HOUR);
    expect(resume).not.toHaveBeenCalled();
  });

  it('logs and survives a resume that rejects', async () => {
    const harness = build([151]);
    const errorLog = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      harness.resume.mockImplementation(() => Promise.reject(new Error('boom')));

      harness.scheduler.resumeAllPending('codex-ready');
      await harness.advance(0);

      expect(harness.resume).toHaveBeenCalledTimes(1);
      // Logged: the failure log is the only trace a failed resume leaves.
      const logged = errorLog.mock.calls.find(([component, message]) =>
        component === 'SESSION' && message === 'Scheduled observer resume failed');
      expect(logged).toBeDefined();
      expect(logged![2]).toMatchObject({ sessionId: 151, source: 'codex-ready' });

      // Survived: the scheduler still starts sessions after the rejection.
      harness.resume.mockImplementation(() => Promise.resolve());
      expect(harness.scheduler.resumeAllPending('codex-ready')).toBe(1);
      await harness.advance(0);
      expect(harness.resume).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
      harness.scheduler.dispose();
    }
  });
});

describe('ObserverResumeScheduler — quota watchdog', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterEach(() => {
    harness?.scheduler.dispose();
    resetQuotaCooldownsForTesting();
  });

  it('backs off (5, 10 min) and stops after QUOTA_RESUME_MAX_UNRESOLVED_PROBES probes that neither stored nor were refused', async () => {
    harness = build([51]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);

    // Every probe's run ends on a deterministic "transient" (it neither
    // stores nor is refused): the breaker stays armed and elapsed.
    await harness.advance(10 * MINUTE);
    expect(resume).toHaveBeenCalledTimes(1);
    await harness.advance(5 * MINUTE - 1);
    expect(resume).toHaveBeenCalledTimes(1);
    await harness.advance(1);
    expect(resume).toHaveBeenCalledTimes(2);
    await harness.advance(10 * MINUTE - 1);
    expect(resume).toHaveBeenCalledTimes(2);
    await harness.advance(1);
    expect(resume).toHaveBeenCalledTimes(3);

    // An idle machine, the rest of a five-hour window: no further probe.
    await harness.advance(5 * HOUR);
    expect(QUOTA_RESUME_MAX_UNRESOLVED_PROBES).toBe(3);
    expect(resume).toHaveBeenCalledTimes(QUOTA_RESUME_MAX_UNRESOLVED_PROBES);
    expect(resume.mock.calls.every(([sessionDbId, source]) => sessionDbId === 51 && source === 'quota-resume')).toBe(true);
    // Given up: nothing armed, but still listening, so a probe a captured
    // tool call sends can still drain everyone when it succeeds.
    expect(scheduler.snapshot().quota.codex).toBeUndefined();
    expect(scheduler.snapshot().listeningForQuotaClears).toBe(true);

    clearQuotaCooldown('codex');
    await harness.advance(0);
    expect(harness.resume).toHaveBeenLastCalledWith(51, 'quota-cleared');
  });

  it('starts counting again when the breaker is re-armed (a probe that WAS refused)', async () => {
    harness = build([51]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);
    await harness.advance(5 * HOUR);
    expect(resume).toHaveBeenCalledTimes(QUOTA_RESUME_MAX_UNRESOLVED_PROBES);

    // A captured tool call probes and is refused: the route re-arms and notes it.
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);
    await harness.advance(10 * MINUTE);

    expect(resume).toHaveBeenCalledTimes(QUOTA_RESUME_MAX_UNRESOLVED_PROBES + 1);
  });

  it('rotates the probe through the waiting sessions instead of re-probing the same one', async () => {
    harness = build([51, 52, 53]);
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);

    await harness.advance(5 * HOUR);

    expect(resume.mock.calls.map(([sessionDbId]) => sessionDbId)).toEqual([51, 52, 53]);
  });

  it('never probes a session that cannot usefully run alone', async () => {
    // 51 is overflow-paused, or its own transport keeps failing.
    harness = build([51, 52], { isSingleResumeCandidate: (sessionDbId) => sessionDbId !== 51 });
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);

    await harness.advance(10 * MINUTE);

    expect(resume.mock.calls).toEqual([[52, 'quota-resume']]);
  });

  it('looks again later, without spending a probe, when no waiting session can probe yet', async () => {
    let eligible = false;
    harness = build([51], { isSingleResumeCandidate: () => eligible });
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 51);

    await harness.advance(10 * MINUTE);
    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.snapshot().quota.codex).toBe(clock.nowMs + QUOTA_PROBE_STALE_MS);

    // The overflow pause lifts: the next look probes, and it is still the
    // first of the allowed probes.
    eligible = true;
    await harness.advance(QUOTA_PROBE_STALE_MS);
    expect(resume.mock.calls).toEqual([[51, 'quota-resume']]);
    await harness.advance(5 * HOUR);
    expect(resume).toHaveBeenCalledTimes(QUOTA_RESUME_MAX_UNRESOLVED_PROBES);
  });

  it('never takes over a probe whose generator is still running, however long it runs', async () => {
    let holderRunning = true;
    harness = build([41, 42], { isQuotaProbeHolderActive: () => holderRunning });
    const { clock, resume, scheduler } = harness;
    recordQuotaExhausted('codex', 'Usage limit reached', 'quota_exhausted', clock.nowMs, clock.nowMs + 10 * MINUTE);
    scheduler.noteQuotaPause('codex', 41);

    // Another session's start claims the probe the moment the window ends,
    // and its slow run outlives the claim's staleness window several times.
    await harness.advance(10 * MINUTE - 1);
    const claim = tryAdmitQuotaProbe('codex', clock.nowMs + 1);
    expect(claim.admitted).toBe(true);
    await harness.advance(1 + 4 * QUOTA_PROBE_STALE_MS);
    expect(resume).not.toHaveBeenCalled();

    // Its run ends without resolving anything: now the watchdog may probe.
    holderRunning = false;
    releaseQuotaProbe('codex', claim.claimId);
    await harness.advance(QUOTA_PROBE_STALE_MS);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('ObserverResumeScheduler — codex re-check and canary', () => {
  let harness: ReturnType<typeof build>;

  afterEach(() => {
    harness?.scheduler.dispose();
  });

  it('asks the gate to re-check directly, instead of through one session that may be overflow-paused', async () => {
    const recheckDependency = mock(() => {});
    harness = build([121, 122], { recheckDependency, isSingleResumeCandidate: (sessionDbId) => sessionDbId !== 121 });
    const { clock, resume, scheduler } = harness;

    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    await harness.advance(30_000);

    expect(recheckDependency).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.snapshot().dependencyAtMs).toBeNull();
  });

  it('does not re-check on a timer when nothing is waiting, even with a re-check hook', async () => {
    const recheckDependency = mock(() => {});
    harness = build([], { recheckDependency });
    const { clock, scheduler } = harness;

    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    await harness.advance(30_000);

    expect(recheckDependency).not.toHaveBeenCalled();
  });

  it('without a re-check hook, resumes the first waiting session that can actually reach the gate', async () => {
    harness = build([121, 122], { isSingleResumeCandidate: (sessionDbId) => sessionDbId !== 121 });
    const { clock, resume, scheduler } = harness;

    scheduler.noteDependencyPause(clock.nowMs + 30_000);
    await harness.advance(30_000);

    expect(resume.mock.calls).toEqual([[122, 'codex-recheck']]);
  });

  it('starts exactly one waiting session as the canary: the oldest that can run alone', async () => {
    harness = build([131, 132, 133], { isSingleResumeCandidate: (sessionDbId) => sessionDbId !== 131 });
    const { resume, scheduler } = harness;

    expect(scheduler.resumeOnePending('codex-canary')).toBe(132);
    await harness.advance(0);

    expect(resume.mock.calls).toEqual([[132, 'codex-canary']]);
  });

  it('starts no canary when nothing is waiting', async () => {
    harness = build([]);
    expect(harness.scheduler.resumeOnePending('codex-canary')).toBeNull();
    await harness.advance(0);
    expect(harness.resume).not.toHaveBeenCalled();
  });
});
