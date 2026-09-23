/**
 * Per-provider quota circuit breaker (#3634).
 *
 * When a provider reports the user's inference allowance exhausted, nothing
 * stopped the worker from trying again: the generator exits, and the very next
 * captured tool call runs `ensureGeneratorRunning`, which starts a fresh
 * generator, sends one more request, and earns the same refusal. There is one
 * doomed request per observation, for the rest of the billing cycle — 11 capped
 * users produced tens of thousands of cap events in a single day, roughly a
 * hundred per successful observation.
 *
 * `ensureGeneratorRunning` already has exactly this gate for a missing Claude
 * CLI (`setup_required` + `CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS`). This is the
 * same shape for quota, kept separate because quota is per-provider user state
 * rather than a machine-wide dependency.
 *
 * The breaker arms on a quota-exhausted generator exit, expires after a
 * cooldown so a single request can re-probe, and clears immediately on success
 * — so recovery costs at most one cooldown window, not a manual restart.
 *
 * PERSISTENCE, and the deliberate split within it.
 *
 * The armed window is written to disk beside `observer-health.json`, for the
 * reason that file's own docblock already gives: the state must survive worker
 * restarts. An in-memory-only breaker is cleared by every restart — the
 * `/api/admin/restart` endpoint (the process serving it IS the process holding
 * the Map), `npx claude-mem restart`, a reboot, a plugin-version SIGKILL, a
 * crash-and-respawn, and this repo's own documented `npm run build-and-sync`.
 * A crash-restart loop is the worst shape: crash, respawn, empty breaker,
 * doomed request, repeat — the storm again with extra steps.
 *
 * The probe claim (`probeInFlightSinceMs` / `probeClaimId`) is deliberately NOT
 * persisted, and must load as null. It is single-process concurrency state: a
 * restart kills every generator that could be holding one, so a claim restored
 * from disk would be owned by a dead process and would wedge the provider shut
 * until it went stale — the opposite of the failure this breaker prevents.
 *
 * PROVIDER-STATED RESUME TIMES (plan 3.5, M3).
 *
 * The fixed 30-minute window is a guess made when no provider told us anything.
 * Codex does: its refusals carry "Try again at 4:35 PM", which the classifier
 * turns into an absolute epoch. `resumeAtMs` carries that through, and every
 * admission check prefers it over the guess.
 *
 * It is strictly opt-in. A state with no `resumeAtMs` — which is every state
 * claude, gemini, openrouter and cmem-gateway ever produce, since nothing on
 * those paths passes one — takes exactly the arithmetic it took before:
 * `nowMs - armedAtMs < cooldownMs`. That equivalence is asserted directly in
 * tests/worker/quota-cooldown.test.ts, because "the other three providers are
 * untouched" is the property this whole addition has to keep.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';
import {
  clearObserverQuotaCooldown,
  recordObserverQuotaCooldown,
} from './observer-health.js';

/**
 * 'codex' is a first-class armed provider as of M3: the codex quota circuit in
 * CodexProvider reads this breaker before spending an exec, and the route arms
 * it from the CLI's own refusal. ResponseProcessor clears the breaker for
 * whatever `session.currentProvider` produced a successful store.
 */
export type QuotaProvider = 'claude' | 'gemini' | 'openrouter' | 'codex' | 'cmem-gateway';

export const QUOTA_COOLDOWN_FILENAME = 'quota-cooldown.json';

/**
 * The longest a provider-stated resume time may push the breaker out. The
 * longest real allowance window any supported provider has is weekly, and the
 * resume time is parsed out of human-facing prose in a locale we did not
 * choose — so a misparse must cost days at worst, never a permanently wedged
 * provider that only a restart can clear.
 */
export const QUOTA_RESUME_MAX_HORIZON_MS = 7 * 24 * 60 * 60_000;

/**
 * The persisted half of a breaker: the armed window only. Never the claim.
 */
interface PersistedQuotaCooldown {
  provider: QuotaProvider;
  message: string;
  window?: string;
  armedAtMs: number;
  /**
   * Persisted for the same reason `armedAtMs` is: a restart inside a five-hour
   * Codex window must not forget when the allowance actually returns and fall
   * back to probing every 30 minutes until it does.
   */
  resumeAtMs?: number;
}

function defaultCooldownFilePath(): string {
  return join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
}

let hydrated = false;

/** Read the armed windows written by a previous process, once per process. */
function hydrateFromDisk(filePath: string = defaultCooldownFilePath()): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (!existsSync(filePath)) return;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed as PersistedQuotaCooldown[]) {
      if (!entry || typeof entry.provider !== 'string' || typeof entry.armedAtMs !== 'number') continue;
      // Re-validated rather than trusted: this file is plain JSON on disk, and
      // a garbled resume time must degrade to the fixed window, not to a
      // breaker that is armed forever or not at all.
      const resumeAtMs = sanitizeResumeAtMs(entry.resumeAtMs, entry.armedAtMs);
      cooldowns.set(entry.provider, {
        provider: entry.provider,
        message: entry.message ?? 'Provider reported the inference allowance exhausted',
        ...(entry.window ? { window: entry.window } : {}),
        armedAtMs: entry.armedAtMs,
        ...(resumeAtMs !== undefined ? { resumeAtMs } : {}),
        // Never restored: the process that could have held this is gone.
        probeInFlightSinceMs: null,
        probeClaimId: null,
      });
    }
  } catch (err) {
    // A corrupt ledger must not stop the worker; it only costs one extra
    // request to re-arm the breaker.
    logger.warn('SESSION', 'Failed to read quota-cooldown file', { filePath }, err as Error);
  }
}

function persistToDisk(filePath: string = defaultCooldownFilePath()): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (cooldowns.size === 0) {
      if (existsSync(filePath)) unlinkSync(filePath);
      return;
    }
    const rows: PersistedQuotaCooldown[] = [...cooldowns.values()].map((state) => ({
      provider: state.provider,
      message: state.message,
      ...(state.window ? { window: state.window } : {}),
      armedAtMs: state.armedAtMs,
      ...(state.resumeAtMs !== undefined ? { resumeAtMs: state.resumeAtMs } : {}),
    }));
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    // Atomic swap, so a reader never sees a half-written ledger.
    renameSync(tmp, filePath);
  } catch (err) {
    logger.warn('SESSION', 'Failed to write quota-cooldown file', { filePath }, err as Error);
  }
}

/**
 * How long to withhold requests after a provider reports the allowance spent.
 * Long enough that a capped user stops generating traffic, short enough that a
 * reset window (or a plan upgrade) is picked up without restarting the worker.
 */
export const QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a claimed probe may stay unresolved before another caller may take
 * it. A generator that dies without reaching any completion path would
 * otherwise hold the claim forever and wedge the provider permanently — the
 * opposite failure to the one this breaker exists to prevent.
 */
export const QUOTA_PROBE_STALE_MS = 5 * 60_000;

export interface QuotaCooldownState {
  provider: QuotaProvider;
  /** Provider-reported reason, already free of any user prompt text. */
  message: string;
  /** Window the provider named, when it named one (e.g. 'weekly'). */
  window?: string;
  armedAtMs: number;
  /**
   * Absolute epoch ms the provider said the allowance returns, when it said so
   * at all. Undefined is the normal case and means "no provider told us" — the
   * fixed `QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS` window applies, exactly as it
   * did before this field existed.
   *
   * Always read through `quotaCooldownResumeAtMs`, never directly: that helper
   * is the single place the "stated time, else armedAt + fixed window" choice
   * is made, and having admission, logging and the health mirror disagree about
   * when the breaker lifts is precisely the bug this field is meant to fix.
   */
  resumeAtMs?: number;
  /**
   * When the single post-expiry probe was claimed, or null when none is in
   * flight. Without this the expiry check is a bare read: every concurrent
   * session passes it at once and they all hit the provider together, which on
   * a busy machine (#3800 saw 28-69 live sessions) turns "one probe per window"
   * back into a burst.
   */
  probeInFlightSinceMs: number | null;
  /**
   * Identifies the claim currently in flight, so only the caller that took it
   * can release it. A generator admitted while no breaker existed holds no
   * claim at all; without this id its exit would clear whatever probe a later
   * session had since started, readmitting a third session while the real
   * probe is still running.
   */
  probeClaimId: number | null;
}

/**
 * The result of an admission attempt. `claimId` is null on an admission that
 * took no claim — there was no breaker to claim against — and releasing must be
 * keyed on it rather than on "I was admitted", because such a generator can
 * outlive a later session's real probe.
 */
export interface QuotaProbeAdmission {
  admitted: boolean;
  claimId: number | null;
}

const cooldowns = new Map<QuotaProvider, QuotaCooldownState>();

/**
 * Accept a provider-stated resume time, or reject it back to `undefined` so the
 * fixed window applies.
 *
 * Rejected, deliberately, rather than clamped up:
 *   - anything not a finite number (a hand-edited ledger, a failed parse);
 *   - anything at or before `armedAtMs`. A "resume" already in the past would
 *     leave the breaker expired the instant it armed, which is the per-
 *     observation request storm this module exists to stop. "Try again later"
 *     with no time in it must fall back to 30 minutes, not to zero.
 *
 * Clamped, rather than rejected, when it is further out than
 * `QUOTA_RESUME_MAX_HORIZON_MS`: a genuinely long window should still be
 * honoured as far as we are willing to trust it, and only the excess is a
 * misparse.
 */
function sanitizeResumeAtMs(resumeAtMs: number | null | undefined, armedAtMs: number): number | undefined {
  if (resumeAtMs === null || resumeAtMs === undefined) return undefined;
  if (!Number.isFinite(resumeAtMs)) return undefined;
  if (resumeAtMs <= armedAtMs) return undefined;
  return Math.min(resumeAtMs, armedAtMs + QUOTA_RESUME_MAX_HORIZON_MS);
}

/**
 * When this breaker lets a call through: the provider's own resume time when it
 * stated one, otherwise the armed instant plus the fixed window.
 *
 * Pure, so a caller that already holds the state (a log line, the resume
 * scheduler, the health mirror) does not re-read the Map to ask.
 */
export function quotaCooldownResumeAtMs(
  state: QuotaCooldownState,
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): number {
  return state.resumeAtMs ?? state.armedAtMs + cooldownMs;
}

/**
 * Notified after a breaker that WAS armed is cleared, so the observation resume
 * scheduler can drain the sessions that paused behind it (plan 3.5,
 * drain-on-clear).
 */
export type QuotaCooldownClearedListener = (provider: QuotaProvider) => void;

const clearListeners = new Set<QuotaCooldownClearedListener>();

/**
 * Subscribe to "an armed breaker was just cleared". Returns the unsubscribe.
 *
 * Fires ONLY when a cooldown was actually removed. `clearQuotaCooldown` runs on
 * every successful store (ResponseProcessor), which for a healthy provider is
 * once per observation — announcing those would turn the resume scheduler's
 * "trigger every session with pending work" into a per-observation fan-out
 * across the whole worker.
 */
export function onQuotaCooldownCleared(listener: QuotaCooldownClearedListener): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
}

function notifyQuotaCooldownCleared(provider: QuotaProvider): void {
  for (const listener of [...clearListeners]) {
    try {
      listener(provider);
    } catch (err) {
      // A subscriber that throws must not leave the breaker half-cleared, and
      // must not stop the other subscribers from hearing about it.
      logger.warn('SESSION', 'Quota cooldown clear listener threw', { provider }, err as Error);
    }
  }
}

/**
 * Monotonic id for probe claims, only ever compared for equality. A claim's
 * timestamp cannot double as its identity: the testing seams admit repeat
 * claims inside a single millisecond, and two claims sharing an id would
 * reintroduce exactly the cross-session release this exists to prevent.
 */
let nextProbeClaimId = 1;

/** Arm the breaker for `provider`. Re-arming restamps the cooldown. */
export function recordQuotaExhausted(
  provider: QuotaProvider,
  message: string,
  window?: string,
  /**
   * When the window was armed. Defaults to now for a real refusal; passed
   * explicitly only when reviving a window that was armed before a restart,
   * so a reload cannot restamp it and hold the provider shut for a fresh full
   * cooldown on every restart.
   */
  armedAtMs: number = Date.now(),
  /**
   * Absolute epoch ms the provider said the allowance returns. Only Codex
   * states one today; every other caller omits it and gets the fixed window.
   */
  resumeAtMs?: number | null,
): QuotaCooldownState {
  hydrateFromDisk();
  const prior = cooldowns.get(provider);
  const stated = sanitizeResumeAtMs(resumeAtMs, armedAtMs);
  // Carry a still-future resume time across a re-arm that does not state one.
  //
  // Re-arming restamps `armedAtMs`, so without this a refusal the provider did
  // not put a time on — the prose/abort path arms with the generic message —
  // would replace "back at 4:35 PM" with "another 30 minutes from now", every
  // time it happened. On a busy machine that extends the window indefinitely
  // and the allowance is never re-probed at the moment it actually returns.
  //
  // A prior time that has already passed is NOT carried: that is the
  // "allowance returned, we probed, Codex refused again with no new time"
  // case, and keeping it would leave the breaker expired on arrival and hand
  // back the per-observation storm. Providers that never state a time have no
  // prior to carry, so this branch is unreachable for them.
  const carried = prior && prior.resumeAtMs !== undefined && prior.resumeAtMs > armedAtMs
    ? prior.resumeAtMs
    : undefined;
  const effectiveResumeAtMs = stated ?? carried;
  const state: QuotaCooldownState = {
    provider,
    message,
    ...(window ? { window } : {}),
    armedAtMs,
    ...(effectiveResumeAtMs !== undefined ? { resumeAtMs: effectiveResumeAtMs } : {}),
    // Re-arming ends whatever probe was in flight: this IS that probe failing.
    probeInFlightSinceMs: null,
    probeClaimId: null,
  };
  cooldowns.set(provider, state);
  persistToDisk();
  syncObserverHealthQuotaCooldown();
  return state;
}

/**
 * Clear the breaker — call on any successful generation for that provider.
 *
 * The persist + health mirror run unconditionally, exactly as before: this is
 * also the call that drops a stale window a previous process left in
 * observer-health.json, and a healthy provider reaches it on every store.
 * Only the clear-listener notification is conditional on something having
 * actually been armed.
 */
export function clearQuotaCooldown(provider: QuotaProvider): void {
  hydrateFromDisk();
  const wasArmed = cooldowns.delete(provider);
  persistToDisk();
  syncObserverHealthQuotaCooldown();
  if (wasArmed) notifyQuotaCooldownCleared(provider);
}

export function getQuotaCooldown(provider: QuotaProvider): QuotaCooldownState | null {
  hydrateFromDisk();
  return cooldowns.get(provider) ?? null;
}

/**
 * True while requests to `provider` should be withheld. Read-only — it never
 * claims the probe, so it is safe for logging and diagnostics.
 *
 * Callers deciding whether to actually send must use `tryAdmitQuotaProbe`
 * instead: this returning false only means the window elapsed, and on a machine
 * with many live sessions every one of them observes that at the same instant.
 */
export function isQuotaCooldownActive(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): boolean {
  hydrateFromDisk();
  const state = cooldowns.get(provider);
  if (!state) return false;
  // With no stated resume time this is `nowMs - armedAtMs < cooldownMs`, byte
  // for byte the behaviour every non-codex provider had before M3.
  return nowMs < quotaCooldownResumeAtMs(state, cooldownMs);
}

/** Why a call is being withheld, for the log line and the refusal message. */
export type QuotaHoldReason = 'cooldown' | 'probe_in_flight';

export interface QuotaHold {
  held: boolean;
  reason: QuotaHoldReason | null;
  /** The armed breaker this was decided against, or null when none is armed. */
  state: QuotaCooldownState | null;
  /** Absolute epoch ms this hold is expected to lift, or null when not held. */
  resumeAtMs: number | null;
}

/**
 * Whether a caller that is ALREADY INSIDE a running generator must withhold
 * this request (plan 3.5, "kota kontrolü çalışan generator'larda").
 *
 * `tryAdmitQuotaProbe` runs once, when a generator starts. A breaker armed
 * after that moment is invisible to every session already running: each one
 * keeps sending until it earns its own refusal. For an HTTP provider that is a
 * wasted request; for Codex each of those is a subprocess against the user's
 * paid plan, so the check has to be repeatable at call time.
 *
 * Read-only by contract — it must never claim the probe. The caller here is not
 * starting a generator, so a claim it took would be released by a run that
 * never owned one, or not at all.
 *
 * Why `isQuotaCooldownActive` cannot do this job: once the window elapses it
 * returns false for EVERY session, including the ones the single-probe rule is
 * withholding while another session's probe is still out. Passing
 * `claimId` (the caller's `session.quotaProbeClaimId`) is what separates the one
 * generator that holds the probe from the rest.
 *
 * Held when:
 *   - the window has not elapsed (stated resume time, else the fixed one); or
 *   - it has, but a non-stale probe is in flight under a DIFFERENT claim.
 * Not held when there is no breaker, when the window elapsed with no probe out,
 * when the in-flight probe is this caller's own, or when it has gone stale —
 * the three cases `tryAdmitQuotaProbe` would itself admit.
 */
export function checkQuotaHold(
  provider: QuotaProvider,
  claimId: number | null = null,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): QuotaHold {
  hydrateFromDisk();
  const state = cooldowns.get(provider) ?? null;
  if (!state) return { held: false, reason: null, state: null, resumeAtMs: null };

  const resumeAtMs = quotaCooldownResumeAtMs(state, cooldownMs);
  if (nowMs < resumeAtMs) {
    return { held: true, reason: 'cooldown', state, resumeAtMs };
  }

  const inFlight = state.probeInFlightSinceMs;
  if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS && state.probeClaimId !== claimId) {
    // There is no knowing when someone else's probe resolves, so the staleness
    // deadline stands in: it is the moment this hold is guaranteed to lift even
    // if that probe never reports back.
    return { held: true, reason: 'probe_in_flight', state, resumeAtMs: inFlight + QUOTA_PROBE_STALE_MS };
  }

  return { held: false, reason: null, state, resumeAtMs: null };
}

/**
 * Decide whether this caller may send to `provider`, claiming the single
 * post-expiry probe if so.
 *
 * Admits when there is no breaker at all, or when the window has elapsed and no
 * probe is currently in flight. The claim is taken synchronously, so among
 * concurrent callers on this single-threaded worker exactly one wins and the
 * rest are withheld until that probe resolves — success clears the breaker,
 * failure re-arms it, and `releaseQuotaProbe` covers every other exit.
 *
 * An admission with no breaker in place carries a null `claimId`: it owns no
 * probe, and passing that null back to `releaseQuotaProbe` is what stops such a
 * generator from clearing a probe some later session claimed while it ran.
 */
export function tryAdmitQuotaProbe(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): QuotaProbeAdmission {
  // A breaker armed before a restart is still armed. Without this the first
  // call in a fresh process finds an empty Map, admits, and takes no claim —
  // the herd returns at exactly the moment the breaker should be strongest.
  hydrateFromDisk();
  const state = cooldowns.get(provider);
  if (!state) return { admitted: true, claimId: null };

  // Same equivalence as isQuotaCooldownActive: no stated resume time means the
  // fixed window, and the fixed window means the pre-M3 arithmetic.
  if (nowMs < quotaCooldownResumeAtMs(state, cooldownMs)) {
    return { admitted: false, claimId: null };
  }

  const inFlight = state.probeInFlightSinceMs;
  if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS) {
    return { admitted: false, claimId: null };
  }

  // A stale takeover mints a fresh id, so the abandoned owner's late release
  // finds a claim it does not own and leaves this one alone.
  const claimId = nextProbeClaimId++;
  state.probeInFlightSinceMs = nowMs;
  state.probeClaimId = claimId;
  return { admitted: true, claimId };
}

/**
 * Release the probe this run claimed, without deciding the breaker's fate.
 *
 * Called on every generator exit: if the probe succeeded the breaker is already
 * gone, and if it earned another refusal `recordQuotaExhausted` already re-armed
 * and cleared the claim. This covers the remaining exits (abort, crash, an
 * unrelated error) so a claim can never outlive the request that took it.
 *
 * `claimId` scopes that to the caller's own claim. Generators overlap freely —
 * one admitted before any breaker existed can exit long after a later session
 * claimed the sole post-cooldown probe — so an unscoped release would clear a
 * probe still in flight and admit a third session behind it.
 */
export function releaseQuotaProbe(provider: QuotaProvider, claimId: number | null): void {
  // Admitted with no breaker armed: this run never owned a probe, and any probe
  // in flight now belongs to a different session.
  if (claimId === null) return;
  hydrateFromDisk();

  const state = cooldowns.get(provider);
  if (state && state.probeClaimId === claimId) {
    state.probeInFlightSinceMs = null;
    state.probeClaimId = null;
  }
}

/**
 * Keep a LIVE probe's claim fresh: the claim holder is still working, so its
 * claim must not go stale under it.
 *
 * Staleness exists for a probe whose owner died without releasing. It measures
 * from the claim instant, and a healthy Codex probe is an init exec plus at
 * least one observation exec at up to CLAUDE_MEM_CODEX_TIMEOUT_MS each — easily
 * past QUOTA_PROBE_STALE_MS without storing anything. Without a refresh, a slow
 * but healthy probe would be taken over by a second paid probe running
 * alongside it, and the resume scheduler's watchdog would drive that takeover
 * on a timer.
 *
 * Called by the codex quota circuit each time it lets the holder through, so
 * the claim stays fresh exactly as long as its owner keeps issuing calls.
 * Scoped to the caller's own claim; returns whether it matched. Never
 * persisted, like the claim itself.
 */
export function touchQuotaProbe(
  provider: QuotaProvider,
  claimId: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (claimId === null) return false;
  hydrateFromDisk();
  const state = cooldowns.get(provider);
  if (!state || state.probeClaimId !== claimId || state.probeInFlightSinceMs === null) return false;
  state.probeInFlightSinceMs = Math.max(state.probeInFlightSinceMs, nowMs);
  return true;
}

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
  // The latch must drop too, or a test that wrote a ledger would leak its
  // armed windows into the next test through a stale "already hydrated".
  hydrated = false;
  try {
    const filePath = defaultCooldownFilePath();
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Nothing to clean up.
  }
  try {
    clearObserverQuotaCooldown();
  } catch {
    // Observability must never affect the breaker, including test reset.
  }
}

/**
 * Test hook: forget the in-memory breakers WITHOUT touching the ledger on disk,
 * i.e. exactly the state a fresh worker process starts in.
 *
 * Separate from `resetQuotaCooldownsForTesting`, which deletes the file: that
 * one exists so a test cannot leak an armed window into the next test, and it
 * is the wrong tool for asserting what a restart restores.
 */
export function forgetQuotaCooldownsInMemoryForTesting(): void {
  cooldowns.clear();
  hydrated = false;
}

/**
 * Test hook: drop every clear-listener subscription.
 *
 * Deliberately NOT part of `resetQuotaCooldownsForTesting`, which tests call in
 * `beforeEach`. The resume scheduler subscribes once when it is constructed, and
 * silently unsubscribing it between two assertions in the same test would make
 * drain-on-clear look broken in exactly the tests written to prove it works.
 * A test that registers its own listener uses the unsubscribe
 * `onQuotaCooldownCleared` hands back; this is for the file-level teardown.
 */
export function resetQuotaCooldownListenersForTesting(): void {
  clearListeners.clear();
}

/**
 * Mirror the in-memory breaker into observer-health.json so session-start
 * and external monitors can see an intentional pause. Best-effort: a health
 * write failure must not change admission or drain-on-clear.
 */
function syncObserverHealthQuotaCooldown(): void {
  try {
    let latest: QuotaCooldownState | null = null;
    for (const state of cooldowns.values()) {
      if (!latest || state.armedAtMs > latest.armedAtMs) latest = state;
    }
    if (!latest) {
      clearObserverQuotaCooldown();
      return;
    }
    recordObserverQuotaCooldown({
      active: true,
      provider: latest.provider,
      armedAt: latest.armedAtMs,
      // `until` is what the session-start banner prints and counts down to, so
      // it has to be the same instant admission uses. Before M3 that was always
      // armedAt + 30 minutes; for a Codex refusal that named a time, printing
      // that guess told the user to expect the observer back half an hour from
      // now when the allowance was actually hours away, or vice versa.
      until: quotaCooldownResumeAtMs(latest),
      ...(latest.window ? { window: latest.window } : {}),
      message: latest.message,
    });
  } catch (err) {
    logger.warn('SESSION', 'Failed to mirror quota cooldown into observer-health', {}, err as Error);
  }
}
