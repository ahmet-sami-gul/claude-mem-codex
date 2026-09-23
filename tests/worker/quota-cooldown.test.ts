import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import {
  isQuotaCooldownActive,
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordQuotaExhausted,
  clearQuotaCooldown,
  getQuotaCooldown,
  checkQuotaHold,
  touchQuotaProbe,
  onQuotaCooldownCleared,
  forgetQuotaCooldownsInMemoryForTesting,
  resetQuotaCooldownListenersForTesting,
  resetQuotaCooldownsForTesting,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
  QUOTA_RESUME_MAX_HORIZON_MS,
} from '../../src/shared/quota-cooldown.js';
import {
  isObserverQuotaCooldownActive,
  isObserverUnhealthy,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
} from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';

describe('quota cooldown breaker (#3634)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  // The breaker is process-global by design (a user's quota is per-account, not
  // per-session), so a cooldown left armed here would gate generator starts in
  // every later test file in this bun process.
  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('is inactive until a provider reports the allowance exhausted', () => {
    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('withholds requests for the cooldown window once armed', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');

    expect(isQuotaCooldownActive('claude')).toBe(true);
    expect(getQuotaCooldown('claude')?.window).toBe('weekly');
  });

  it('is scoped per provider — one capped provider does not gate the others', () => {
    recordQuotaExhausted('openrouter', 'Spend cap reached');

    expect(isQuotaCooldownActive('openrouter')).toBe(true);
    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(isQuotaCooldownActive('gemini')).toBe(false);
  });

  it('lets exactly one probe through once the window elapses', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');

    const justBefore = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1;
    const justAfter = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(isQuotaCooldownActive('claude', justBefore)).toBe(true);
    expect(isQuotaCooldownActive('claude', justAfter)).toBe(false);
    // State is retained after expiry so a failed probe can re-arm rather than
    // starting from a clean slate.
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('re-arms on a failed probe, restamping the window', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const first = getQuotaCooldown('claude')!.armedAtMs;

    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.armedAtMs).toBeGreaterThanOrEqual(first);
    expect(isQuotaCooldownActive('claude', reArmed.armedAtMs + 1)).toBe(true);
  });

  it('clears immediately on success so recovery does not wait out the window', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(isQuotaCooldownActive('claude')).toBe(true);

    clearQuotaCooldown('claude');

    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('admits every caller when no breaker is armed', () => {
    // No breaker means no probe to own, so neither admission carries a claim.
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
  });

  it('withholds every caller while the window is still cooling', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('admits exactly ONE concurrent caller after expiry, not all of them', () => {
    // The reported machine ran 28-69 live sessions; they all observe the window
    // elapse at the same instant, so a bare time check would let them all send.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const admitted = Array.from({ length: 28 }, () =>
      tryAdmitQuotaProbe('claude', afterExpiry)
    ).filter(result => result.admitted);

    expect(admitted).toHaveLength(1);
  });

  it('keeps withholding while the claimed probe is still in flight', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Much later, but still unresolved and not yet stale.
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS - 1).admitted).toBe(false);
  });

  it('re-admits once a claimed probe goes stale, so a dead generator cannot wedge the provider shut', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1).admitted).toBe(true);
  });

  it('releases the claim on a generator exit that neither succeeded nor re-armed', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const claim = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(claim.admitted).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(false);

    releaseQuotaProbe('claude', claim.claimId);

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
  });

  it('does not let a generator admitted before the breaker release a later session\u2019s probe', () => {
    // The overlap that made an unscoped release wrong: session A started while
    // the provider was healthy, so it owns no probe at all. The breaker then
    // arms and expires, session B claims the sole probe, and only afterwards
    // does A's long-running generator exit.
    const sessionA = tryAdmitQuotaProbe('claude');
    expect(sessionA).toEqual({ admitted: true, claimId: null });

    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const sessionB = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(sessionB.admitted).toBe(true);

    // A exits. Its request is long over, but B's probe is still in flight.
    releaseQuotaProbe('claude', sessionA.claimId);

    // Session C must stay withheld: B is still waiting on the provider.
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(false);
    expect(getQuotaCooldown('claude')?.probeInFlightSinceMs).toBe(afterExpiry);
  });

  it('does not let the owner of a stale probe release the takeover that replaced it', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const abandoned = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(abandoned.admitted).toBe(true);

    // Its generator never reached any exit path, so the claim went stale and
    // the next caller took over.
    const takeover = tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1);
    expect(takeover.admitted).toBe(true);
    expect(takeover.claimId).not.toBe(abandoned.claimId);

    // The abandoned generator finally dies and releases.
    releaseQuotaProbe('claude', abandoned.claimId);

    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 2).admitted).toBe(false);
  });

  it('does not let a probe from a cleared breaker release the probe of the next one', () => {
    const firstArmedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterFirstExpiry = firstArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const first = tryAdmitQuotaProbe('claude', afterFirstExpiry);
    expect(first.admitted).toBe(true);

    // That probe succeeded, so the breaker went away entirely...
    clearQuotaCooldown('claude');
    // ...and a later exhaustion armed a fresh one that has since expired.
    const secondArmedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterSecondExpiry = secondArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const second = tryAdmitQuotaProbe('claude', afterSecondExpiry);
    expect(second.admitted).toBe(true);

    // The first generator's exit must not reopen the second breaker.
    releaseQuotaProbe('claude', first.claimId);

    expect(tryAdmitQuotaProbe('claude', afterSecondExpiry).admitted).toBe(false);
  });

  it('clears the in-flight claim when the probe fails and re-arms', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);

    // The probe earned another refusal.
    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.probeInFlightSinceMs).toBeNull();
    // And the fresh window withholds again.
    expect(tryAdmitQuotaProbe('claude', reArmed.armedAtMs + 1).admitted).toBe(false);
  });

  it('scopes the probe claim per provider', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    recordQuotaExhausted('openrouter', 'Spend cap reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Claiming claude's probe must not consume openrouter's.
    expect(tryAdmitQuotaProbe('openrouter', afterExpiry).admitted).toBe(true);
  });

  it('bounds capped traffic to one probe per window instead of one per observation', () => {
    // Reproduces the reported shape: a capped user keeps working, so a tool call
    // arrives every few seconds for the rest of the billing cycle.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');

    let requestsSent = 0;
    for (let elapsed = 0; elapsed < QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS * 2; elapsed += 5_000) {
      if (!isQuotaCooldownActive('claude', armedAt + elapsed)) {
        requestsSent++;
        // A probe that fails re-arms; model that as the worst case.
        break;
      }
    }

    // Before the fix this loop sent ~720 doomed requests; now it sends one.
    expect(requestsSent).toBe(1);
  });

  it('mirrors the armed window into observer-health.json and clears it on success', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const priorFailures = readObserverHealth(healthPath)?.consecutiveFailures ?? 0;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');

    const armed = readObserverHealth(healthPath)!;
    expect(armed.consecutiveFailures).toBe(priorFailures);
    expect(armed.quotaCooldown).not.toBeNull();
    expect(armed.quotaCooldown!.active).toBe(true);
    expect(armed.quotaCooldown!.provider).toBe('claude');
    expect(armed.quotaCooldown!.window).toBe('weekly');
    expect(armed.quotaCooldown!.until).toBe(armed.quotaCooldown!.armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
    expect(isObserverQuotaCooldownActive(armed)).toBe(true);
    // A cooldown is not a failure: arming must not itself trip the banner.
    expect(isObserverUnhealthy({ ...armed, consecutiveFailures: 0, lastErrorAt: null })).toBe(false);

    clearQuotaCooldown('claude');
    const cleared = readObserverHealth(healthPath);
    expect(cleared === null || cleared.quotaCooldown === null).toBe(true);
    expect(isObserverQuotaCooldownActive(cleared)).toBe(false);
  });
});

/**
 * Provider-stated resume times (plan 3.5, M3).
 *
 * A Codex refusal says "Try again at 4:35 PM"; the fixed 30-minute window is
 * the guess we make when nothing said anything. These cover the new behaviour
 * AND, just as importantly, that the old behaviour is bit-for-bit intact for
 * every provider that states no time — claude, gemini, openrouter and
 * cmem-gateway never pass one, and none of them may notice this field exists.
 */
describe('quota cooldown resume times (M3)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
    resetQuotaCooldownListenersForTesting();
  });

  const HOUR = 60 * 60_000;

  it('withholds until the stated resume time, past the fixed window', () => {
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * HOUR;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    expect(getQuotaCooldown('codex')?.resumeAtMs).toBe(resumeAt);
    // The fixed window would have re-probed here; the stated time says no.
    expect(isQuotaCooldownActive('codex', armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1)).toBe(true);
    expect(tryAdmitQuotaProbe('codex', armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1).admitted).toBe(false);

    expect(isQuotaCooldownActive('codex', resumeAt - 1)).toBe(true);
    expect(isQuotaCooldownActive('codex', resumeAt + 1)).toBe(false);

    const probe = tryAdmitQuotaProbe('codex', resumeAt + 1);
    expect(probe.admitted).toBe(true);
    expect(probe.claimId).not.toBeNull();
    releaseQuotaProbe('codex', probe.claimId);
  });

  it('honours a stated time SHORTER than the fixed window', () => {
    const armedAt = Date.now();
    const resumeAt = armedAt + 5 * 60_000;
    recordQuotaExhausted('codex', 'Selected model is at capacity', undefined, armedAt, resumeAt);

    expect(isQuotaCooldownActive('codex', resumeAt - 1)).toBe(true);
    // Waiting out the full 30 minutes when the provider said five is exactly
    // the pause the resume scheduler exists to stop.
    expect(isQuotaCooldownActive('codex', resumeAt + 1)).toBe(false);
    expect(tryAdmitQuotaProbe('codex', resumeAt + 1).admitted).toBe(true);
    releaseQuotaProbe('codex', getQuotaCooldown('codex')!.probeClaimId);
  });

  it('leaves claude, gemini and openrouter on the exact fixed-window arithmetic', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const armedAt = Date.now();
    for (const provider of ['claude', 'gemini', 'openrouter'] as const) {
      // The pre-M3 call shape: no resume time anywhere in it.
      recordQuotaExhausted(provider, 'Weekly limit reached', 'weekly', armedAt);

      // The field must not appear at all, so nothing downstream (the health
      // mirror's `until`, the resume scheduler) can start reading one.
      expect(getQuotaCooldown(provider)!.resumeAtMs).toBeUndefined();

      // Observer health, which drives the session-start banner, must still
      // read armedAt + the fixed window for these three.
      const mirrored = readObserverHealth(healthPath)!.quotaCooldown!;
      expect(mirrored.provider).toBe(provider);
      expect(mirrored.until).toBe(mirrored.armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);

      const boundary = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS;
      // `nowMs - armedAtMs < cooldownMs`, asserted at the boundary itself:
      // strictly-less-than, so the instant of expiry is already admitted.
      expect(isQuotaCooldownActive(provider, boundary - 1)).toBe(true);
      expect(isQuotaCooldownActive(provider, boundary)).toBe(false);
      expect(tryAdmitQuotaProbe(provider, boundary - 1).admitted).toBe(false);
      const probe = tryAdmitQuotaProbe(provider, boundary);
      expect(probe.admitted).toBe(true);
      releaseQuotaProbe(provider, probe.claimId);
      clearQuotaCooldown(provider);
    }
  });

  it('keeps the caller-supplied cooldownMs authoritative when no time is stated', () => {
    // provider-dispatch passes CMEM_FALLBACK_RETRY_MS for the gateway.
    const armedAt = Date.now();
    const custom = 90_000;
    recordQuotaExhausted('cmem-gateway', 'gateway quota', undefined, armedAt);

    expect(isQuotaCooldownActive('cmem-gateway', armedAt + custom - 1, custom)).toBe(true);
    expect(isQuotaCooldownActive('cmem-gateway', armedAt + custom, custom)).toBe(false);
    expect(tryAdmitQuotaProbe('cmem-gateway', armedAt + custom - 1, custom).admitted).toBe(false);
    const probe = tryAdmitQuotaProbe('cmem-gateway', armedAt + custom, custom);
    expect(probe.admitted).toBe(true);
    releaseQuotaProbe('cmem-gateway', probe.claimId);
  });

  it('ignores a resume time at or before the arming instant', () => {
    // "Try again later" with no parsable time must fall back to 30 minutes,
    // never to zero — a breaker that expires the moment it arms is the
    // per-observation request storm this module exists to stop.
    const armedAt = Date.now();
    for (const bogus of [armedAt, armedAt - 60_000, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      recordQuotaExhausted('codex', 'Try again later', undefined, armedAt, bogus);
      expect(getQuotaCooldown('codex')!.resumeAtMs).toBeUndefined();
      expect(isQuotaCooldownActive('codex', armedAt + 1)).toBe(true);
      expect(isQuotaCooldownActive('codex', armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS)).toBe(false);
      clearQuotaCooldown('codex');
    }
  });

  it('clamps an absurd resume time to the trust horizon instead of wedging shut', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('codex', 'misparsed date', undefined, armedAt, armedAt + 400 * 24 * HOUR);

    expect(getQuotaCooldown('codex')!.resumeAtMs).toBe(armedAt + QUOTA_RESUME_MAX_HORIZON_MS);
    expect(isQuotaCooldownActive('codex', armedAt + QUOTA_RESUME_MAX_HORIZON_MS + 1)).toBe(false);
  });

  it('carries a still-future resume time across a re-arm that states none', () => {
    // The prose/abort path arms with a generic message and no time. Without
    // the carry-forward it would restamp "back at 4:35 PM" into "another 30
    // minutes from now", every time a session hit the breaker.
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * HOUR;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    const reArmed = recordQuotaExhausted(
      'codex',
      'Provider reported the inference allowance exhausted',
      undefined,
      armedAt + 10 * 60_000,
    );

    expect(reArmed.resumeAtMs).toBe(resumeAt);
    expect(isQuotaCooldownActive('codex', resumeAt - 1)).toBe(true);
    expect(isQuotaCooldownActive('codex', resumeAt + 1)).toBe(false);
  });

  it('drops a resume time that has already passed when re-arming', () => {
    // The allowance returned, the probe went out, Codex refused again without
    // naming a new time. Carrying the stale time would leave the breaker
    // expired on arrival.
    const armedAt = Date.now();
    const resumeAt = armedAt + HOUR;
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt, resumeAt);

    const reArmedAt = resumeAt + 1_000;
    const reArmed = recordQuotaExhausted('codex', 'Usage limit reached', undefined, reArmedAt);

    expect(reArmed.resumeAtMs).toBeUndefined();
    expect(isQuotaCooldownActive('codex', reArmedAt + 1)).toBe(true);
    expect(isQuotaCooldownActive('codex', reArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS)).toBe(false);
  });

  it('lets an explicitly stated time override the carried one', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('codex', 'first', undefined, armedAt, armedAt + 4 * HOUR);

    const reArmed = recordQuotaExhausted('codex', 'second', undefined, armedAt, armedAt + 2 * HOUR);

    expect(reArmed.resumeAtMs).toBe(armedAt + 2 * HOUR);
  });

  it('survives a restart with the stated time intact', () => {
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * HOUR;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    // Same shape as a fresh process: the Map is empty and the latch is down,
    // so the next read hydrates from the ledger on disk.
    forgetQuotaCooldownsInMemoryForTesting();

    expect(getQuotaCooldown('codex')?.resumeAtMs).toBe(resumeAt);
    expect(isQuotaCooldownActive('codex', armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1)).toBe(true);
    expect(isQuotaCooldownActive('codex', resumeAt + 1)).toBe(false);
    // Never restored: the process that could have held a claim is gone.
    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBeNull();
  });

  it('tags the window with the refusal code, persists it, and never carries it across a re-arm that states none (M4)', () => {
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * HOUR;
    expect(recordQuotaExhausted('codex', 'Local Codex exec budget reached', undefined, armedAt, resumeAt, 'local_budget').code)
      .toBe('local_budget');

    forgetQuotaCooldownsInMemoryForTesting();
    expect(getQuotaCooldown('codex')?.code).toBe('local_budget');

    // A later refusal with another (or no) cause names THAT cause; the resume
    // time is still carried as before.
    const reArmed = recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt + 1_000);
    expect(reArmed.code).toBeUndefined();
    expect(reArmed.resumeAtMs).toBe(resumeAt);
    forgetQuotaCooldownsInMemoryForTesting();
    expect(getQuotaCooldown('codex')?.code).toBeUndefined();

    // The other providers' states are exactly what they were: no code at all.
    expect('code' in recordQuotaExhausted('openrouter', 'Spend cap reached')).toBe(false);
  });

  it('mirrors the stated resume time into observer-health as the real `until`', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * HOUR;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    const armed = readObserverHealth(healthPath)!;
    expect(armed.quotaCooldown!.provider).toBe('codex');
    // The banner counts down to this. Printing armedAt + 30 minutes told the
    // user the observer was back in half an hour when it was four hours away.
    expect(armed.quotaCooldown!.until).toBe(resumeAt);
    expect(isObserverQuotaCooldownActive(armed)).toBe(true);

    clearQuotaCooldown('codex');
  });
});

describe('quota cooldown clear listeners (M3 drain-on-clear)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetQuotaCooldownListenersForTesting();
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
    resetQuotaCooldownListenersForTesting();
  });

  it('announces the provider whose armed breaker was cleared', () => {
    const seen: string[] = [];
    const off = onQuotaCooldownCleared(provider => seen.push(provider));

    recordQuotaExhausted('codex', "You've hit your usage limit");
    expect(seen).toEqual([]);

    clearQuotaCooldown('codex');
    expect(seen).toEqual(['codex']);

    off();
  });

  it('stays silent when nothing was armed', () => {
    // ResponseProcessor clears the breaker on EVERY successful store. For a
    // healthy provider that is once per observation; announcing those would
    // make the resume scheduler fan out across every session, per observation.
    const seen: string[] = [];
    const off = onQuotaCooldownCleared(provider => seen.push(provider));

    clearQuotaCooldown('claude');
    clearQuotaCooldown('claude');

    expect(seen).toEqual([]);
    off();
  });

  it('still clears a stale health-file window when nothing is armed in memory', () => {
    // The unannounced path must keep doing its other job: this is the call
    // that drops a cooldown a previous process left in observer-health.json.
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(readObserverHealth(healthPath)?.quotaCooldown).not.toBeNull();

    clearQuotaCooldown('claude');
    clearQuotaCooldown('claude');

    const cleared = readObserverHealth(healthPath);
    expect(cleared === null || cleared.quotaCooldown === null).toBe(true);
  });

  it('unsubscribes, and one throwing listener does not stop the others or the clear', () => {
    const seen: string[] = [];
    const offGone = onQuotaCooldownCleared(() => seen.push('gone'));
    offGone();
    const offBad = onQuotaCooldownCleared(() => { throw new Error('subscriber blew up'); });
    const offGood = onQuotaCooldownCleared(provider => seen.push(`good:${provider}`));

    recordQuotaExhausted('codex', "You've hit your usage limit");
    expect(() => clearQuotaCooldown('codex')).not.toThrow();

    expect(seen).toEqual(['good:codex']);
    expect(getQuotaCooldown('codex')).toBeNull();

    offBad();
    offGood();
  });
});

/**
 * `checkQuotaHold` — the repeatable, read-only check a generator that is
 * ALREADY RUNNING makes before each call (plan 3.5).
 */
describe('checkQuotaHold (M3 in-flight circuit)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('does not hold when no breaker is armed', () => {
    expect(checkQuotaHold('codex')).toEqual({ held: false, reason: null, state: null, resumeAtMs: null });
  });

  it('holds inside the window and reports when it lifts', () => {
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * 60 * 60_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    const hold = checkQuotaHold('codex', null, armedAt + 1_000);
    expect(hold.held).toBe(true);
    expect(hold.reason).toBe('cooldown');
    expect(hold.resumeAtMs).toBe(resumeAt);
    expect(hold.state?.message).toBe("You've hit your usage limit");
  });

  it('falls back to the fixed window for a provider that stated no time', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);

    expect(checkQuotaHold('claude', null, armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1).held).toBe(true);
    expect(checkQuotaHold('claude', null, armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS).held).toBe(false);
  });

  it('never claims the probe — it is read-only', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    checkQuotaHold('claude', null, afterExpiry);
    checkQuotaHold('claude', null, afterExpiry);

    expect(getQuotaCooldown('claude')?.probeInFlightSinceMs).toBeNull();
    expect(getQuotaCooldown('claude')?.probeClaimId).toBeNull();
    // Still the caller that would have been admitted first.
    const probe = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(probe.admitted).toBe(true);
    releaseQuotaProbe('claude', probe.claimId);
  });

  it('holds everyone except the generator that owns the in-flight probe', () => {
    // This is the case isQuotaCooldownActive cannot express: once the window
    // elapses it answers false for every session, including the ones the
    // single-probe rule is withholding.
    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const probe = tryAdmitQuotaProbe('codex', afterExpiry);
    expect(probe.admitted).toBe(true);
    expect(isQuotaCooldownActive('codex', afterExpiry)).toBe(false);

    // The prober itself: it IS the one allowed call.
    expect(checkQuotaHold('codex', probe.claimId, afterExpiry).held).toBe(false);
    // Another session, and a generator that started before any breaker existed
    // and so carries no claim at all.
    const other = checkQuotaHold('codex', (probe.claimId ?? 0) + 1, afterExpiry);
    expect(other.held).toBe(true);
    expect(other.reason).toBe('probe_in_flight');
    expect(checkQuotaHold('codex', null, afterExpiry).held).toBe(true);

    releaseQuotaProbe('codex', probe.claimId);
    // Released: the next caller is free again.
    expect(checkQuotaHold('codex', null, afterExpiry).held).toBe(false);
  });

  it('lifts once an abandoned probe goes stale, matching tryAdmitQuotaProbe', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const abandoned = tryAdmitQuotaProbe('codex', afterExpiry);
    expect(checkQuotaHold('codex', null, afterExpiry + QUOTA_PROBE_STALE_MS - 1).held).toBe(true);
    expect(checkQuotaHold('codex', null, afterExpiry + QUOTA_PROBE_STALE_MS + 1).held).toBe(false);

    releaseQuotaProbe('codex', abandoned.claimId);
    clearQuotaCooldown('codex');
  });

  it('is scoped per provider', () => {
    recordQuotaExhausted('codex', "You've hit your usage limit");

    expect(checkQuotaHold('codex').held).toBe(true);
    expect(checkQuotaHold('claude').held).toBe(false);
    expect(checkQuotaHold('openrouter').held).toBe(false);
  });
});

describe('touchQuotaProbe (M3: a live probe keeps its claim)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it("refreshes the caller's own claim, so a slow but live probe is not taken over", () => {
    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const claimedAt = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    const probe = tryAdmitQuotaProbe('codex', claimedAt);
    expect(probe.admitted).toBe(true);

    // Still spending four minutes in: the circuit lets it through and touches.
    const stillWorking = claimedAt + QUOTA_PROBE_STALE_MS - 60_000;
    expect(touchQuotaProbe('codex', probe.claimId, stillWorking)).toBe(true);
    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBe(stillWorking);

    // Where the original claim would have gone stale, nobody may take over.
    const takeover = tryAdmitQuotaProbe('codex', claimedAt + QUOTA_PROBE_STALE_MS + 1);
    expect(takeover.admitted).toBe(false);
    expect(checkQuotaHold('codex', null, claimedAt + QUOTA_PROBE_STALE_MS + 1).held).toBe(true);

    releaseQuotaProbe('codex', probe.claimId);
  });

  it("never touches someone else's claim, a released claim, or a missing breaker", () => {
    expect(touchQuotaProbe('codex', 1)).toBe(false);

    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const claimedAt = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    const probe = tryAdmitQuotaProbe('codex', claimedAt);

    expect(touchQuotaProbe('codex', null, claimedAt + 1_000)).toBe(false);
    expect(touchQuotaProbe('codex', (probe.claimId ?? 0) + 1, claimedAt + 1_000)).toBe(false);
    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBe(claimedAt);

    releaseQuotaProbe('codex', probe.claimId);
    expect(touchQuotaProbe('codex', probe.claimId, claimedAt + 2_000)).toBe(false);
    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBeNull();
  });

  it('never moves the claim instant backwards', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const claimedAt = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    const probe = tryAdmitQuotaProbe('codex', claimedAt);

    expect(touchQuotaProbe('codex', probe.claimId, claimedAt - 10_000)).toBe(true);
    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBe(claimedAt);

    releaseQuotaProbe('codex', probe.claimId);
  });
});
