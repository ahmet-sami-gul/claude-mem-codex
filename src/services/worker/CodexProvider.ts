/**
 * The Codex CLI observation provider (plan 3.3 / M2).
 *
 * Runs the memory observer on the user's own Codex CLI and ChatGPT plan
 * instead of a metered HTTP endpoint. It reuses the shared session lifecycle
 * in OpenAICompatibleProvider through the opt-in hooks, and differs from the
 * two HTTP providers in exactly the places a local, per-call-metered CLI has
 * to differ:
 *
 *   - readiness is a resolved binary plus a PASSED lockdown self-check, not an
 *     API key (`isConfigured`), and a missing or unfinished check is
 *     `setup_required` — never a silent fall back to another provider;
 *   - every model call is a subprocess, so the per-field compression pass is
 *     off by default (`fieldCompressor` -> null) and the conversation budget is
 *     its own, smaller one (`conversationMaxChars`);
 *   - the summary model comes from CLAUDE_MEM_CODEX_SUMMARY_MODEL only. The
 *     shared `$TIER:` aliases and CLAUDE_MEM_MODEL name Anthropic models and
 *     must never reach a `-m` argument here, and `session.modelOverride` (which
 *     tier routing sets to 'haiku') is likewise never read;
 *   - a persisted memory_session_id is ADOPTED rather than re-keyed
 *     (`adoptForeignMemorySessionId`), so switching a live session onto Codex
 *     cannot cascade a re-key storm through the observation rows.
 *
 * The M4 cost levers, each of which cuts plan messages AND tokens whatever the
 * plan meters:
 *
 *   - `deferInitQuery`: no standalone init exec; the init turn is the stable
 *     head of the first real call (one exec saved per generator start);
 *   - `freshGenerationOnStart`: a restarted generator does not re-send the
 *     turns a paused run left behind (continuity comes from the session-start
 *     context the init turn carries);
 *   - batching (`observationBatchPolicy`, CLAUDE_MEM_CODEX_BATCH_*): queued
 *     observations of one prompt/agent/cwd share one exec, even when other
 *     subagents' events interleave with them;
 *   - the local 5-hour exec budget (codex-budget.ts,
 *     CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H), composed onto the pre-flight seam
 *     AFTER the M3 quota circuit, so a spent budget pauses and resumes through
 *     the same breaker and scheduler as a real usage limit;
 *   - counters for all of the above (codex-metrics.ts), on /api/health.
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError, isClassified } from './provider-errors.js';
import {
  OpenAICompatibleProvider,
  type ObservationBatchPolicy,
  type ProviderConfigBase,
  type ProviderQueryContext,
  type ProviderQueryResult,
} from './OpenAICompatibleProvider.js';
import type { WorkerRef } from './agents/index.js';
import { countFieldsNeedingCompression, type FieldCompressor } from './field-optimizer.js';
import { buildObservationBatchPrompt, type Observation } from '../../sdk/prompts.js';
import {
  CODEX_LOCAL_BUDGET_CODE,
  getCodexExecBudget,
  type CodexBudgetSnapshot,
  type CodexExecBudget,
  type CodexExecTicket,
} from './codex/codex-budget.js';
import { codexMetrics, type CodexMetrics, type CodexMetricsSnapshot } from './codex/codex-metrics.js';
import { findCodexExecutable } from '../../shared/find-codex-executable.js';
import {
  checkQuotaHold,
  clearQuotaCooldown,
  getQuotaCooldown,
  quotaCooldownResumeAtMs,
  touchQuotaProbe,
} from '../../shared/quota-cooldown.js';
import {
  codexViolationTracker,
  ExecTransport,
  settleCodexTurn,
  type CodexViolationTracker,
} from './codex/codex-exec-runner.js';
import type {
  CodexCallPurpose,
  CodexReasoningEffort,
  CodexTransport,
  CodexTransportKind,
  CodexTurnContext,
  CodexVerbosity,
  TurnResult,
} from './codex/codex-transport.js';
import { renderCodexPromptFromConversation } from './codex/codex-prompt.js';
import type { CodexReadinessSnapshot, CodexReadinessSource } from './session/codex-readiness-gate.js';
import {
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_DEFAULT_VERBOSITY,
  isCodexReasoningEffort,
  isCodexVerbosity,
  isValidCodexModelId,
} from './codex/codex-invocation.js';
import {
  getCodexAuthMethodDescription,
  getCodexLockdownFingerprint,
  getCodexLockdownStatus,
  verifyCodexLockdown,
  type CodexLockdownResult,
  type VerifyCodexLockdownOptions,
} from './codex/codex-self-check.js';

/** Bounds from plan section 4; every one of them is also enforced here. */
export const CODEX_CONFIG_BOUNDS = Object.freeze({
  timeoutMs: { min: 30_000, max: 600_000, fallback: 180_000 },
  maxConversationChars: { min: 40_000, max: 400_000, fallback: 120_000 },
  batchMaxObservations: { min: 1, max: 12, fallback: 4 },
  batchMaxChars: { min: 8_000, max: 96_000, fallback: 48_000 },
  batchLingerMs: { min: 0, max: 30_000, fallback: 2_000 },
  maxExecsPer5h: { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
  // 0 turns the cap off; any other value is at least `minCap`, so a value
  // like "5" cannot discard nearly everything that is captured.
  maxQueuedObservations: { min: 0, minCap: 50, max: 100_000, fallback: 500 },
  quotaReservePercent: { min: 0, max: 50, fallback: 0 },
  rateLimitProbeMs: { min: 60_000, max: 3_600_000, fallback: 300_000 },
});

/**
 * Head-room added on top of the first turn when sizing this provider's
 * conversation budget, so a fresh generation cannot be recycled twice in a row
 * and fall into the ten-minute overflow pause (plan 3.3, hook 6).
 */
export const CODEX_CONVERSATION_HEADROOM_CHARS = 16_000;

export interface CodexConfig extends ProviderConfigBase {
  /** Observer model; validated against MODEL_ID_RE, defaulted on anything else. */
  model: string;
  /** CLAUDE_MEM_CODEX_SUMMARY_MODEL, or '' meaning "same as model". */
  summaryModel: string;
  effort: CodexReasoningEffort;
  verbosity: CodexVerbosity;
  timeoutMs: number;
  maxConversationChars: number;
  batchMaxObservations: number;
  batchMaxChars: number;
  batchLingerMs: number;
  fieldCompression: boolean;
  transportKind: CodexTransportKind;
  maxExecsPer5h: number;
  quotaReservePercent: number;
  rateLimitProbeMs: number;
  allowUntestedVersion: boolean;
  /** CLAUDE_MEM_CODEX_HOME as configured (file/env only); '' means the default. */
  codexHome: string;
  /** Absolute native binary, or null when it could not be resolved. */
  binaryPath: string | null;
  /** Why resolution failed, for the setup_required message. */
  binaryError: string | null;
}

/** What a pre-flight check is told about the call it may refuse. */
export interface CodexPreflightContext {
  sessionDbId: number;
  purpose: CodexCallPurpose;
  session?: ActiveSession;
}

/**
 * The seam the quota circuit (M3) and the local 5-hour exec budget (M4) plug
 * into: a check that runs BEFORE anything is rendered or spawned and throws a
 * ClassifiedProviderError (quota_exhausted with a retryAfterMs / resumeAtMs) to
 * refuse the call without paying for it.
 *
 * The provider runs `composeCodexPreflights(circuit, budget)`: the M3 quota
 * circuit (`codexQuotaCircuitPreflight`, or the injected `preflight` option)
 * first, then the M4 local 5-hour exec budget (`codexLocalBudgetPreflight`).
 *
 * It runs TWICE per call: once before the prompt is rendered — i.e. before the
 * transport waits for a pool slot — and again after the slot is granted,
 * immediately before the spawn (`CodexTurnContext.beforeSpawn`). So it must be
 * a check, not a reservation: anything it counts has to be counted where the
 * exec actually happens (`CodexTurnContext.onSpawned`), or every call would be
 * counted twice. Kept synchronous where it can be, so the second run, the
 * spawn and the count happen in one synchronous block.
 */
export type CodexPreflightCheck = (config: CodexConfig, ctx: CodexPreflightContext) => void | Promise<void>;

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return typeof (value as PromiseLike<void> | null | undefined)?.then === 'function';
}

/**
 * Run pre-flight checks in order; the first refusal wins and the later ones
 * are not consulted. Synchronous as long as every check is (the runner then
 * checks and spawns without yielding); an async check makes the rest wait for
 * it.
 */
export function composeCodexPreflights(...checks: CodexPreflightCheck[]): CodexPreflightCheck {
  return (config, ctx) => {
    for (let index = 0; index < checks.length; index += 1) {
      const outcome = checks[index](config, ctx);
      if (isPromiseLike(outcome)) {
        const rest = checks.slice(index + 1);
        return Promise.resolve(outcome).then(async () => {
          for (const check of rest) await check(config, ctx);
        });
      }
    }
    return undefined;
  };
}

/**
 * The local 5-hour exec budget as a pre-flight check (M4, plan 3.3): refuses
 * with quota_exhausted / `local_budget` / an exact `retryAfterMs` once
 * CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H execs are counted in the window (0 =
 * unlimited). Read-only; the exec is counted by the provider at spawn time.
 *
 * `limitOf` says what the limit is AT CHECK TIME. The provider passes a
 * resolver that re-reads the setting on every check, because the config a
 * generator was started with lives as long as the generator does (hours, on a
 * busy session) — a lowered or newly enabled limit has to bind the running
 * generators at once, not their successors. Synchronous, so the pre-spawn
 * check, the spawn and the count stay one synchronous block. Defaults to the
 * config's own value.
 *
 * The refusal is deliberately NOT one of CODEX_QUOTA_CIRCUIT_CODES: the route
 * books it like a real usage limit — breaker armed until the window slides,
 * banner, scheduled probe — which is how a spent budget resumes on its own
 * without dropping the buffered observations.
 */
export function codexLocalBudgetPreflight(
  budget: CodexExecBudget,
  metrics?: CodexMetrics,
  limitOf: (config: CodexConfig) => number = config => config.maxExecsPer5h,
): CodexPreflightCheck {
  return (config) => {
    try {
      budget.assertWithinBudget(limitOf(config));
    } catch (error: unknown) {
      metrics?.recordBudgetRefusal();
      throw error;
    }
  };
}

/**
 * CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H as it stands in settings right now, with
 * the same bounds and warn-once fallback as getConfig. Cheap (a settings read,
 * no binary resolution) and never throws, so the budget can be re-read at
 * every check rather than frozen per generator.
 */
export function resolveCodexMaxExecsPer5h(): number {
  return clampedInt(
    'CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H',
    SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H,
    CODEX_CONFIG_BOUNDS.maxExecsPer5h,
  );
}

/**
 * The per-session cap on waiting observations as it applies right now
 * (CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS, file/env only), or 0 — no cap —
 * while codex is not the provider (the same rule as isCodexSelected) or the
 * setting is 0. Same bounds and warn-once handling as the other codex numbers,
 * plus one rule of its own: a value from 1 to 49 is raised to 50. Never
 * throws; SessionManager asks it (through codexObservationQueueCapReader)
 * after every enqueued observation.
 */
export function resolveCodexObservationQueueCap(): number {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  if (settings.CLAUDE_MEM_PROVIDER !== 'codex') return 0;
  const bounds = CODEX_CONFIG_BOUNDS.maxQueuedObservations;
  const cap = clampedInt('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS', settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS, bounds);
  if (cap > 0 && cap < bounds.minCap) {
    warnOnce('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS', String(cap), bounds.minCap);
    return bounds.minCap;
  }
  return cap;
}

/** How long codexObservationQueueCapReader reuses one settings read. */
export const CODEX_QUEUE_CAP_CACHE_MS = 5_000;

/**
 * resolveCodexObservationQueueCap behind a short cache, for the enqueue path:
 * a burst of captured tool calls reads settings.json at most once per
 * `ttlMs`, and a changed setting or provider still binds within seconds.
 */
export function codexObservationQueueCapReader(
  ttlMs: number = CODEX_QUEUE_CAP_CACHE_MS,
  resolve: () => number = resolveCodexObservationQueueCap,
  now: () => number = Date.now,
): () => number {
  let cached: { cap: number; atMs: number } | null = null;
  return () => {
    const nowMs = now();
    if (cached === null || nowMs - cached.atMs >= ttlMs) {
      cached = { cap: resolve(), atMs: nowMs };
    }
    return cached.cap;
  };
}

/**
 * Classified failures that will fail the SAME way for every further call in
 * this turn: once a compression call earns one, the remaining fields of the
 * turn go straight to the prompt's truncation instead of spawning (and paying
 * for) the same refusal again.
 */
const STICKY_COMPRESSION_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'quota_exhausted',
  'rate_limit',
  'auth_invalid',
  'setup_required',
]);

/**
 * The codes the quota circuit stamps on its OWN refusals, as opposed to a
 * refusal Codex itself returned.
 *
 * The route has to tell the two apart. Both are `quota_exhausted`, both abort
 * the generator through the shared policy, and both land in the route's quota
 * branch — but only a real refusal is news. Re-arming the breaker from a
 * circuit refusal would restamp `armedAtMs` (and, for a refusal that stated no
 * time, push the fixed window out by another 30 minutes) every time a running
 * generator bumped into the hold, so on a busy machine the single probe would
 * never be allowed out. It would also book a fresh observer failure for a pause
 * the ledger already shows.
 */
export const CODEX_QUOTA_CIRCUIT_CODES = Object.freeze({
  cooldown: 'codex_quota_cooldown',
  probeInFlight: 'codex_quota_probe_in_flight',
} as const);

/** True for a refusal the circuit raised itself (see CODEX_QUOTA_CIRCUIT_CODES). */
export function isCodexQuotaCircuitRefusal(error: unknown): boolean {
  return isClassified(error)
    && (error.code === CODEX_QUOTA_CIRCUIT_CODES.cooldown || error.code === CODEX_QUOTA_CIRCUIT_CODES.probeInFlight);
}

/**
 * Refuse a Codex call the quota breaker is withholding, before an exec exists
 * to pay for (plan 3.5, "çalışan generator'larda kota kontrolü").
 *
 * The route's `tryAdmitQuotaProbe` only runs when a generator STARTS. A Plus
 * allowance runs out mid-session, and every generator already running at that
 * moment carries on spawning `codex exec` — one paid subprocess per captured
 * tool call — until each has earned its own "You've hit your usage limit". This
 * is the second gate, at the only place that repeats per call.
 *
 * `session.quotaProbeClaimId` is what keeps the single post-cooldown probe
 * working: the one generator holding the claim must be allowed through (it IS
 * the probe), and everyone else must not ride along behind it. A generator
 * admitted while no breaker existed holds a null claim and is withheld with
 * the rest, which is correct — the breaker armed after it started.
 *
 * Read-only against the breaker: it never claims and never arms. Arming is the
 * route's job, from a real refusal with the provider's own message and resume
 * time.
 */
export const codexQuotaCircuitPreflight: CodexPreflightCheck = (_config, ctx): void => {
  const claimId = ctx.session?.quotaProbeClaimId ?? null;
  const hold = checkQuotaHold('codex', claimId);
  if (!hold.held) {
    // The single probe is being let through on its own claim: it is alive and
    // spending, so keep its claim fresh. Without this a slow but healthy probe
    // (several execs in a row as it drains its backlog, each up to the Codex timeout)
    // outlives QUOTA_PROBE_STALE_MS and a second paid probe takes it over
    // while the first is still running. A no-op for every other caller.
    touchQuotaProbe('codex', claimId);
    return;
  }

  const resumeAtMs = hold.resumeAtMs;
  const retryAfterMs = resumeAtMs === null ? undefined : Math.max(0, resumeAtMs - Date.now());
  // The provider's own words, not ours: the user is shown the reason Codex
  // gave ("weekly limit reached", "out of credits"), because that is what tells
  // them whether to wait or to change plan.
  const stated = hold.state?.message;
  const message = hold.reason === 'probe_in_flight'
    ? 'Codex quota probe is already in flight for another session; not spending a second exec on it'
    : `Codex quota cooldown is active: ${stated ?? 'the Codex allowance is spent'}`;

  throw new ClassifiedProviderError(message, {
    kind: 'quota_exhausted',
    cause: new Error(`codex quota hold (${hold.reason ?? 'unknown'})`),
    code: hold.reason === 'probe_in_flight' ? CODEX_QUOTA_CIRCUIT_CODES.probeInFlight : CODEX_QUOTA_CIRCUIT_CODES.cooldown,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    action: 'The memory observer is waiting out the Codex allowance; it resumes on its own. No action needed unless it never does.',
  });
};

export interface CodexProviderOptions {
  /** Defaults to the stateless `codex exec --ephemeral --json` transport. */
  transport?: CodexTransport;
  /**
   * The M3 quota-circuit seam; defaults to `codexQuotaCircuitPreflight`. The
   * local exec budget is always composed AFTER it (see CodexPreflightCheck),
   * whatever is injected here.
   */
  preflight?: CodexPreflightCheck;
  /** The 5-hour exec budget; defaults to the process-wide one over DATA_DIR/codex-usage.json. */
  budget?: CodexExecBudget;
  /** Counters; defaults to the process-wide `codexMetrics` /api/health reads. */
  metrics?: CodexMetrics;
  /**
   * Starts (or joins) the lockdown self-check for a binary. The default fires
   * `verifyCodexLockdown` and does not await it: the check is single-flight and
   * cached inside that module, never rejects, and only runs model-free probes.
   * Since M3 the route's non-blocking codex gate (session/codex-readiness-gate)
   * is what normally starts the check, through `verifyLockdown`; this remains
   * the provider's own fallback when a start reaches `isConfigured` unverified.
   */
  startSelfCheck?: (binaryPath: string, options: VerifyCodexLockdownOptions) => void;
  /**
   * Runs (or joins) the lockdown self-check and resolves with its verdict — the
   * awaited counterpart of `startSelfCheck`, used by the route's codex gate via
   * `verifyLockdown`. Defaults to `verifyCodexLockdown`, which is single-flight,
   * never rejects and only runs the five model-free probes. Test seam.
   */
  runSelfCheck?: (binaryPath: string, options: VerifyCodexLockdownOptions) => Promise<CodexLockdownResult>;
}

/** One warning per distinct bad value, so a wrong setting is not logged per call. */
const warnedSettings = new Set<string>();

/**
 * Every CLAUDE_MEM_CODEX_* setting is typed as a string, but settings.json is a
 * hand-editable file and the settings POST route is unauthenticated, so a JSON
 * number, boolean or array can end up in the loaded object. `null` here means
 * "not a string at all"; the callers turn that into the documented
 * warn-and-fall-back rather than a TypeError from `.trim()`, because getConfig
 * is on every codex path (readiness, startSession, the wrap-up, the per-
 * observation budget) and is documented never to throw. The route refuses the
 * same values outright — this is the second half of the same guard.
 */
function settingText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw.trim() : null;
}

function warnOnce(key: string, raw: string, replacement: string | number | boolean): void {
  const token = `${key}=${raw}`;
  if (warnedSettings.has(token)) return;
  warnedSettings.add(token);
  logger.warn('SDK', `Invalid ${key}; using ${String(replacement)} instead`, { configured: raw });
}

/** Test hook: forget which invalid settings have already been warned about. */
export function resetCodexConfigWarnings(): void {
  warnedSettings.clear();
  resolvedBinaries.clear();
}

/**
 * Memoized binary resolution (one entry per configured CLAUDE_MEM_CODEX_PATH).
 *
 * findCodexExecutable walks every absolute PATH entry with statSync +
 * accessSync and then realpathSync + statSync on the hit — tens of syscalls —
 * and getConfig runs on the ingest hot path (conversationMaxChars is called
 * once per captured tool call) and on every /api/status poll. The TTL is short
 * so a codex install or upgrade is picked up on its own, without a restart.
 */
const resolvedBinaries = new Map<string, { atMs: number; binaryPath: string | null; binaryError: string | null }>();

/** How long a resolution (hit or miss) is reused before the PATH is walked again. */
export const CODEX_BINARY_RESOLUTION_TTL_MS = 30_000;

function clampedInt(
  key: keyof SettingsDefaults,
  raw: string | undefined,
  bounds: { min: number; max: number; fallback: number },
): number {
  const text = settingText(raw);
  if (text === null) {
    warnOnce(key, JSON.stringify(raw) ?? String(raw), bounds.fallback);
    return bounds.fallback;
  }
  if (text.length === 0) return bounds.fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warnOnce(key, text, bounds.fallback);
    return bounds.fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, parsed));
    warnOnce(key, text, clamped);
    return clamped;
  }
  return parsed;
}

function booleanSetting(key: keyof SettingsDefaults, raw: string | undefined, fallback: boolean): boolean {
  const asText = settingText(raw);
  if (asText === null) {
    warnOnce(key, JSON.stringify(raw) ?? String(raw), fallback);
    return fallback;
  }
  const text = asText.toLowerCase();
  if (text.length === 0) return fallback;
  if (text === 'true') return true;
  if (text === 'false') return false;
  warnOnce(key, text, fallback);
  return fallback;
}

/**
 * A lowercased enum-ish setting. A non-string warns once and reads as empty,
 * i.e. exactly like "not configured": the caller then keeps its own default.
 */
function enumText(key: keyof SettingsDefaults, raw: string | undefined): string {
  const text = settingText(raw);
  if (text === null) {
    warnOnce(key, JSON.stringify(raw) ?? String(raw), '(the default)');
    return '';
  }
  return text.toLowerCase();
}

function modelSetting(key: keyof SettingsDefaults, raw: string | undefined, fallback: string): string {
  const text = settingText(raw);
  if (text === null) {
    warnOnce(key, JSON.stringify(raw) ?? String(raw), fallback);
    return fallback;
  }
  if (text.length === 0) return fallback;
  if (!isValidCodexModelId(text)) {
    warnOnce(key, text, fallback);
    return fallback;
  }
  return text;
}

/** The base class's purposes, in the transport's own spelling. */
function codexPurpose(purpose: ProviderQueryContext['purpose'] | undefined): CodexCallPurpose {
  switch (purpose) {
    case 'init': return 'init';
    case 'summary': return 'summary';
    case 'field-compression': return 'field_compression';
    case 'telegram-wrapup': return 'telegram_wrapup';
    default: return 'observation';
  }
}

export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> implements CodexReadinessSource {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  /**
   * Matches OpenRouter, not Gemini: an empty Codex turn is a real answer (the
   * observer chose to say nothing, plan 2.8), and forwarding it lets the
   * parser/recovery path confirm and drop the batch instead of leaving it
   * queued for a call that would produce the same nothing.
   */
  protected readonly forwardEmptyMessageResponse = true;
  /** Every call needs its purpose and session: they become the turn context. */
  protected readonly wantsQueryContext = true;
  /**
   * Adopt whatever memory_session_id the row already carries. Re-keying it on a
   * provider switch cascades through the observation rows (ON UPDATE CASCADE)
   * and can trigger a requeue storm; the id only has to be stable, not ours.
   */
  protected readonly adoptForeignMemorySessionId = true;
  /**
   * M4 hook 8: no standalone init exec. The init turn stays at the head of
   * the conversation and is sent as the stable first turn of the first real
   * call; its reply was never stored anyway. One plan message saved per
   * generator start, and a start with no work costs nothing.
   */
  protected readonly deferInitQuery = true;
  /**
   * M4 hook 9: every generator starts from an empty conversation. After a
   * quota/auth/transport pause the old turns are not re-sent at full input
   * price on every call; continuity comes from the session-start context
   * (loadSessionStartContext) the new init turn is seeded with.
   */
  protected readonly freshGenerationOnStart = true;

  private readonly transport: CodexTransport;
  private readonly preflight: CodexPreflightCheck;
  private readonly budget: CodexExecBudget;
  private readonly metrics: CodexMetrics;
  private readonly startSelfCheck: (binaryPath: string, options: VerifyCodexLockdownOptions) => void;
  private readonly runSelfCheck: (binaryPath: string, options: VerifyCodexLockdownOptions) => Promise<CodexLockdownResult>;
  /**
   * The observation turn buildObservationTurn produced last: how many tool uses
   * it carries, and how many oversized fields in it went to the prompt's
   * truncation instead of a compression exec. The base class builds the turn
   * and hands it to query() in one synchronous stretch, so query() can tell
   * what the call it is making carries by recognising its own prompt as the
   * last history entry — and the metrics record both numbers only once that
   * call's exec is actually spawned (a refused or rebuilt turn counts nothing).
   */
  private lastObservationTurn: { prompt: string; observations: number; skippedFields: number } | null = null;
  /**
   * Sessions whose current generation deferred its init exec (hook 8) and has
   * not yet spawned the first real call that carries the init turn. The saved
   * exec is counted when that call spawns: a generator refused on its first
   * call (quota, local budget) or ended before any work never had an init exec
   * to save — without the M4 lever it would have been refused or idle too.
   */
  private readonly deferredInitPending = new Set<number>();

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager, options: CodexProviderOptions = {}) {
    super(dbManager, sessionManager);
    this.transport = options.transport ?? new ExecTransport({
      envSettings: () => ({
        CLAUDE_MEM_CODEX_HOME: SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_CODEX_HOME,
      }),
    });
    this.budget = options.budget ?? getCodexExecBudget();
    this.metrics = options.metrics ?? codexMetrics;
    // Circuit first, budget second (plan 3.3): a call the breaker withholds is
    // not a budget refusal, and the budget is never consulted for it. The
    // default circuit first lifts a hold the local budget armed and no longer
    // justifies (a raised limit mid-pause); an injected circuit is used as is.
    // The budget's limit is re-read at every check (resolveCodexMaxExecsPer5h).
    this.preflight = composeCodexPreflights(
      options.preflight ?? composeCodexPreflights(
        () => { this.releaseStaleLocalBudgetHold(); },
        codexQuotaCircuitPreflight,
      ),
      codexLocalBudgetPreflight(this.budget, this.metrics, () => resolveCodexMaxExecsPer5h()),
    );
    this.startSelfCheck = options.startSelfCheck ?? ((binaryPath, verifyOptions) => {
      // Fire and forget: verifyCodexLockdown is single-flight, caches its
      // result per binary fingerprint, and never rejects. Nothing awaits it,
      // so no ingest is blocked on a subprocess probe.
      void verifyCodexLockdown(binaryPath, verifyOptions);
    });
    this.runSelfCheck = options.runSelfCheck ?? verifyCodexLockdown;
  }

  /**
   * Resolve every CLAUDE_MEM_CODEX_* setting and the binary. Only that prefix
   * is read: CLAUDE_MEM_MODEL, the $TIER aliases and session.modelOverride all
   * name models of another backend.
   *
   * Never throws — a binary that cannot be resolved becomes `binaryPath: null`,
   * which `isConfigured` turns into the setup_required error.
   */
  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const bounds = CODEX_CONFIG_BOUNDS;

    // A value that is not a string at all (a hand-edited settings.json, or a
    // JSON body that reached the file) becomes the documented
    // warn-and-fall-back, never a TypeError out of getConfig.
    const effortRaw = enumText('CLAUDE_MEM_CODEX_REASONING_EFFORT', settings.CLAUDE_MEM_CODEX_REASONING_EFFORT);
    let effort: CodexReasoningEffort = CODEX_DEFAULT_REASONING_EFFORT;
    if (effortRaw.length > 0) {
      if (isCodexReasoningEffort(effortRaw)) effort = effortRaw;
      else warnOnce('CLAUDE_MEM_CODEX_REASONING_EFFORT', effortRaw, CODEX_DEFAULT_REASONING_EFFORT);
    }

    const verbosityRaw = enumText('CLAUDE_MEM_CODEX_VERBOSITY', settings.CLAUDE_MEM_CODEX_VERBOSITY);
    let verbosity: CodexVerbosity = CODEX_DEFAULT_VERBOSITY;
    if (verbosityRaw.length > 0) {
      if (isCodexVerbosity(verbosityRaw)) verbosity = verbosityRaw;
      else warnOnce('CLAUDE_MEM_CODEX_VERBOSITY', verbosityRaw, CODEX_DEFAULT_VERBOSITY);
    }

    // 'exec-resume' and 'app-server' are reserved NAMES in Phase 1, not
    // implementations, so a config asking for one is treated exactly like an
    // unknown value: warn, and run the stateless transport.
    const transportRaw = enumText('CLAUDE_MEM_CODEX_TRANSPORT', settings.CLAUDE_MEM_CODEX_TRANSPORT);
    const transportKind: CodexTransportKind = 'exec';
    if (transportRaw.length > 0 && transportRaw !== transportKind) {
      warnOnce('CLAUDE_MEM_CODEX_TRANSPORT', transportRaw, transportKind);
    }

    // A non-string home/path is dropped rather than warned-and-substituted:
    // both feed spawn/auth identity, and '' is the documented "use the default".
    const codexHome = settingText(settings.CLAUDE_MEM_CODEX_HOME) ?? '';
    const { binaryPath, binaryError } = this.resolveBinary(settingText(settings.CLAUDE_MEM_CODEX_PATH) ?? '');

    return {
      model: modelSetting('CLAUDE_MEM_CODEX_MODEL', settings.CLAUDE_MEM_CODEX_MODEL, CODEX_DEFAULT_MODEL),
      summaryModel: modelSetting('CLAUDE_MEM_CODEX_SUMMARY_MODEL', settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL, ''),
      effort,
      verbosity,
      timeoutMs: clampedInt('CLAUDE_MEM_CODEX_TIMEOUT_MS', settings.CLAUDE_MEM_CODEX_TIMEOUT_MS, bounds.timeoutMs),
      maxConversationChars: clampedInt(
        'CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS',
        settings.CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS,
        bounds.maxConversationChars,
      ),
      batchMaxObservations: clampedInt(
        'CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS',
        settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS,
        bounds.batchMaxObservations,
      ),
      batchMaxChars: clampedInt('CLAUDE_MEM_CODEX_BATCH_MAX_CHARS', settings.CLAUDE_MEM_CODEX_BATCH_MAX_CHARS, bounds.batchMaxChars),
      batchLingerMs: clampedInt('CLAUDE_MEM_CODEX_BATCH_LINGER_MS', settings.CLAUDE_MEM_CODEX_BATCH_LINGER_MS, bounds.batchLingerMs),
      fieldCompression: booleanSetting('CLAUDE_MEM_CODEX_FIELD_COMPRESSION', settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION, false),
      transportKind,
      maxExecsPer5h: clampedInt('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H', settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H, bounds.maxExecsPer5h),
      quotaReservePercent: clampedInt(
        'CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT',
        settings.CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT,
        bounds.quotaReservePercent,
      ),
      rateLimitProbeMs: clampedInt(
        'CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS',
        settings.CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS,
        bounds.rateLimitProbeMs,
      ),
      allowUntestedVersion: booleanSetting(
        'CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION',
        settings.CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION,
        false,
      ),
      codexHome,
      binaryPath,
      binaryError,
    };
  }

  private resolveBinary(explicitPath: string | undefined): { binaryPath: string | null; binaryError: string | null } {
    const key = explicitPath ?? '';
    // getConfig runs per captured tool call (conversationMaxChars) and per
    // status poll, and an unmemoized miss walks the whole PATH with a
    // statSync + accessSync per entry. Reuse the answer for a short while;
    // the key is the configured path, so changing it re-resolves at once.
    const cached = resolvedBinaries.get(key);
    if (cached && Date.now() - cached.atMs < CODEX_BINARY_RESOLUTION_TTL_MS) {
      return { binaryPath: cached.binaryPath, binaryError: cached.binaryError };
    }

    let resolution: { binaryPath: string | null; binaryError: string | null };
    try {
      resolution = { binaryPath: findCodexExecutable({ explicitPath: key }).path, binaryError: null };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const token = `codex-binary:${message}`;
      if (!warnedSettings.has(token)) {
        warnedSettings.add(token);
        logger.warn('SDK', 'Codex CLI binary could not be resolved', { error: message });
      }
      resolution = { binaryPath: null, binaryError: message };
    }
    resolvedBinaries.set(key, { atMs: Date.now(), ...resolution });
    return resolution;
  }

  /**
   * The self-check inputs; must match between the status read and the run, or
   * the cache key differs. The summary model is one of them: summary and
   * wrap-up execs run it, so the model/CLI gate and the catalog check cover it
   * too.
   */
  private selfCheckOptions(config: CodexConfig): VerifyCodexLockdownOptions {
    return {
      model: config.model,
      summaryModel: this.resolveSummaryModel(config),
      effort: config.effort,
      verbosity: config.verbosity,
      allowUntestedVersion: config.allowUntestedVersion,
      envSettings: config.codexHome ? { CLAUDE_MEM_CODEX_HOME: config.codexHome } : {},
    };
  }

  /** The cached lockdown verdict for the configured binary, or null when none has run. */
  lockdownStatus(config?: CodexConfig): CodexLockdownResult | null {
    const resolved = config ?? this.getConfig();
    if (!resolved.binaryPath) return null;
    return getCodexLockdownStatus(resolved.binaryPath, this.selfCheckOptions(resolved));
  }

  /**
   * The codex gate's cheap question (M3, plan 3.5): is this observer ready, and
   * if not, why? Never spawns and never starts a check — it reads the memoized
   * binary resolution and the self-check cache, which is what lets the gate ask
   * it on the ingest path without blocking ingest on a subprocess.
   */
  readinessSnapshot(): CodexReadinessSnapshot {
    const config = this.getConfig();
    if (!config.binaryPath) {
      return { state: 'binary_missing', message: config.binaryError ?? 'the Codex CLI binary could not be resolved' };
    }
    const status = this.lockdownStatus(config);
    if (status === null) return { state: 'unverified' };
    if (status.state === 'pending') return { state: 'pending' };
    if (status.state === 'passed') return { state: 'passed' };
    return { state: 'failed', result: status };
  }

  /**
   * What the self-check verdict for the configured binary would be keyed on
   * now (binary, login, codex settings), or null without a binary. The gate
   * compares it with the key its last canary ran under: once an exec-time
   * problem has used up its automatic re-checks, a changed setup is what earns
   * it new ones. Never spawns.
   */
  readinessFingerprint(): string | null {
    const config = this.getConfig();
    if (!config.binaryPath) return null;
    return getCodexLockdownFingerprint(config.binaryPath, this.selfCheckOptions(config));
  }

  /**
   * Start (or join) the lockdown self-check for the configured binary and
   * resolve with its verdict; null when there is no binary to check. `force`
   * re-runs a check whose failed or passed verdict is still cached — the
   * gate's re-check after a setup/login backoff expires. Model-free: the five
   * probes never reach the user's plan.
   */
  verifyLockdown(options: { force?: boolean } = {}): Promise<CodexLockdownResult | null> {
    const config = this.getConfig();
    if (!config.binaryPath) return Promise.resolve(null);
    return this.runSelfCheck(config.binaryPath, {
      ...this.selfCheckOptions(config),
      ...(options.force ? { force: true } : {}),
    });
  }

  /**
   * Ready only with a resolved binary AND a FINISHED, passing self-check.
   * "Not run yet" and "still running" are both false: the lockdown is what
   * keeps a paid exec from running a tool, so an unverified binary is a setup
   * problem, not a reason to try anyway.
   */
  protected isConfigured(config: CodexConfig): boolean {
    if (!config.binaryPath) return false;
    const status = getCodexLockdownStatus(config.binaryPath, this.selfCheckOptions(config));
    if (status?.state === 'passed') return true;
    // Not passed: make sure a check is (or has been) running, so the next call
    // can answer from the cache instead of being blocked forever.
    this.startSelfCheck(config.binaryPath, this.selfCheckOptions(config));
    return false;
  }

  /**
   * The one error an unready Codex observer raises. `setup_required` keeps it
   * out of the quota/outage ledgers and, in SessionRoutes, out of the retry
   * loop — the user has to install, log in, or point CLAUDE_MEM_CODEX_PATH at
   * the binary before anything can work.
   */
  protected missingApiKeyError(): Error {
    const config = this.getConfig();
    const status = this.lockdownStatus(config);
    const detail = !config.binaryPath
      ? (config.binaryError ?? 'the Codex CLI binary could not be resolved')
      : status === null
        ? 'its lockdown self-check has not finished yet'
        : status.state === 'pending'
          ? 'its lockdown self-check is still running'
          : `its lockdown self-check failed at the ${status.failure?.step ?? 'unknown'} step`;
    return new ClassifiedProviderError(`Codex observer is not ready: ${detail}`, {
      kind: 'setup_required',
      cause: new Error('codex observer not configured'),
      code: 'codex_setup_required',
      action: 'Install the Codex CLI, run `codex login` with your ChatGPT account, or set CLAUDE_MEM_CODEX_PATH to the absolute native codex binary.',
    });
  }

  /** Human-readable auth method for getAiStatus (plan 3.4). */
  getAuthMethodDescription(): string {
    try {
      const config = this.getConfig();
      // With no binary there is nothing to describe, and the self-check module
      // would answer from its LAST result — which could belong to a different
      // binary entirely.
      if (!config.binaryPath) {
        return 'Codex CLI (not found; install it or set CLAUDE_MEM_CODEX_PATH)';
      }
      return getCodexAuthMethodDescription(config.binaryPath, this.selfCheckOptions(config));
    } catch (error: unknown) {
      logger.debug('SDK', 'Could not describe the Codex auth method', {}, error instanceof Error ? error : new Error(String(error)));
      return 'Codex CLI (not verified yet)';
    }
  }

  /** Plan 2.6: ~4 characters per token is the accepted estimate for these models. */
  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Real counts only, and never a cost: a ChatGPT-plan exec has no per-call
   * price, so reporting one would invent spend that was never billed.
   */
  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number'
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  /**
   * Off by default: each compression is a whole extra exec, the optimizer runs
   * input and output in parallel, and it enforces its own 30 s deadline — three
   * reasons a metered CLI should take the prompt's existing head/tail elision
   * instead. CLAUDE_MEM_CODEX_FIELD_COMPRESSION=true restores the shared pass.
   */
  protected fieldCompressor(config: CodexConfig, session?: ActiveSession): FieldCompressor | null {
    if (!config.fieldCompression) return null;
    // `session` is forwarded, not ignored: a compression turn is a whole exec,
    // and an exec with no session runs in the shared jail directory, registers
    // under a sessionDbId no session owns, and shares one lockdown-violation
    // counter with every other session's compression turns.
    const compress = super.fieldCompressor(config, session);
    if (!compress) return null;

    // The base class asks for one compressor per observation turn, so this
    // state is per turn. A null answer is the optimizer's documented "fall back
    // to the prompt's truncation": the observation is degraded, never lost.
    let stickyFailure: string | null = null;
    let inFlight = 0;
    return async (text, budgetChars, signal) => {
      // A refusal that will repeat for every further call (a spent allowance or
      // local budget, a lost login): do not spawn it again for the next field.
      if (stickyFailure) return null;
      if (session?.abortController.signal.aborted) return null;
      // Never let a compression take the exec the observation turn itself
      // needs. Without this reserve, a window with one exec left spends it on
      // the compression, the observation is refused, and every later slide of
      // the window repeats that — plan messages spent, nothing ever stored.
      // Calls of this turn already started count against the room too
      // (conservatively: a spawned one is also in usedInWindow until it ends).
      const limit = resolveCodexMaxExecsPer5h();
      if (limit > 0 && limit - this.budget.usedInWindow() - inFlight < 2) {
        logger.debug('SDK', 'Codex field compression skipped: the exec budget has room only for the observation turn', {
          sessionId: session?.sessionDbId,
          limit,
        });
        return null;
      }
      inFlight += 1;
      try {
        // The optimizer's own deadline signal, plus the session's: a compression
        // pass must not outlive a session that is shutting down or pausing.
        const combined = session ? AbortSignal.any([signal, session.abortController.signal]) : signal;
        return await compress(text, budgetChars, combined);
      } catch (error: unknown) {
        if (isClassified(error) && STICKY_COMPRESSION_FAILURE_KINDS.has(error.kind)) {
          stickyFailure = error.kind;
        }
        throw error;
      } finally {
        inFlight -= 1;
      }
    };
  }

  /**
   * CLAUDE_MEM_CODEX_SUMMARY_MODEL, else the observer model. Deliberately not
   * `resolveSummaryTierModel`: CLAUDE_MEM_TIER_SUMMARY_MODEL is shared with the
   * Claude path and routinely holds an Anthropic model name.
   */
  protected resolveSummaryModel(config: CodexConfig): string {
    return config.summaryModel || config.model;
  }

  /**
   * The Codex budget, floored so a FRESH generation is never already over it:
   * first turn + one batch + head-room. Without the floor a large init turn
   * could be recycled, and the new generation recycled again on its first
   * observation, which is what arms the ten-minute overflow pause.
   */
  protected conversationMaxChars(session?: ActiveSession): number {
    const config = this.getConfig();
    const firstTurnChars = session?.conversationHistory?.[0]?.content.length ?? 0;
    return Math.max(
      config.maxConversationChars,
      firstTurnChars + config.batchMaxChars + CODEX_CONVERSATION_HEADROOM_CHARS,
    );
  }

  /**
   * M4 hook 10: queued observations of one prompt/agent/cwd share one exec,
   * picked oldest first out of the interleaved queue (other groups skipped,
   * never past a summarize, never out of order within the group — see
   * SessionManager.claimObservationBatch), within
   * CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS (default 4) and
   * CLAUDE_MEM_CODEX_BATCH_MAX_CHARS (48,000 rendered characters), lingering up
   * to CLAUDE_MEM_CODEX_BATCH_LINGER_MS (2 s) only while the queue is idle.
   * A maximum of 1 turns batching off entirely: no policy, so the base class
   * runs its original one-observation-per-turn loop.
   */
  protected observationBatchPolicy(config: CodexConfig): ObservationBatchPolicy | null {
    if (config.batchMaxObservations <= 1) return null;
    return {
      maxMessages: config.batchMaxObservations,
      maxChars: config.batchMaxChars,
      lingerMs: config.batchLingerMs,
    };
  }

  /**
   * The observation turn: buildObservationBatchPrompt, which is byte-for-byte
   * buildObservationPrompt for a single observation. Also where the metrics
   * learn what the turn carries — its batch size, and (with field compression
   * off, the default) how many oversized fields went to the prompt's own
   * truncation instead of a compression exec each.
   */
  protected buildObservationTurn(observations: readonly Observation[]): string {
    const prompt = buildObservationBatchPrompt(observations);
    let skippedFields = 0;
    if (!this.getConfig().fieldCompression) {
      for (const observation of observations) {
        skippedFields += countFieldsNeedingCompression(
          { toolInput: decodeObservationField(observation.tool_input), toolOutput: decodeObservationField(observation.tool_output) },
          { toolName: observation.tool_name },
        );
      }
    }
    // Recorded by query() once this turn's exec is spawned, not here: the turn
    // may yet be refused before any exec (circuit, local budget) and rebuilt
    // after the pause, and neither may count as a compression exec saved.
    this.lastObservationTurn = { prompt, observations: observations.length, skippedFields };
    return prompt;
  }

  /**
   * deferInitQuery skipped this generation's init exec. Counted as saved once
   * the first real call carrying the init turn is spawned (see
   * deferredInitPending); a new generation simply re-arms the same flag.
   */
  protected onInitQueryDeferred(session: ActiveSession): void {
    this.deferredInitPending.add(session.sessionDbId);
  }

  /**
   * Lift a quota hold that the LOCAL exec budget armed and no longer
   * justifies; returns whether it did.
   *
   * A local_budget refusal is booked into the shared quota breaker with the
   * resume time the limit in force at the time implied (up to five hours
   * out), and the breaker is persisted. When the user then raises
   * CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H, sets it to 0, or resets codex-usage.json,
   * the budget allows execs again but nothing else would consult it before
   * that stale time. So while such a hold is still in its cooldown, it is
   * checked against the budget as it stands now, and cleared when the budget
   * has room — which also drains every session that waited on it (the resume
   * scheduler listens for the clear). A hold with any other cause, or one
   * whose window has already elapsed (the ordinary single probe handles that),
   * is left alone. Read-only against the budget; never spends.
   */
  releaseStaleLocalBudgetHold(nowMs: number = Date.now()): boolean {
    const state = getQuotaCooldown('codex');
    if (!state || state.code !== CODEX_LOCAL_BUDGET_CODE) return false;
    if (nowMs >= quotaCooldownResumeAtMs(state)) return false;
    const limit = resolveCodexMaxExecsPer5h();
    const used = this.budget.usedInWindow();
    if (limit > 0 && used >= limit) return false;
    logger.info('SDK', 'The local Codex exec budget has room again; lifting its pause early', {
      limit,
      used,
      heldUntil: new Date(quotaCooldownResumeAtMs(state)).toISOString(),
    });
    clearQuotaCooldown('codex');
    return true;
  }

  /**
   * What /api/health shows for codex (`ai.codex`): the 5-hour budget as it
   * stands and the process's counters. Counts and timestamps only.
   */
  getUsageStatus(): { budget: CodexBudgetSnapshot; metrics: CodexMetricsSnapshot } {
    let limit = 0;
    try {
      // The same live read the budget check itself uses.
      limit = resolveCodexMaxExecsPer5h();
    } catch (error: unknown) {
      logger.debug('SDK', 'Could not read the Codex exec budget setting for status', {}, error instanceof Error ? error : new Error(String(error)));
    }
    return { budget: this.budget.snapshot(limit), metrics: this.metrics.snapshot() };
  }

  /**
   * The native codex binary this provider would spawn, resolved exactly as
   * every exec resolves it (memoized), or null. The boot-time orphan cleanup
   * matches registry records against it.
   */
  resolvedBinaryPath(): string | null {
    return this.getConfig().binaryPath;
  }

  /** Write pending token counts to codex-usage.json now (worker shutdown). */
  flushUsage(): void {
    this.budget.flush();
  }

  /**
   * The generator run, plus the one piece of per-run state this provider owns:
   * the lockdown violation counter.
   *
   * CODEX_LOCKDOWN_BREACH_THRESHOLD escalates a SECOND forbidden-tool attempt
   * to a setup_required codex_lockdown_breach, and the counter is a
   * process-lifetime map keyed by session. Without this reset "second attempt"
   * would mean "second attempt ever, however many generations apart", so two
   * unrelated guard kills hours apart would take a healthy install down.
   * Clearing here makes the threshold mean what plan 5/L4 says it means:
   * repeated within one generator run.
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      await super.startSession(session, worker);
    } finally {
      this.violations().clear(session.sessionDbId);
      // A generation that ended before any call carrying its init turn was
      // spawned saved nothing (see deferredInitPending).
      this.deferredInitPending.delete(session.sessionDbId);
    }
  }

  /**
   * The tracker this provider's turns record into: the transport's own when it
   * has one, else the shared module-level tracker settleCodexTurn falls back
   * to. Resolving it the same way in both places is what makes the reset above
   * clear the counts the threshold is actually read from.
   */
  private violations(): CodexViolationTracker {
    return (this.transport as { violations?: CodexViolationTracker }).violations ?? codexViolationTracker;
  }

  /**
   * One Codex turn: pre-flight (M3/M4), render, run, classify.
   *
   * The rendered prompt is deterministic and cache-friendly — the transcript is
   * a byte prefix of the next call's transcript — so the plan's stdin contract
   * is honoured for every purpose, including the two off-to-the-side calls
   * (field compression, Telegram wrap-up) whose history is a single message.
   */
  protected async query(
    history: ConversationMessage[],
    config: CodexConfig,
    signal?: AbortSignal,
    ctx?: ProviderQueryContext,
  ): Promise<ProviderQueryResult> {
    const session = ctx?.session;
    const purpose = codexPurpose(ctx?.purpose);
    const sessionDbId = session?.sessionDbId ?? ctx?.sessionDbId ?? 0;
    // Read (and forgotten) before the first await: the turn was built and
    // pushed in the same synchronous stretch that called us.
    const observationTurn = purpose === 'observation' ? this.takeObservationTurn(history) : null;
    // Only these two calls carry the conversation, and so the deferred init
    // turn at its head; compression and the wrap-up are single-message calls.
    const carriesInitTurn = session !== undefined && (purpose === 'observation' || purpose === 'summary');

    if (!config.binaryPath) {
      const error = this.missingApiKeyError();
      this.rememberFailure(session, error);
      throw error;
    }

    try {
      // (1) the quota circuit (M3), (2) the local 5-hour exec budget (M4).
      // Deliberately the FIRST thing after the binary check and before the
      // prompt is rendered: every statement past this point costs an exec.
      await this.preflight(config, { sessionDbId, purpose, ...(session ? { session } : {}) });
    } catch (error: unknown) {
      this.rememberFailure(session, error);
      throw error;
    }

    // The base class passes a signal only for the bounded field-compression
    // call; every other call is cancelled through the session's own controller.
    const abortSignal = signal ?? session?.abortController.signal;
    const preflightContext: CodexPreflightContext = { sessionDbId, purpose, ...(session ? { session } : {}) };
    // Set by onSpawned; a holder rather than a `let` because the assignment
    // happens inside the transport, where control-flow narrowing cannot see it.
    const spawned: { ticket: CodexExecTicket | null } = { ticket: null };
    const turnContext: CodexTurnContext = {
      sessionDbId,
      purpose,
      binaryPath: config.binaryPath,
      model: config.model,
      effort: config.effort,
      verbosity: config.verbosity,
      timeoutMs: config.timeoutMs,
      ...(abortSignal ? { abortSignal } : {}),
      ...(session ? { contentSessionId: session.contentSessionId, project: session.project } : {}),
      // The same check again, once the pool slot is granted and immediately
      // before the spawn. The check above ran BEFORE the transport parked this
      // turn for a slot, and that park can last indefinitely (#2756): when the
      // allowance runs out while several turns are queued, every one of them
      // has already passed the circuit, and without this each would spawn its
      // own exec and earn its own usage-limit refusal the moment a slot frees
      // — the per-call storm the circuit exists to stop. A throw here comes
      // back out of oneShot with the slot released and nothing spawned. The
      // local exec budget re-checks here too: slots are what several turns
      // wait on together, so the last free exec of the window is decided now.
      beforeSpawn: () => this.preflight(config, preflightContext),
      // The exec exists: count it against the 5-hour budget and in the
      // metrics now, whatever happens to it next — a timeout, an abort or a
      // guard kill reached the plan just the same.
      onSpawned: () => {
        spawned.ticket = this.budget.recordExec();
        this.metrics.recordExec(purpose, observationTurn?.observations ?? 0);
        // What the M4 levers saved, booked only now that the call they rode on
        // really spent its exec.
        if (observationTurn && observationTurn.skippedFields > 0) {
          this.metrics.recordFieldCompressionSkipped(observationTurn.skippedFields);
        }
        if (carriesInitTurn && this.deferredInitPending.delete(sessionDbId)) {
          this.metrics.recordInitSkipped();
        }
      },
    };

    let result: TurnResult;
    try {
      const prompt = renderCodexPromptFromConversation(history);
      result = await this.transport.oneShot(prompt, turnContext);
    } catch (error: unknown) {
      this.rememberFailure(session, error);
      throw error;
    }

    if (result.usage) {
      if (spawned.ticket) this.budget.recordUsage(spawned.ticket, result.usage);
      this.metrics.recordUsage(result.usage);
    }
    if (result.toolAttempt) this.metrics.recordToolAttempt();

    try {
      const outcome = settleCodexTurn(result, turnContext, { violations: this.violations() });
      return { content: outcome.content, ...usageOf(result) };
    } catch (error: unknown) {
      this.rememberFailure(session, error);
      throw error;
    }
  }

  /**
   * What the observation call being made carries: the tool-use count and
   * skipped-field count of the turn buildObservationTurn built last, when that
   * turn is the one being sent (it is the last history entry); one tool use and
   * nothing skipped otherwise. Consumed, so a stale turn can never be
   * attributed to a later call.
   */
  private takeObservationTurn(history: ConversationMessage[]): { observations: number; skippedFields: number } {
    const built = this.lastObservationTurn;
    this.lastObservationTurn = null;
    const last = history[history.length - 1];
    return built && last && last.role === 'user' && last.content === built.prompt
      ? { observations: built.observations, skippedFields: built.skippedFields }
      : { observations: 1, skippedFields: 0 };
  }

  /**
   * Stash the classified failure on the session before it unwinds. Everything
   * that reacts to it — the route's `.finally()`, status, and the M3 quota
   * circuit — runs while this call is still on the stack, so a failure recorded
   * afterwards would arrive too late to be read.
   */
  private rememberFailure(session: ActiveSession | undefined, error: unknown): void {
    if (session && isClassified(error)) {
      session.lastProviderError = error;
    }
  }
}

/**
 * An Observation's tool field back to the value the optimizer would have
 * seen: the base class encodes it with JSON.stringify, so JSON.parse restores
 * it exactly. Anything that does not parse is used as-is.
 */
function decodeObservationField(encoded: unknown): unknown {
  if (typeof encoded !== 'string') return encoded;
  try {
    return JSON.parse(encoded);
  } catch {
    return encoded;
  }
}

/** Token counts from a finished turn; both sides or neither (never half-real). */
function usageOf(result: TurnResult): Pick<ProviderQueryResult, 'tokensUsed' | 'inputTokens' | 'outputTokens'> {
  if (!result.usage) return {};
  return {
    tokensUsed: result.usage.input + result.usage.output,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
  };
}

/**
 * Settings-only selection check, exactly like isGeminiSelected /
 * isOpenRouterSelected. There is no availability gate beside it: dispatch must
 * not fall back to another provider behind the user's back, so an unusable
 * Codex setup surfaces as the setup_required error above.
 */
export function isCodexSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_PROVIDER === 'codex';
}
