// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed observer pipeline health, so "observations are not flowing" is
 * never silent (the 2026-08-09 provider-quota outage ran 17 hours unnoticed).
 *
 * The worker records generator failures (SessionRoutes generator catch) and
 * successful stores (ResponseProcessor). Session-start context assembly
 * (ContextBuilder) reads the file and prepends a loud warning when the
 * observer is unhealthy. A file — not the in-memory dependency-health map —
 * because the state must survive worker restarts and be readable from any
 * process without the worker HTTP API (same pattern as the oauth-stale
 * marker in oauth-token.ts).
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { loadFromFileOnce } from './hook-settings.js';
import { logger } from '../utils/logger.js';

export interface ObserverHealthState {
  /** Failures since the last successful store. */
  consecutiveFailures: number;
  /** Epoch ms of the first failure in the current streak. */
  failingSinceAt: number | null;
  /** Epoch ms of the most recent failure. */
  lastErrorAt: number | null;
  /** Scrubbed + truncated message of the most recent failure. */
  lastErrorMessage: string | null;
  /** Provider whose generator failed most recently. */
  lastErrorProvider: string | null;
  /** Epoch ms of the most recent successful observation/summary store. */
  lastSuccessAt: number | null;
  /**
   * Structured detail from a classified provider error (the gateway's taxonomy
   * envelope `{ code, message, action, url, request_id }`), carried so the
   * session-start warning shows the same words as the worker's `Observer failed`
   * log line. All null for unclassified failures and for ledgers written by
   * older builds.
   */
  lastErrorCode?: string | null;
  /** Scrubbed remedy text ("It resets on …", "Add credits at …"). */
  lastErrorAction?: string | null;
  /** Link the remedy points at (stored as-is; URLs are not credentials). */
  lastErrorUrl?: string | null;
  /** Gateway/upstream request id for support. */
  lastErrorRequestId?: string | null;
  /**
   * Classified failure kind (`quota_exhausted`, `auth`, …). The warning reads
   * this to pick its remedy: a spent allowance is the one outage a restart
   * cannot clear, so it must not be offered one.
   */
  lastErrorKind?: string | null;
  /**
   * How many consecutive failures raise the banner for the CURRENT failure,
   * when its recorder decided the default (OBSERVER_UNHEALTHY_FAILURE_THRESHOLD)
   * cannot apply. Null means the default.
   *
   * The default assumes the observer keeps trying, so a real outage piles up
   * three failures quickly. That assumption breaks for a Codex setup or login
   * problem: the route gate stops every further attempt after the first one,
   * so the count would sit at 1 forever and the user would never be told
   * (plan 3.6 (b)). Only ever LOWERS the threshold.
   */
  lastErrorAlertThreshold?: number | null;
  /**
   * The worker has stopped attempting and is holding captured observations
   * until the user fixes something only they can fix (install the CLI, log in).
   * The banner then says exactly that and does NOT offer a restart: a restart
   * fixes nothing here and discards the held observations.
   */
  lastErrorAwaitingUserFix?: boolean | null;
  /**
   * What surfaced an awaiting-user-fix failure: `'check'` for one a model-free
   * check can see (a missing binary, a logged-out or API-key login, a failed
   * lockdown self-check), `'run'` for one only a real run can see (a lockdown
   * breach, a model the server rejects, a plan without Codex, a 401 while the
   * login still looks fine). A passing check may clear the former; only a run
   * that the model actually answers may clear the latter. Null when unknown.
   */
  lastErrorOrigin?: 'check' | 'run' | null;
  /**
   * The worker is holding the captured observations in memory and retrying on
   * its own — a transport pause (the model could not be reached), not an
   * outage a restart fixes. The banner says so and does NOT offer a restart,
   * which would discard exactly the observations being retried.
   */
  lastErrorHeldForRetry?: boolean | null;
  /** When a held-for-retry failure is next retried, epoch ms; null if unknown. */
  lastErrorRetryAt?: number | null;
  /**
   * Intentional pause while the provider quota breaker is withholding
   * generator starts. Distinct from lastError*: a cooldown is not a failure,
   * and must not flip the ledger to unhealthy. Null when no breaker is armed
   * (or after it was cleared on a successful store).
   */
  quotaCooldown: ObserverQuotaCooldown | null;
}

/**
 * Persisted half of the quota breaker, mirrored into the health ledger so a
 * cooldown is visible without tailing the worker log. `until` is authoritative:
 * a stale `active: true` after expiry must not keep the banner up.
 */
export interface ObserverQuotaCooldown {
  active: boolean;
  provider: string;
  /** Epoch ms when the breaker was armed. */
  armedAt: number;
  /** Epoch ms when the next probe is allowed. */
  until: number;
  /** Window the provider named, when it named one (e.g. 'weekly'). */
  window?: string;
  /** Provider-reported reason, already free of any user prompt text. */
  message?: string;
}

/**
 * Failure detail accepted by recordObserverFailure. A plain string is the
 * legacy/unclassified form; the object form carries the classified error's
 * structured fields.
 */
export interface ObserverFailureDetail {
  message: string;
  /** Classified error kind, when the failure came from the provider taxonomy. */
  kind?: string;
  code?: string;
  action?: string;
  url?: string;
  requestId?: string;
  /**
   * Raise the banner after this many consecutive failures instead of the
   * default. For failures after which the worker makes no further attempt on
   * its own (see `lastErrorAlertThreshold`), or whose streak the caller already
   * counted. Values outside 1..default are ignored.
   */
  alertThreshold?: number;
  /** See `ObserverHealthState.lastErrorAwaitingUserFix`. */
  awaitingUserFix?: boolean;
  /** See `ObserverHealthState.lastErrorOrigin`. */
  origin?: 'check' | 'run';
  /** See `ObserverHealthState.lastErrorHeldForRetry`. */
  heldForRetry?: boolean;
  /** See `ObserverHealthState.lastErrorRetryAt`. */
  retryAt?: number;
  /**
   * How many consecutive failures this one record stands for; default 1. For a
   * caller that deliberately holds back the first few of a streak (a transport
   * blip usually heals itself) and books them together once the streak proves
   * real — so the banner still reads "failed 3 times in a row", not "1 time".
   */
  occurrences?: number;
}

export const OBSERVER_HEALTH_FILENAME = 'observer-health.json';

/** Warn only after repeated failures — a single blip self-heals on retry. */
export const OBSERVER_UNHEALTHY_FAILURE_THRESHOLD = 3;

/**
 * Threshold for a failure the worker will not retry by itself — a Codex setup
 * or login problem the route gate now holds back (plan 3.6 (b)). One is
 * enough: there will be no second attempt to count.
 */
export const OBSERVER_GATED_FAILURE_ALERT_THRESHOLD = 1;

/**
 * The threshold that applies to the ledger's CURRENT failure: the recorder's
 * stated one when valid, else the default. Clamped so a hand-edited or garbled
 * ledger can only make the banner more eager, never silence it.
 */
export function observerAlertThreshold(state: ObserverHealthState): number {
  const stated = state.lastErrorAlertThreshold;
  if (typeof stated !== 'number' || !Number.isInteger(stated) || stated < 1) {
    return OBSERVER_UNHEALTHY_FAILURE_THRESHOLD;
  }
  return Math.min(stated, OBSERVER_UNHEALTHY_FAILURE_THRESHOLD);
}

const MAX_ERROR_MESSAGE_LENGTH = 600;

const EMPTY_STATE: ObserverHealthState = {
  consecutiveFailures: 0,
  failingSinceAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastErrorProvider: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  lastErrorAction: null,
  lastErrorUrl: null,
  lastErrorRequestId: null,
  quotaCooldown: null,
};

function defaultHealthFilePath(): string {
  return join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
}

/**
 * Names that carry a secret when they appear as `name=value`, `name: value`,
 * or `"name": "value"` — the shapes provider errors echo back from request
 * bodies, query strings, and header dumps.
 */
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(["']?\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd|authorization|auth|token|key)\b["']?\s*[=:]\s*)(["']?)([^\s"'&,;}\]]+)\2/gi;

/**
 * Keep the message useful (provider errors often embed the remedy, e.g. an
 * OpenRouter manage-key URL) while dropping anything credential-shaped.
 *
 * Applied before persistence AND again at render time, so a ledger written by
 * an older build cannot inject a secret into session-start context.
 */
export function scrubErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\bcm_pro_[A-Za-z0-9_-]{8,}/g, 'cm_pro_…')
    .replace(/\b(Bearer|Basic|Digest|Token)\s+[^\s"']+/gi, '$1 …')
    // Numbers are limits/counts, not credentials — `max_tokens: 200000` and
    // `key limit exceeded` style diagnostics survive intact.
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, (match, prefix: string, quote: string, value: string) =>
      /^\d+$/.test(value) ? match : `${prefix}${quote}…${quote}`)
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function readObserverHealth(filePath: string = defaultHealthFilePath()): ObserverHealthState | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { ...EMPTY_STATE, ...(parsed as Partial<ObserverHealthState>) };
  } catch (error) {
    logger.warn('SESSION', 'Failed to read observer-health file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

function writeObserverHealth(state: ObserverHealthState, filePath: string): void {
  try {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.warn('SESSION', 'Failed to write observer-health file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/** A holder that has not released within this window is presumed dead. */
const LEDGER_LOCK_STALE_MS = 5_000;
/** Give up waiting and update unlocked rather than lose the failure entirely. */
const LEDGER_LOCK_MAX_WAIT_MS = 2_000;
const LEDGER_LOCK_RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize the ledger's read-modify-write across processes. Every worker and
 * hook process shares one file, and lost increments would hold
 * consecutiveFailures below the threshold — suppressing the very warning this
 * module exists to raise.
 *
 * `wx` (O_CREAT|O_EXCL) makes the create itself the atomicity, matching
 * worker-spawn-gate.ts. The lock fails OPEN (unlocked update) when the
 * filesystem refuses it or the wait times out: a racy count beats no count.
 */
function withLedgerLock<T>(filePath: string, mutate: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LEDGER_LOCK_MAX_WAIT_MS;
  let held = false;

  while (!held && Date.now() < deadline) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      held = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        logger.warn('SESSION', 'Observer-health lock unavailable; updating unlocked', { lockPath, code },
          error instanceof Error ? error : new Error(String(error)));
        break;
      }
      let mtimeMs: number;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        // Holder released between our failed create and the stat — retry.
        continue;
      }
      if (Date.now() - mtimeMs > LEDGER_LOCK_STALE_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // A competing breaker won, or the fs refused the delete; the retry
          // loop re-evaluates either way.
        }
        continue;
      }
      sleepSync(LEDGER_LOCK_RETRY_MS);
    }
  }

  if (!held && Date.now() >= deadline) {
    logger.warn('SESSION', 'Timed out waiting for the observer-health lock; updating unlocked', { lockPath });
  }

  try {
    return mutate();
  } finally {
    if (held) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already broken as stale by a waiter — nothing to release.
      }
    }
  }
}

export function recordObserverFailure(
  provider: string,
  error: string | ObserverFailureDetail,
  filePath: string = defaultHealthFilePath(),
): void {
  const detail: ObserverFailureDetail = typeof error === 'string' ? { message: error } : error;
  const occurrences = typeof detail.occurrences === 'number' && Number.isInteger(detail.occurrences) && detail.occurrences >= 1
    ? detail.occurrences
    : 1;
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
    const now = Date.now();
    writeObserverHealth({
      ...prior,
      consecutiveFailures: prior.consecutiveFailures + occurrences,
      failingSinceAt: prior.consecutiveFailures > 0 ? prior.failingSinceAt : now,
      lastErrorAt: now,
      lastErrorMessage: scrubErrorMessage(detail.message),
      lastErrorProvider: provider,
      // Always overwrite (never inherit from `prior`): a string-form failure
      // after a classified one must not keep the stale action/link/request id.
      lastErrorCode: detail.code ?? null,
      lastErrorKind: detail.kind ?? null,
      lastErrorAction: detail.action ? scrubErrorMessage(detail.action) : null,
      lastErrorUrl: detail.url ?? null,
      lastErrorRequestId: detail.requestId ?? null,
      // Same always-overwrite rule: a Codex login failure's "alert at 1" must
      // not carry over to the next, unrelated failure.
      lastErrorAlertThreshold: detail.alertThreshold ?? null,
      lastErrorAwaitingUserFix: detail.awaitingUserFix ?? null,
      lastErrorOrigin: detail.origin ?? null,
      lastErrorHeldForRetry: detail.heldForRetry ?? null,
      lastErrorRetryAt: typeof detail.retryAt === 'number' && Number.isFinite(detail.retryAt) ? detail.retryAt : null,
    }, filePath);
  });
}

/**
 * A problem only the user could fix has been fixed: drop the fix-it banner
 * without pretending a store happened.
 *
 * Needed because the awaiting-user-fix record (a Codex setup or login problem,
 * alert threshold 1) otherwise stays until the next successful store. A user
 * who ran `codex login` while nothing was pending would keep being told to run
 * it at every session start, and so would every session after a worker
 * restart, since this file outlives the process while the gate's state does
 * not.
 *
 * Only ever touches the ledger when its CURRENT failure is `provider`'s
 * awaiting-user-fix record — a later, unrelated failure is left alone — and,
 * when `confirmedBy` is `'check'`, only one a model-free check can disprove:
 * a record a real run surfaced (`lastErrorOrigin: 'run'`) needs a run to
 * clear it. Returns whether it cleared anything.
 */
export function recordObserverRecovered(
  provider: string,
  confirmedBy: 'check' | 'run',
  filePath: string = defaultHealthFilePath(),
): boolean {
  return withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath);
    if (!prior) return false;
    if (prior.lastErrorAwaitingUserFix !== true || prior.lastErrorProvider !== provider) return false;
    if (prior.consecutiveFailures <= 0) return false;
    if (confirmedBy === 'check' && prior.lastErrorOrigin === 'run') return false;
    writeObserverHealth({
      ...prior,
      consecutiveFailures: 0,
      failingSinceAt: null,
      lastErrorAwaitingUserFix: null,
      lastErrorAlertThreshold: null,
    }, filePath);
    return true;
  });
}

export function recordObserverSuccess(filePath: string = defaultHealthFilePath()): void {
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
    writeObserverHealth({
      ...prior,
      consecutiveFailures: 0,
      failingSinceAt: null,
      lastSuccessAt: Date.now(),
    }, filePath);
  });
}

/**
 * Mirror an armed quota breaker into the health ledger. Does not increment
 * consecutiveFailures — a cooldown is an intentional pause, not a failure.
 */
export function recordObserverQuotaCooldown(
  cooldown: ObserverQuotaCooldown,
  filePath: string = defaultHealthFilePath(),
): void {
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
    writeObserverHealth({
      ...prior,
      quotaCooldown: {
        active: true,
        provider: cooldown.provider,
        armedAt: cooldown.armedAt,
        until: cooldown.until,
        ...(cooldown.window ? { window: cooldown.window } : {}),
        ...(cooldown.message ? { message: scrubErrorMessage(cooldown.message) } : {}),
      },
    }, filePath);
  });
}

/** Clear the cooldown field after the breaker is released. */
export function clearObserverQuotaCooldown(
  filePath: string = defaultHealthFilePath(),
): void {
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath);
    if (!prior || prior.quotaCooldown === null) return;
    writeObserverHealth({ ...prior, quotaCooldown: null }, filePath);
  });
}

export function isObserverUnhealthy(state: ObserverHealthState | null): state is ObserverHealthState {
  return state !== null
    && state.consecutiveFailures >= observerAlertThreshold(state)
    && (state.lastErrorAt ?? 0) > (state.lastSuccessAt ?? 0);
}

/** "3 minutes" / "about 2 hours" / "about 3 days" for outage durations. */
export function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * Where the one-click restart lives. Read through hook-settings rather than
 * worker-utils' getWorkerPort: this module is imported by hooks as well as the
 * worker, and must not drag in the supervisor, telemetry and process-management
 * tree just to format a URL.
 */
export function workerRestartUrl(): string {
  return `http://localhost:${loadFromFileOnce().CLAUDE_MEM_WORKER_PORT}/restart`;
}

/**
 * The block prepended to session-start context when unhealthy. Read by both
 * the user and the agent, so it stays calm and plain-spoken — but the agent
 * must still relay the outage (and the remedy embedded in the provider's
 * error message) to the user immediately.
 *
 * A restart clears nearly every observer outage (a wedged or SIGKILL'd provider
 * subprocess), so the remedy leads with one — as a link the user clicks, not as
 * something claude-mem fires on its own. Restarting the worker from inside the
 * worker means guarding the automation against itself (once per outage? per
 * flap? what about two failures racing?), and every one of those guards is a
 * bound on a loop that only exists because the restart was automatic. A human
 * pressing the button is the bound.
 */
/**
 * True when the current outage is a spent provider allowance. Reads the
 * classified `kind` recorded with the failure; the quota-as-prose path records
 * the same kind so both outage shapes are covered.
 */
export function isQuotaFailure(state: ObserverHealthState): boolean {
  return state.lastErrorKind === 'quota_exhausted';
}

/**
 * True while the persisted cooldown window is still in the future. `until`
 * wins over the stored `active` flag so an expired ledger cannot latch the
 * banner (the #3902 failure mode, inverted).
 */
export function isObserverQuotaCooldownActive(
  state: ObserverHealthState | null,
  nowMs: number = Date.now(),
): state is ObserverHealthState {
  const cooldown = state?.quotaCooldown;
  return cooldown != null
    && typeof cooldown.until === 'number'
    && cooldown.until > nowMs;
}

/** "2026-09-23T16:35:00.000Z (about 4 hours from now)" for a resume instant. */
function describeResumeAt(untilMs: number, nowMs: number): string {
  return `${new Date(untilMs).toISOString()} (${describeDuration(Math.max(0, untilMs - nowMs))} from now)`;
}

/**
 * The providers the observer resume scheduler serves: their paused sessions
 * are started again when the pause ends, with no new tool call needed.
 *
 * Codex only, deliberately (plan 3.5 / section 10, question 8 — "all providers
 * or only codex?" — is still the user's to answer). The quota banners may only
 * promise "resumes on its own" for a provider where that is true; every other
 * provider keeps its pre-M3 wording, because nothing restarts its paused
 * sessions until the next captured tool call. Widening the scheduler to more
 * providers means adding them here in the same change.
 */
const SCHEDULED_RESUME_PROVIDERS: ReadonlySet<string> = new Set(['codex']);

/** True when `provider`'s paused sessions resume on a timer (see SCHEDULED_RESUME_PROVIDERS). */
export function isScheduledResumeProvider(provider: string | null | undefined): boolean {
  return typeof provider === 'string' && SCHEDULED_RESUME_PROVIDERS.has(provider);
}

/**
 * Session-start notice for an intentional quota pause. Distinct from the
 * failure warning: nothing is broken, the generator is withheld on purpose,
 * and queued work drains when the window clears.
 *
 * For a provider the resume scheduler serves (Codex) that drain is literal
 * since M3: the scheduler probes one waiting session when `until` arrives and
 * starts every waiting session once the breaker clears, with no new tool call
 * needed, and `until` is Codex's own stated resume time when it gave one ("Try
 * again at 4:35 PM"). What is still NOT true is durability: the queue lives in
 * the worker's memory, so the notice says plainly that a restart loses it.
 *
 * Every other provider gets the pre-M3 wording, unchanged: their cooldown is
 * mostly armed by a proactive guard (Claude pauses at 92-95% utilization, when
 * the allowance is not actually used up), and they are not resumed on a timer.
 */
export function renderObserverQuotaCooldownNotice(
  state: ObserverHealthState,
  nowMs: number = Date.now(),
): string {
  const cooldown = state.quotaCooldown;
  const provider = cooldown?.provider ?? 'unknown provider';
  const until = cooldown?.until;
  const untilText = until ? describeResumeAt(until, nowMs) : 'the next probe window';
  const windowText = cooldown?.window ? ` (${cooldown.window})` : '';
  const message = cooldown?.message ? scrubErrorMessage(cooldown.message) : null;
  const assistantLines = [
    '(Assistant: tell the user that memory capture is paused for a quota cooldown',
    'at the very start of your first reply. Do NOT restart the worker and do NOT',
    'suggest restarting it.)',
  ];

  if (!isScheduledResumeProvider(cooldown?.provider)) {
    return [
      '⚠️ Heads up: claude-mem is paused while a provider quota cooldown is active.',
      '',
      `The memory observer is waiting out a quota cooldown on ${provider}${windowText} until ${untilText}.`,
      '',
      ...(message ? [`Latest signal: ${message}`, ''] : []),
      'This is not a failure. Incoming observations stay queued and will be written',
      'when the cooldown clears — the worker is intentionally not starting the',
      'generator so it does not keep spending a spent allowance.',
      '',
      'Restarting will NOT help here, and it clears the backoff that is currently keeping',
      'claude-mem from hammering the provider — so please leave the worker alone.',
      '',
      ...assistantLines,
    ].join('\n');
  }

  // A rate limit / capacity refusal arms the same breaker, but "allowance used
  // up" would send the user to check a plan that is not the problem.
  const pauseText = cooldown?.window === 'rate_limit'
    ? `The memory observer is rate-limited on ${provider} and is waiting out a quota cooldown${windowText}`
    : `The memory observer's allowance on ${provider} is used up; it is waiting out a quota cooldown${windowText}`;

  return [
    '⚠️ Heads up: claude-mem is paused while a provider quota cooldown is active.',
    '',
    `${pauseText} until ${untilText}.`,
    '',
    ...(message ? [`Latest signal: ${message}`, ''] : []),
    "This is not a failure. Incoming observations stay queued in the worker's memory, and",
    'the worker resumes on its own when the cooldown clears and writes them then — it is',
    'intentionally not starting the generator so it does not keep spending a spent allowance.',
    '',
    'Restarting will NOT help here: it clears the backoff that is currently keeping claude-mem',
    "from hammering the provider, and it discards the queued observations, which live only in",
    "the worker's memory — so please leave the worker alone.",
    '',
    ...assistantLines,
  ].join('\n');
}

/**
 * The banner for a failure the user has to fix and the worker will not retry
 * blindly (a Codex CLI that is not installed, a logged-out or API-key login, a
 * failed lockdown self-check). Its own shape because the generic warning's
 * remedy is wrong for it on both counts: it leads with a restart, which fixes
 * none of these and throws away the observations the gate is holding, and it
 * talks about repeated failures when the gate deliberately stopped after one.
 */
function renderAwaitingUserFixWarning(state: ObserverHealthState, nowMs: number): string {
  const since = state.failingSinceAt ?? state.lastErrorAt;
  const sinceText = since
    ? `for ${describeDuration(nowMs - since)} (since ${new Date(since).toISOString()})`
    : 'for an unknown amount of time';
  const provider = state.lastErrorProvider ?? 'unknown provider';
  const action = state.lastErrorAction ? scrubErrorMessage(state.lastErrorAction) : null;

  return [
    "⚠️ Heads up: claude-mem can't save memories right now.",
    '',
    `The memory observer (provider: ${provider}) has been waiting on a setup problem ${sinceText}.`,
    '',
    `Latest error: ${state.lastErrorMessage ? scrubErrorMessage(state.lastErrorMessage) : 'unknown'}`,
    ...(action ? [`What to do: ${action}`] : []),
    ...(state.lastErrorUrl ? [`Link: ${state.lastErrorUrl}`] : []),
    ...(state.lastErrorRequestId ? [`Request id: ${state.lastErrorRequestId}`] : []),
    '',
    "Observations captured meanwhile are held in the worker's memory. Once this is fixed the",
    'worker picks it up on its own (at its next re-check, or the next captured tool call)',
    'and writes them — no restart needed. Restarting would not fix this, and it',
    'discards the held observations.',
    '',
    '(Assistant: tell the user about this at the very start of your first reply, quoting the',
    'error and what to do above. Do NOT restart the worker and do NOT suggest restarting it.)',
  ].join('\n');
}

/**
 * The banner for a transport pause the worker is retrying on its own: the
 * observer could not reach its model (a network drop, an upstream outage, a
 * timeout), and the captured observations are held in memory for the retry.
 *
 * Its own shape because the generic warning is wrong for it twice over. It
 * says nothing will be remembered, when the held work is written as soon as a
 * retry gets through; and it leads with a restart, which cannot fix an
 * upstream or network outage and discards exactly the observations being
 * retried.
 */
function renderHeldForRetryWarning(state: ObserverHealthState, nowMs: number): string {
  const since = state.failingSinceAt ?? state.lastErrorAt;
  const sinceText = since
    ? `for ${describeDuration(nowMs - since)} (since ${new Date(since).toISOString()})`
    : 'for an unknown amount of time';
  const provider = state.lastErrorProvider ?? 'unknown provider';
  const count = state.consecutiveFailures;
  const action = state.lastErrorAction ? scrubErrorMessage(state.lastErrorAction) : null;
  const retryAt = typeof state.lastErrorRetryAt === 'number' && state.lastErrorRetryAt > nowMs
    ? state.lastErrorRetryAt
    : null;

  return [
    "⚠️ Heads up: claude-mem can't save memories right now.",
    '',
    `The memory observer (provider: ${provider}) cannot reach its model: it has failed ${count} time${count === 1 ? '' : 's'} in a row ${sinceText}.`,
    '',
    `Latest error: ${state.lastErrorMessage ? scrubErrorMessage(state.lastErrorMessage) : 'unknown'}`,
    ...(action ? [`What to do: ${action}`] : []),
    ...(state.lastErrorUrl ? [`Link: ${state.lastErrorUrl}`] : []),
    ...(state.lastErrorRequestId ? [`Request id: ${state.lastErrorRequestId}`] : []),
    '',
    "Observations captured meanwhile are held in the worker's memory, and the worker retries",
    retryAt !== null
      ? `on its own — next attempt at ${describeResumeAt(retryAt, nowMs)} — and writes them once it`
      : 'on its own and writes them once it',
    'gets through. Restarting would not fix a network or provider outage, and it discards the',
    'held observations — so please leave the worker alone.',
    '',
    '(Assistant: tell the user about this at the very start of your first reply, quoting the',
    'error above. Do NOT restart the worker and do NOT suggest restarting it.)',
  ].join('\n');
}

export function renderObserverHealthWarning(state: ObserverHealthState, nowMs: number = Date.now()): string {
  if (state.lastErrorAwaitingUserFix === true) {
    return renderAwaitingUserFixWarning(state, nowMs);
  }
  if (state.lastErrorHeldForRetry === true) {
    return renderHeldForRetryWarning(state, nowMs);
  }

  const since = state.failingSinceAt ?? state.lastErrorAt;
  const sinceText = since
    ? `for ${describeDuration(nowMs - since)} (since ${new Date(since).toISOString()})`
    : 'for an unknown amount of time';
  const provider = state.lastErrorProvider ?? 'unknown provider';
  const count = state.consecutiveFailures;
  const action = state.lastErrorAction ? scrubErrorMessage(state.lastErrorAction) : null;

  // A spent allowance is the one outage a restart cannot clear. Worse, the
  // restart link is the code path that clears the quota breaker (the process
  // serving /api/admin/restart is the process holding the cooldown), so
  // offering it here talks the user into re-opening the per-observation
  // request storm the breaker exists to stop. Nothing is wedged; the account
  // is out of allowance. Say that, and relay the provider's own remedy.
  if (isQuotaFailure(state)) {
    // When the breaker is still armed, `until` is when the worker re-probes on
    // its own — the provider's stated resume time for Codex — so the user is
    // told when to expect memory back rather than only that it is gone. Only
    // for a provider the resume scheduler serves: for the others nothing
    // re-probes without a new tool call, so the pre-M3 wording stays.
    const resumeUntil = isScheduledResumeProvider(provider)
      && isObserverQuotaCooldownActive(state, nowMs)
      && state.quotaCooldown?.provider === provider
      ? state.quotaCooldown.until
      : null;
    return [
      "⚠️ Heads up: claude-mem can't save memories right now.",
      '',
      `The memory observer's allowance on ${provider} is used up (since ${sinceText.replace(/^for .*?\(since /, '').replace(/\)$/, '')}).`,
      '',
      `Latest error: ${state.lastErrorMessage ? scrubErrorMessage(state.lastErrorMessage) : 'unknown'}`,
      ...(action ? [`What to do: ${action}`] : []),
      ...(state.lastErrorUrl ? [`Link: ${state.lastErrorUrl}`] : []),
      ...(state.lastErrorRequestId ? [`Request id: ${state.lastErrorRequestId}`] : []),
      '',
      ...(resumeUntil !== null
        ? [
          `The worker tries again on its own at ${describeResumeAt(resumeUntil, nowMs)}.`,
          "Observations captured until then stay queued in the worker's memory and are written",
          'once the allowance is back; a worker restart discards them.',
        ]
        : [
          "Until the allowance resets or you add capacity, nothing from this session — or any",
          'other — will be remembered.',
        ]),
      '',
      // Deliberately no restart link: nothing is broken to restart, and doing
      // it disarms the breaker that is currently protecting the account.
      'Restarting will NOT help here, and it clears the backoff that is currently keeping',
      'claude-mem from hammering the provider — so please leave the worker alone.',
      ...(action ? [] : [
        'Switch the observer to another provider in ~/.claude-mem/settings.json if you need',
        'memory capture before the allowance resets.',
      ]),
      '',
      '(Assistant: tell the user about this outage at the very start of your first reply,',
      'quoting the error above. Do NOT restart the worker and do NOT suggest restarting it.)',
    ].join('\n');
  }

  const lines = [
    "⚠️ Heads up: claude-mem can't save memories right now.",
    '',
    `The memory observer (provider: ${provider}) has failed ${count} time${count === 1 ? '' : 's'} in a row ${sinceText}.`,
    '',
    `Latest error: ${state.lastErrorMessage ? scrubErrorMessage(state.lastErrorMessage) : 'unknown'}`,
    ...(action ? [`What to do: ${action}`] : []),
    ...(state.lastErrorUrl ? [`Link: ${state.lastErrorUrl}`] : []),
    ...(state.lastErrorRequestId ? [`Request id: ${state.lastErrorRequestId}`] : []),
    '',
    "Until it's fixed, nothing from this session — or any other — will be remembered.",
    '',
    'Restarting the memory worker clears almost every outage. Do one of these:',
    `  Click to restart:  ${workerRestartUrl()}`,
    '  Or in a terminal:  npx claude-mem restart',
    '',
    'Still failing after the restart? Run: npx claude-mem doctor',
    // A classified error already says what to do; the generic settings.json
    // remedy is wrong for e.g. Pro users whose allowance ran out.
    ...(action ? [] : [
      "If doctor comes back clean, check the observer provider's API key, spend limit, and base",
      'URL in ~/.claude-mem/settings.json. The error above may include a management link.',
    ]),
    '',
    '(Assistant: tell the user about this outage at the very start of your first reply,',
    'quoting the error above, and give them the restart link — let them press it rather',
    'than restarting the worker yourself.)',
  ];
  return lines.join('\n');
}
