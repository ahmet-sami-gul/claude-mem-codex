/**
 * Codex failure classification (plan 2.8, 3.5).
 *
 * Maps a finished `codex exec` turn (or a runner-level condition) to exactly
 * one outcome:
 *   - an error to throw (ClassifiedProviderError with kind quota_exhausted,
 *     rate_limit, auth_invalid, setup_required or transient), or
 *   - a context overflow, returned as CONTENT so ResponseProcessor's existing
 *     recycle branch runs, or
 *   - a content-policy refusal, returned as '' so only that batch is dropped.
 *
 * Source of the matched texts: upstream codex-rs `protocol/src/error.rs` and
 * the 0.144.4 binary strings. Real failure JSONL shapes were NOT observed in
 * Phase 0 (no usage-limit or auth error could be provoked), and the matching
 * assumes English text. The Plus/Free plan mismatch ("To use Codex with your
 * ChatGPT plan, upgrade to Plus", `usage_not_included`) does not heal by
 * waiting, so it is setup_required, not quota_exhausted.
 *
 * Reset times: Codex prints the reset in ITS local zone, as "Try again at
 * 3:45 PM" (same local date) or "try again at Sep 22nd, 2026 3:45 PM". The
 * worker passes the child the same TZ (codex-env.ts), and parseCodexResetTime
 * takes `now` and the zone explicitly so tests are deterministic. A 60 s grace
 * is added; "Try again later" yields no time and a 30 min default applies, and
 * so does a reset time that resolves into the past (unusable, never a zero
 * pause).
 *
 * Redaction: raw stderr never reaches `message` or `cause`. The message carries
 * a short excerpt of the matched failure text after home-dir, URL-query,
 * email and token redaction; `cause` is a fixed diagnostic string. Messages
 * never contain "code 143" or "signal SIGTERM", which SessionRoutes treats as
 * an external kill (plan 2.6).
 *
 * Pure module (matches the logger-usage-standards `errors.ts` exemption).
 */

import { ClassifiedProviderError, type ProviderErrorClass } from '../provider-errors.js';
import {
  capRawInput,
  collapseWhitespace,
  redactHomeDir,
  redactSecrets,
  redactUrlQueryStrings,
} from '../../telemetry/error-scrub.js';
import { stripCodexStdinNotice } from './codex-jsonl.js';
import type { CodexToolAttempt, TurnResult } from './codex-transport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Added to a parsed reset time before resuming. */
export const CODEX_RESET_GRACE_MS = 60_000;

/** Used when the limit message carries no reset time ("Try again later"). */
export const CODEX_DEFAULT_QUOTA_RETRY_MS = 30 * 60_000;

/** Full breaker for 429-after-retries and model-at-capacity (plan 3.5). */
export const CODEX_RATE_LIMIT_RETRY_MS = 30 * 60_000;

/** Max characters of upstream text kept in a classified message. */
export const CODEX_ERROR_EXCERPT_CHARS = 300;

/** Content returned for a context overflow; matched by the output classifier (M2). */
export const CODEX_CONTEXT_OVERFLOW_CONTENT = "Codex ran out of room in the model's context window.";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Failures detected by the runner / provider rather than by upstream text.
 * Setup conditions and `timeout` are definitive; the `missing_*` ones apply
 * only when no upstream text explains the failure.
 */
export type CodexRunnerCondition =
  | 'timeout'
  | 'hard_cap_exceeded'
  | 'not_executable'
  | 'resolution_failed'
  | 'spawn_failed'
  | 'lockdown_breach'
  | 'version_untested'
  | 'model_needs_newer_cli'
  | 'self_check_failed'
  | 'api_key_login'
  | 'stream_truncated'
  | 'missing_turn_completed'
  | 'missing_agent_message';

export interface CodexErrorInput {
  /** turn.failed message, else the top-level error candidate. */
  failureMessage?: string | null;
  /** stderr tail; the stdin notice is ignored. Used for matching, never echoed raw. */
  stderrTail?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  condition?: CodexRunnerCondition | null;
  /** Extra context for a condition (e.g. which probe failed); redacted like upstream text. */
  detail?: string | null;
  /** Clock for reset-time parsing; defaults to Date.now(). */
  now?: number | Date;
  /** IANA zone the child formatted its reset time in; defaults to the process zone. */
  timeZone?: string;
}

export type CodexFailureClassification =
  | {
      type: 'error';
      error: ClassifiedProviderError;
      /** Stable id of the rule that matched (for tests and logs). */
      rule: string;
      /** Absolute resume time for quota/rate-limit breakers, else null. */
      resumeAtMs: number | null;
    }
  | { type: 'context_overflow'; content: string; rule: string }
  | { type: 'content_policy'; content: ''; rule: string };

export type CodexTurnOutcome =
  | { type: 'success'; content: string }
  | { type: 'tool_attempt'; attempt: CodexToolAttempt }
  | CodexFailureClassification;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Replace the two substrings SessionRoutes reads as "killed from outside". */
export function neutralizeKillMarkers(text: string): string {
  return text.replace(/code 143/gi, 'exit status 143').replace(/signal SIGTERM/gi, 'SIGTERM');
}

/**
 * Redact and bound an upstream diagnostic for use in a message: stdin notice
 * removed, home dir -> `~`, URL query strings and userinfo, emails, keys,
 * tokens, UUIDs removed, whitespace collapsed, capped.
 */
export function redactCodexDiagnostic(text: string | null | undefined, maxChars = CODEX_ERROR_EXCERPT_CHARS): string {
  if (!text) return '';
  let out = capRawInput(stripCodexStdinNotice(text));
  out = redactHomeDir(out);
  out = redactUrlQueryStrings(out);
  out = redactSecrets(out);
  out = collapseWhitespace(out).replace(/\n+/g, ' ');
  out = neutralizeKillMarkers(out);
  return out.length > maxChars ? out.slice(0, maxChars) + '...' : out;
}

// ---------------------------------------------------------------------------
// Reset-time parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const RESET_RE =
  /try again at\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\b/i;

interface WallTime {
  year: number;
  month: number; // 0-11
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `epochMs` in `timeZone` (process zone when undefined). */
function wallTimeAt(epochMs: number, timeZone: string | undefined): WallTime & { second: number } {
  if (timeZone === undefined) {
    const d = new Date(epochMs);
    return {
      year: d.getFullYear(), month: d.getMonth(), day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
    };
  }
  const parts: Record<string, number> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year, month: parts.month - 1, day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour, minute: parts.minute, second: parts.second,
  };
}

/** Offset (wall clock minus UTC) of `timeZone` at `epochMs`. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const w = wallTimeAt(epochMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch of a wall-clock time in `timeZone` (process zone when undefined). */
function epochOfWallTime(w: WallTime, timeZone: string | undefined): number {
  if (timeZone === undefined) {
    return new Date(w.year, w.month, w.day, w.hour, w.minute, 0, 0).getTime();
  }
  const utcGuess = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, 0, 0);
  const firstOffset = zoneOffsetMs(utcGuess, timeZone);
  let epoch = utcGuess - firstOffset;
  const secondOffset = zoneOffsetMs(epoch, timeZone);
  if (secondOffset !== firstOffset) epoch = utcGuess - secondOffset;
  return epoch;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Parse the reset instant from a Codex usage-limit message. Returns epoch ms
 * WITHOUT the grace period, or null when the message has no parseable time
 * ("Try again later"), the zone is invalid, or the date is impossible.
 *
 * Same-day form ("3:45 PM") resolves on `now`'s local date in `timeZone`. If
 * the message was produced just before midnight and parsed just after, the
 * same-day time would land ~24 h ahead; that case is folded back one day.
 */
export function parseCodexResetTime(message: string, now: number | Date, timeZone?: string): number | null {
  if (typeof message !== 'string' || message.length === 0) return null;
  const match = RESET_RE.exec(message);
  if (!match) return null;

  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  const hour12 = Number(match[4]);
  const minute = Number(match[5]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const pm = match[6].toLowerCase() === 'p';
  const hour = (hour12 % 12) + (pm ? 12 : 0);

  try {
    let wall: WallTime;
    const hasDate = match[1] !== undefined;
    if (hasDate) {
      const month = MONTHS[match[1].toLowerCase().slice(0, 3)];
      const day = Number(match[2]);
      const year = Number(match[3]);
      if (day < 1 || day > daysInMonth(year, month)) return null;
      wall = { year, month, day, hour, minute };
    } else {
      const today = wallTimeAt(nowMs, timeZone);
      wall = { year: today.year, month: today.month, day: today.day, hour, minute };
    }

    let epoch = epochOfWallTime(wall, timeZone);
    if (!Number.isFinite(epoch)) return null;

    if (!hasDate && epoch - nowMs > 23 * HOUR_MS) {
      const localNow = wallTimeAt(nowMs, timeZone);
      if (localNow.hour === 0 && localNow.minute < 5) {
        const yesterday = wallTimeAt(nowMs - DAY_MS, timeZone);
        epoch = epochOfWallTime({ year: yesterday.year, month: yesterday.month, day: yesterday.day, hour, minute }, timeZone);
      }
    }
    return epoch;
  } catch {
    // [ANTI-PATTERN IGNORED]: Intl throws RangeError for an unknown IANA zone;
    // the documented result for an unusable zone is null (30 min default applies).
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type ErrorKind = Extract<ProviderErrorClass, 'quota_exhausted' | 'rate_limit' | 'auth_invalid' | 'setup_required' | 'transient'>;

interface TextRule {
  id: string;
  patterns: RegExp[];
  outcome: 'error' | 'context_overflow' | 'content_policy';
  kind?: ErrorKind;
  code?: string;
  label?: string;
  action?: string;
}

const ACTION_INSTALL = 'Install the Codex CLI or set CLAUDE_MEM_CODEX_PATH to the native codex binary.';
const ACTION_LOGIN = 'Run `codex login` (ChatGPT sign-in).';
const ACTION_PLAN = 'Upgrade the ChatGPT plan or switch CLAUDE_MEM_PROVIDER to another provider.';
const ACTION_INVOCATION = 'The Codex CLI rejected the locked invocation; update claude-mem or use a tested Codex CLI version.';

/** Ordered: the first matching rule wins. */
const TEXT_RULES: readonly TextRule[] = [
  {
    id: 'content_policy',
    patterns: [/flagged for possible cybersecurity risk/i],
    outcome: 'content_policy',
  },
  {
    id: 'context_overflow',
    patterns: [/ran out of room in the model'?s context window/i],
    outcome: 'context_overflow',
  },
  {
    id: 'plan_not_included',
    patterns: [/to use codex with your chatgpt plan,?\s*upgrade to plus/i, /usage_not_included/i],
    outcome: 'error',
    kind: 'setup_required',
    code: 'codex_plan_not_included',
    label: 'Codex is not included in this ChatGPT plan',
    action: ACTION_PLAN,
  },
  {
    id: 'usage_limit',
    patterns: [
      /you['’]ve hit your usage limit/i,
      /usage limit reached/i,
      /usage limit for .{1,80}?switch to another model/i,
      /workspace is out of credits/i,
      /\bout of credits\b/i,
      /hit your spend cap/i,
      /quota exceeded\.\s*check your plan/i,
    ],
    outcome: 'error',
    kind: 'quota_exhausted',
    code: 'codex_usage_limit',
    label: 'Codex usage limit reached',
    action: 'The observer pauses until the Codex usage window resets.',
  },
  {
    id: 'rate_limit',
    patterns: [/exceeded retry limit,?\s*last status:?\s*429/i, /selected model is at capacity/i],
    outcome: 'error',
    kind: 'rate_limit',
    code: 'codex_rate_limited',
    label: 'Codex rate limited',
    action: 'The observer pauses for 30 minutes.',
  },
  {
    id: 'api_key_login',
    patterns: [/logged in using an api key/i],
    outcome: 'error',
    kind: 'setup_required',
    code: 'codex_api_key_login',
    label: 'Codex is logged in with an API key, not ChatGPT',
    action: ACTION_LOGIN,
  },
  {
    id: 'auth_invalid',
    patterns: [/could not be refreshed/i, /sign in again/i, /\bnot logged in\b/i, /unexpected status 401/i],
    outcome: 'error',
    kind: 'auth_invalid',
    code: 'codex_auth_invalid',
    label: 'Codex authentication failed',
    action: ACTION_LOGIN,
  },
  {
    id: 'invocation_rejected',
    patterns: [
      /error parsing -c overrides/i,
      /unknown feature flag/i,
      /unexpected argument/i,
      /invalid value .{0,80} for '--/i,
      /instructions are not valid/i,
      /model_not_found/i,
      /\bmodel\b.{0,120}\b(?:is not supported|does not exist|not found|is not available)/i,
      /unsupported model/i,
    ],
    outcome: 'error',
    kind: 'setup_required',
    code: 'codex_invocation_rejected',
    label: 'Codex rejected the observer invocation',
    action: ACTION_INVOCATION,
  },
  {
    id: 'transient_upstream',
    patterns: [
      /stream disconnected/i,
      /connection failed/i,
      /error while reading the server response/i,
      /request timed out/i,
      /high demand/i,
      /hard cap exceeded/i,
      /unexpected status 5\d\d/i,
    ],
    outcome: 'error',
    kind: 'transient',
    code: 'codex_transient',
    label: 'Codex request failed temporarily',
  },
];

interface ConditionRule {
  kind: ErrorKind;
  code: string;
  label: string;
  action?: string;
}

const CONDITION_RULES: Record<CodexRunnerCondition, ConditionRule> = {
  timeout: { kind: 'transient', code: 'codex_timeout', label: 'Codex exec exceeded its deadline and was interrupted' },
  hard_cap_exceeded: { kind: 'transient', code: 'codex_hard_cap', label: 'Concurrent agent hard cap exceeded before Codex could start' },
  not_executable: { kind: 'setup_required', code: 'codex_not_executable', label: 'Codex binary is missing or not executable', action: ACTION_INSTALL },
  resolution_failed: { kind: 'setup_required', code: 'codex_not_found', label: 'Codex binary could not be resolved', action: ACTION_INSTALL },
  spawn_failed: { kind: 'setup_required', code: 'codex_spawn_failed', label: 'Codex process could not be started', action: ACTION_INSTALL },
  lockdown_breach: {
    kind: 'setup_required',
    code: 'codex_lockdown_breach',
    label: 'Codex observer attempted a forbidden tool call more than once',
    action: 'See observer-audit.log; the provider stays disabled until the self-check passes again.',
  },
  version_untested: {
    kind: 'setup_required',
    code: 'codex_version_untested',
    label: 'Codex CLI version is outside the tested range',
    action: 'Install a tested Codex CLI version or set CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION=true.',
  },
  model_needs_newer_cli: {
    kind: 'setup_required',
    code: 'codex_model_needs_newer_cli',
    label: 'The selected Codex model needs a newer Codex CLI',
    action: 'Update the Codex CLI to a tested version, or select another CLAUDE_MEM_CODEX_MODEL (or CLAUDE_MEM_CODEX_SUMMARY_MODEL).',
  },
  self_check_failed: { kind: 'setup_required', code: 'codex_self_check_failed', label: 'Codex lockdown self-check failed', action: ACTION_INVOCATION },
  api_key_login: { kind: 'setup_required', code: 'codex_api_key_login', label: 'Codex is logged in with an API key, not ChatGPT', action: ACTION_LOGIN },
  stream_truncated: {
    kind: 'setup_required',
    code: 'codex_stream_truncated',
    label: 'Codex stdout passed the JSONL cap, so the runtime tool guard stopped inspecting the stream',
    action: 'See observer-audit.log and the worker log; a turn this large is not a normal observer turn.',
  },
  missing_turn_completed: { kind: 'transient', code: 'codex_missing_turn_completed', label: 'Codex exited without turn.completed' },
  missing_agent_message: { kind: 'transient', code: 'codex_missing_agent_message', label: 'Codex produced output but no agent_message' },
};

const DEFINITIVE_CONDITIONS: ReadonlySet<CodexRunnerCondition> = new Set([
  'timeout',
  'hard_cap_exceeded',
  'not_executable',
  'resolution_failed',
  'spawn_failed',
  'lockdown_breach',
  'version_untested',
  'model_needs_newer_cli',
  'self_check_failed',
  'api_key_login',
  'stream_truncated',
]);

function nowMsOf(input: CodexErrorInput): number {
  if (input.now === undefined) return Date.now();
  return typeof input.now === 'number' ? input.now : input.now.getTime();
}

function diagnosticCause(rule: string, input: CodexErrorInput): Error {
  const exit = typeof input.exitCode === 'number' ? `exit=${input.exitCode}` : 'exit=none';
  const signal = input.signal ? `, terminated by ${input.signal}` : '';
  return new Error(`codex exec failure (rule=${rule}, ${exit}${signal})`);
}

function buildError(
  rule: string,
  spec: { kind: ErrorKind; code: string; label: string; action?: string },
  input: CodexErrorInput,
  excerpt: string,
  retryAfterMs?: number,
): ClassifiedProviderError {
  const message = neutralizeKillMarkers(excerpt ? `${spec.label}: ${excerpt}` : spec.label);
  return new ClassifiedProviderError(message, {
    kind: spec.kind,
    cause: diagnosticCause(rule, input),
    code: spec.code,
    ...(spec.action ? { action: spec.action } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

function conditionOutcome(condition: CodexRunnerCondition, input: CodexErrorInput): CodexFailureClassification {
  const spec = CONDITION_RULES[condition];
  const excerpt = redactCodexDiagnostic(input.detail);
  return {
    type: 'error',
    error: buildError(`condition:${condition}`, spec, input, excerpt),
    rule: `condition:${condition}`,
    resumeAtMs: null,
  };
}

function textOutcome(rule: TextRule, matchedText: string, input: CodexErrorInput): CodexFailureClassification {
  if (rule.outcome === 'context_overflow') {
    return { type: 'context_overflow', content: CODEX_CONTEXT_OVERFLOW_CONTENT, rule: rule.id };
  }
  if (rule.outcome === 'content_policy') {
    return { type: 'content_policy', content: '', rule: rule.id };
  }

  const spec = { kind: rule.kind!, code: rule.code!, label: rule.label!, action: rule.action };
  const excerpt = redactCodexDiagnostic(matchedText);
  const nowMs = nowMsOf(input);

  if (rule.kind === 'quota_exhausted') {
    // Plan 3.5 defines exactly two quota outcomes: a parsed FUTURE reset time
    // (+60 s grace) or no usable time -> the 30 min default. A reset that
    // resolves into the past (limit hit late in the evening, window resetting
    // after midnight; or a stale dated form) is unusable, so it is treated
    // like an unparseable one. Clamping it to `now` instead would arm a
    // breaker that is already expired, and the M3 resume scheduler would
    // re-probe immediately - one paid exec per probe against a still
    // exhausted window.
    const resetAt = parseCodexResetTime(matchedText, nowMs, input.timeZone);
    const resumeAtMs = resetAt !== null && resetAt + CODEX_RESET_GRACE_MS > nowMs
      ? resetAt + CODEX_RESET_GRACE_MS
      : nowMs + CODEX_DEFAULT_QUOTA_RETRY_MS;
    return {
      type: 'error',
      error: buildError(rule.id, spec, input, excerpt, resumeAtMs - nowMs),
      rule: rule.id,
      resumeAtMs,
    };
  }
  if (rule.kind === 'rate_limit') {
    const resumeAtMs = nowMs + CODEX_RATE_LIMIT_RETRY_MS;
    return {
      type: 'error',
      error: buildError(rule.id, spec, input, excerpt, CODEX_RATE_LIMIT_RETRY_MS),
      rule: rule.id,
      resumeAtMs,
    };
  }
  return { type: 'error', error: buildError(rule.id, spec, input, excerpt), rule: rule.id, resumeAtMs: null };
}

/**
 * Classify a failed Codex call. Precedence: definitive runner conditions
 * (setup, timeout, hard cap) > upstream text rules (failure message first,
 * then stderr) > soft conditions (missing turn.completed / agent_message) >
 * exit status / signal fallback (transient).
 */
export function classifyCodexFailure(input: CodexErrorInput): CodexFailureClassification {
  if (input.condition && DEFINITIVE_CONDITIONS.has(input.condition)) {
    return conditionOutcome(input.condition, input);
  }

  // Bounded before any regex runs: a turn.failed message has no length limit.
  const sources = [capRawInput(input.failureMessage ?? ''), capRawInput(stripCodexStdinNotice(input.stderrTail ?? ''))]
    .filter((text) => text.trim().length > 0);
  // Source is the OUTER loop: `turn.failed.error.message` is the failure of
  // record (plan 2.7 / 3.5) and stderr is only a fallback. With the loops the
  // other way round a low-priority rule matching the authoritative message
  // would lose to a higher-priority rule matching anywhere in the stderr tail
  // (e.g. a usage limit returned as a context overflow, which recycles and
  // immediately spends another paid exec instead of arming the breaker).
  for (const text of sources) {
    for (const rule of TEXT_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        return textOutcome(rule, text, input);
      }
    }
  }

  if (input.condition) {
    return conditionOutcome(input.condition, input);
  }

  const excerpt = redactCodexDiagnostic(sources[0] ?? '');
  if (input.signal) {
    const spec = { kind: 'transient' as const, code: 'codex_terminated', label: `Codex process terminated (${input.signal})` };
    return { type: 'error', error: buildError('terminated', spec, input, excerpt), rule: 'terminated', resumeAtMs: null };
  }
  if (typeof input.exitCode === 'number' && input.exitCode !== 0) {
    const spec = { kind: 'transient' as const, code: 'codex_exit_nonzero', label: `Codex exited with status ${input.exitCode}` };
    return { type: 'error', error: buildError('exit_nonzero', spec, input, excerpt), rule: 'exit_nonzero', resumeAtMs: null };
  }
  const spec = { kind: 'transient' as const, code: 'codex_unknown_failure', label: 'Codex call failed' };
  return { type: 'error', error: buildError('unknown', spec, input, excerpt), rule: 'unknown', resumeAtMs: null };
}

/**
 * Convenience for callers that need an Error. Soft outcomes map to the custom
 * kinds 'context_overflow' / 'content_policy' (ProviderErrorClass is open);
 * the provider should prefer classifyCodexFailure and return content instead.
 */
export function classifyCodexError(input: CodexErrorInput): ClassifiedProviderError {
  const outcome = classifyCodexFailure(input);
  if (outcome.type === 'error') return outcome.error;
  const label = outcome.type === 'context_overflow' ? CODEX_CONTEXT_OVERFLOW_CONTENT : 'Codex refused the request under its content policy';
  return new ClassifiedProviderError(label, {
    kind: outcome.type,
    cause: diagnosticCause(outcome.rule, input),
    code: outcome.type === 'context_overflow' ? 'codex_context_overflow' : 'codex_content_policy',
  });
}

/** Visible (non-reasoning) output tokens; output_tokens includes reasoning in the Responses API. */
function visibleOutputTokens(result: Pick<TurnResult, 'usage'>): number {
  if (!result.usage) return 0;
  return Math.max(0, result.usage.output - result.usage.reasoning);
}

/**
 * Apply the exit-status table (plan 2.8) to a finished turn:
 *   - a tool attempt wins over everything (caller audits and returns '');
 *   - a truncated stdout stream fails CLOSED (setup_required
 *     codex_stream_truncated): past the JSONL cap the parser stops emitting
 *     events, so the L4 tool guard no longer sees the stream and the text can
 *     never be trusted as a successful turn;
 *   - our own deadline -> transient codex_timeout;
 *   - exit 0 + turn.completed + non-empty agent_message -> success;
 *   - exit 0 + turn.completed + no message and no visible output -> success ''
 *     (the observer chose to output nothing);
 *   - exit 0 without turn.completed, or visible output without a message ->
 *     transient (batch kept), unless the failure text says more;
 *   - non-zero exit or a signal -> classified by the best failure text.
 */
export function interpretCodexTurn(
  result: TurnResult,
  options: { now?: number | Date; timeZone?: string } = {},
): CodexTurnOutcome {
  if (result.toolAttempt) {
    return { type: 'tool_attempt', attempt: result.toolAttempt };
  }
  const base: CodexErrorInput = {
    failureMessage: result.failureMessage,
    stderrTail: result.stderrTail,
    exitCode: result.exitCode,
    signal: result.signal,
    now: options.now,
    timeZone: options.timeZone,
  };
  if (result.truncated) {
    return classifyCodexFailure({
      ...base,
      condition: 'stream_truncated',
      detail: `stdout passed the JSONL cap after ${result.unknownEvents} unknown events`,
    });
  }
  if (result.timedOut) {
    return classifyCodexFailure({ ...base, condition: 'timeout' });
  }

  const cleanExit = result.exitCode === 0 && !result.signal;
  if (cleanExit && result.turnCompleted) {
    if (result.text.trim().length > 0) {
      return { type: 'success', content: result.text };
    }
    if (visibleOutputTokens(result) === 0) {
      return { type: 'success', content: '' };
    }
    return classifyCodexFailure({ ...base, condition: 'missing_agent_message' });
  }
  if (cleanExit) {
    return classifyCodexFailure({ ...base, condition: 'missing_turn_completed' });
  }
  return classifyCodexFailure(base);
}
