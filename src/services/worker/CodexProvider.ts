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
 * The quota circuit is now installed on that seam (M3,
 * `codexQuotaCircuitPreflight`). NOT here yet, by design: the local 5-hour exec
 * budget and batching (M4).
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
  type ProviderConfigBase,
  type ProviderQueryContext,
  type ProviderQueryResult,
} from './OpenAICompatibleProvider.js';
import type { WorkerRef } from './agents/index.js';
import type { FieldCompressor } from './field-optimizer.js';
import { findCodexExecutable } from '../../shared/find-codex-executable.js';
import { checkQuotaHold, touchQuotaProbe } from '../../shared/quota-cooldown.js';
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
 * The default is `codexQuotaCircuitPreflight` (M3). M4 composes the local
 * 5-hour exec budget with it rather than replacing it.
 *
 * It runs TWICE per call: once before the prompt is rendered, and again after
 * the transport's pool slot is granted, immediately before the spawn
 * (`CodexTurnContext.beforeSpawn`). So it must be a check, not a reservation:
 * anything it counts has to be counted where the exec actually happens, or
 * every call would be counted twice.
 */
export type CodexPreflightCheck = (config: CodexConfig, ctx: CodexPreflightContext) => void | Promise<void>;

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
    // (an init exec plus an observation exec, each up to the Codex timeout)
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
  /** M3/M4 quota-circuit + local-budget seam; defaults to `codexQuotaCircuitPreflight`. */
  preflight?: CodexPreflightCheck;
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
   * never rejects and only runs the four model-free probes. Test seam.
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

  private readonly transport: CodexTransport;
  private readonly preflight: CodexPreflightCheck;
  private readonly startSelfCheck: (binaryPath: string, options: VerifyCodexLockdownOptions) => void;
  private readonly runSelfCheck: (binaryPath: string, options: VerifyCodexLockdownOptions) => Promise<CodexLockdownResult>;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager, options: CodexProviderOptions = {}) {
    super(dbManager, sessionManager);
    this.transport = options.transport ?? new ExecTransport({
      envSettings: () => ({
        CLAUDE_MEM_CODEX_HOME: SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_CODEX_HOME,
      }),
    });
    this.preflight = options.preflight ?? codexQuotaCircuitPreflight;
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

  /** The self-check inputs; must match between the status read and the run, or the cache key differs. */
  private selfCheckOptions(config: CodexConfig): VerifyCodexLockdownOptions {
    return {
      model: config.model,
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
   * gate's re-check after a setup/login backoff expires. Model-free: the four
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
    // `session` is forwarded, not ignored: a compression turn is a whole exec,
    // and an exec with no session runs in the shared jail directory, registers
    // under a sessionDbId no session owns, and shares one lockdown-violation
    // counter with every other session's compression turns.
    return config.fieldCompression ? super.fieldCompressor(config, session) : null;
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
      // back out of oneShot with the slot released and nothing spawned.
      beforeSpawn: () => this.preflight(config, preflightContext),
    };

    let result: TurnResult;
    try {
      const prompt = renderCodexPromptFromConversation(history);
      result = await this.transport.oneShot(prompt, turnContext);
    } catch (error: unknown) {
      this.rememberFailure(session, error);
      throw error;
    }

    try {
      const outcome = settleCodexTurn(result, turnContext, { violations: this.violations() });
      return { content: outcome.content, ...usageOf(result) };
    } catch (error: unknown) {
      this.rememberFailure(session, error);
      throw error;
    }
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
