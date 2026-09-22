import { describe, it, expect } from 'bun:test';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyCodexFailure,
  classifyCodexError,
  interpretCodexTurn,
  parseCodexResetTime,
  redactCodexDiagnostic,
  neutralizeKillMarkers,
  CODEX_CONTEXT_OVERFLOW_CONTENT,
  CODEX_DEFAULT_QUOTA_RETRY_MS,
  CODEX_RATE_LIMIT_RETRY_MS,
  CODEX_RESET_GRACE_MS,
  CODEX_ERROR_EXCERPT_CHARS,
  type CodexErrorInput,
  type CodexFailureClassification,
  type CodexRunnerCondition,
} from '../../../src/services/worker/codex/codex-errors.js';
import { parseCodexJsonl, CODEX_STDIN_NOTICE } from '../../../src/services/worker/codex/codex-jsonl.js';
import type { TurnResult } from '../../../src/services/worker/codex/codex-transport.js';
import { isClassified } from '../../../src/services/worker/provider-errors.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'codex');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

// 2026-09-21T10:00:00Z = 13:00 in Europe/Istanbul (UTC+3 all year).
const NOW = Date.parse('2026-09-21T10:00:00Z');
const IST = 'Europe/Istanbul';

function expectError(outcome: CodexFailureClassification) {
  if (outcome.type !== 'error') throw new Error(`expected an error outcome, got ${outcome.type}`);
  return outcome;
}

function classify(input: CodexErrorInput) {
  return classifyCodexFailure({ now: NOW, timeZone: IST, ...input });
}

describe('parseCodexResetTime', () => {
  it('resolves the same-day form on the local date of `now`', () => {
    expect(parseCodexResetTime('... or try again at 3:45 PM.', NOW, IST)).toBe(Date.parse('2026-09-21T12:45:00Z'));
    expect(parseCodexResetTime('Try again at 12:05 AM.', NOW, IST)).toBe(Date.parse('2026-09-20T21:05:00Z'));
    expect(parseCodexResetTime('try again at 12:30 pm', NOW, IST)).toBe(Date.parse('2026-09-21T09:30:00Z'));
  });

  it('resolves the dated form with any ordinal suffix', () => {
    expect(parseCodexResetTime('or try again at Sep 22nd, 2026 9:05 AM.', NOW, IST)).toBe(Date.parse('2026-09-22T06:05:00Z'));
    expect(parseCodexResetTime('Try again at Oct 1st, 2026 11:59 PM.', NOW, IST)).toBe(Date.parse('2026-10-01T20:59:00Z'));
    expect(parseCodexResetTime('Try again at Oct 3rd, 2026 1:00 AM.', NOW, IST)).toBe(Date.parse('2026-10-02T22:00:00Z'));
    expect(parseCodexResetTime('Try again at Oct 24th, 2026 6:00 PM.', NOW, IST)).toBe(Date.parse('2026-10-24T15:00:00Z'));
  });

  it('honours DST in zones that have it', () => {
    const NY = 'America/New_York';
    expect(parseCodexResetTime('Try again at Jan 15th, 2027 9:00 AM.', NOW, NY)).toBe(Date.parse('2027-01-15T14:00:00Z'));
    expect(parseCodexResetTime('Try again at Jul 4th, 2026 9:00 AM.', NOW, NY)).toBe(Date.parse('2026-07-04T13:00:00Z'));
    // Same-day in NY: NOW is 06:00 EDT on Sep 21.
    expect(parseCodexResetTime('Try again at 3:45 PM.', NOW, NY)).toBe(Date.parse('2026-09-21T19:45:00Z'));
    expect(parseCodexResetTime('Try again at 3:45 PM.', NOW, 'UTC')).toBe(Date.parse('2026-09-21T15:45:00Z'));
  });

  it('folds a same-day time back one day when parsed just after local midnight', () => {
    const justAfterMidnight = Date.parse('2026-09-21T21:00:30Z'); // 00:00:30 on Sep 22 in Istanbul
    expect(parseCodexResetTime('Try again at 11:59 PM.', justAfterMidnight, IST)).toBe(Date.parse('2026-09-21T20:59:00Z'));
    // A legitimate same-day time later today is kept.
    expect(parseCodexResetTime('Try again at 1:00 AM.', justAfterMidnight, IST)).toBe(Date.parse('2026-09-21T22:00:00Z'));
  });

  it('returns null for "later", impossible times, impossible dates and unknown zones', () => {
    expect(parseCodexResetTime("You've hit your usage limit. Try again later.", NOW, IST)).toBeNull();
    expect(parseCodexResetTime('Try again at 13:45 PM.', NOW, IST)).toBeNull();
    expect(parseCodexResetTime('Try again at 3:75 PM.', NOW, IST)).toBeNull();
    expect(parseCodexResetTime('Try again at Feb 30th, 2026 9:00 AM.', NOW, IST)).toBeNull();
    expect(parseCodexResetTime('Try again at 3:45 PM.', NOW, 'Not/AZone')).toBeNull();
    expect(parseCodexResetTime('', NOW, IST)).toBeNull();
  });

  it('uses the process zone when no zone is given', () => {
    const expected = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate(), 15, 45).getTime();
    expect(parseCodexResetTime('Try again at 3:45 PM.', NOW)).toBe(expected);
  });
});

describe('classifyCodexFailure: quota and rate limits', () => {
  it('maps a same-day usage limit to quota_exhausted with reset + 60 s', () => {
    const summary = parseCodexJsonl(fixture('synthetic-usage-limit-same-day.jsonl'));
    const outcome = expectError(classify({ failureMessage: summary.failureMessage, exitCode: 1 }));
    const resumeAt = Date.parse('2026-09-21T12:45:00Z') + CODEX_RESET_GRACE_MS;
    expect(outcome.rule).toBe('usage_limit');
    expect(outcome.error.kind).toBe('quota_exhausted');
    expect(outcome.error.code).toBe('codex_usage_limit');
    expect(outcome.resumeAtMs).toBe(resumeAt);
    expect(outcome.error.retryAfterMs).toBe(resumeAt - NOW);
    expect(outcome.error.message).toContain("You've hit your usage limit");
    expect(outcome.error.message).toContain('3:45 PM');
  });

  it('maps a usage limit on another day to that date', () => {
    const summary = parseCodexJsonl(fixture('synthetic-usage-limit-other-day.jsonl'));
    const outcome = expectError(classify({ failureMessage: summary.failureMessage, exitCode: 1 }));
    expect(outcome.resumeAtMs).toBe(Date.parse('2026-09-22T06:05:00Z') + CODEX_RESET_GRACE_MS);
  });

  it('falls back to 30 minutes when no reset time is given or parseable', () => {
    const later = expectError(classify({ failureMessage: "You've hit your usage limit. Try again later.", exitCode: 1 }));
    expect(later.error.kind).toBe('quota_exhausted');
    expect(later.resumeAtMs).toBe(NOW + CODEX_DEFAULT_QUOTA_RETRY_MS);
    expect(later.error.retryAfterMs).toBe(CODEX_DEFAULT_QUOTA_RETRY_MS);
    const badZone = expectError(classifyCodexFailure({ failureMessage: 'Usage limit reached. Try again at 3:45 PM.', now: NOW, timeZone: 'Bad/Zone' }));
    expect(badZone.resumeAtMs).toBe(NOW + CODEX_DEFAULT_QUOTA_RETRY_MS);
  });

  it('falls back to 30 minutes when the reset time resolves into the past', () => {
    // Same-day wording whose local time already passed on NOW's date: a window
    // that resets after midnight produces exactly this. Clamping it to `now`
    // would arm an already-expired breaker and the M3 resume scheduler would
    // re-probe immediately, spending a paid exec per probe.
    const sameDay = expectError(classify({ failureMessage: "You've hit your usage limit. Try again at 11:30 AM.", exitCode: 1 }));
    expect(sameDay.resumeAtMs).toBe(NOW + CODEX_DEFAULT_QUOTA_RETRY_MS);
    expect(sameDay.error.retryAfterMs).toBe(CODEX_DEFAULT_QUOTA_RETRY_MS);

    const stale = expectError(classify({ failureMessage: "You've hit your usage limit. Try again at Sep 21st, 2026 9:05 AM.", exitCode: 1 }));
    expect(stale.resumeAtMs).toBe(NOW + CODEX_DEFAULT_QUOTA_RETRY_MS);
    expect(stale.error.retryAfterMs).toBe(CODEX_DEFAULT_QUOTA_RETRY_MS);

    // Never a zero pause, whichever wording produced the unusable time.
    for (const outcome of [sameDay, stale]) {
      expect(outcome.error.kind).toBe('quota_exhausted');
      expect(outcome.resumeAtMs).toBeGreaterThan(NOW);
    }
  });

  it('prefers the turn.failed message over a higher-priority phrase in stderr', () => {
    // turn.failed.error.message is the failure of record (plan 2.7 / 3.5). With
    // the rule loop outside the source loop the overflow phrase in stderr won
    // and the quota exhaustion came back as CONTENT: no breaker, and the
    // recycle branch immediately spends another paid exec.
    const outcome = expectError(classify({
      failureMessage: "You've hit your usage limit. Try again at 3:45 PM.",
      stderrTail: "codex: ran out of room in the model's context window\n",
      exitCode: 1,
    }));
    expect(outcome.error.kind).toBe('quota_exhausted');
    expect(outcome.rule).toBe('usage_limit');

    // The mirror case still classifies from stderr when turn.failed is silent.
    const fromStderr = classifyCodexFailure({
      failureMessage: null,
      stderrTail: "ran out of room in the model's context window",
      exitCode: 1,
      now: NOW,
      timeZone: IST,
    });
    expect(fromStderr.type).toBe('context_overflow');
  });

  it('recognises every quota wording, including a model-specific limit', () => {
    for (const message of [
      "You've hit your usage limit for GPT-5.6-Sol. Switch to another model now, or try again at 4:10 PM.",
      'You’ve hit your usage limit. Try again later.',
      'Usage limit reached.',
      'Your workspace is out of credits.',
      'You are out of credits.',
      "You've hit your spend cap for this month.",
      'Quota exceeded. Check your plan and billing details.',
    ]) {
      expect(expectError(classify({ failureMessage: message, exitCode: 1 })).error.kind).toBe('quota_exhausted');
    }
  });

  it('maps 429-after-retries and model capacity to a 30 minute rate_limit breaker', () => {
    for (const message of [
      'exceeded retry limit, last status: 429 Too Many Requests',
      'Selected model is at capacity. Please try a different model.',
    ]) {
      const outcome = expectError(classify({ failureMessage: message, exitCode: 1 }));
      expect(outcome.error.kind).toBe('rate_limit');
      expect(outcome.error.retryAfterMs).toBe(CODEX_RATE_LIMIT_RETRY_MS);
      expect(outcome.resumeAtMs).toBe(NOW + CODEX_RATE_LIMIT_RETRY_MS);
    }
  });
});

describe('classifyCodexFailure: plan, auth, setup, transient', () => {
  it('treats the plan mismatch as setup_required, not quota', () => {
    for (const input of [
      { failureMessage: 'To use Codex with your ChatGPT plan, upgrade to Plus: https://openai.com/chatgpt/pricing.' },
      { failureMessage: 'unexpected status 403 Forbidden: {"error":{"type":"usage_not_included"}}' },
      { stderrTail: `${CODEX_STDIN_NOTICE}\nError: usage_not_included` },
    ]) {
      const outcome = expectError(classify({ ...input, exitCode: 1 }));
      expect(outcome.error.kind).toBe('setup_required');
      expect(outcome.error.code).toBe('codex_plan_not_included');
      expect(outcome.error.action).toMatch(/upgrade|provider/i);
      expect(outcome.resumeAtMs).toBeNull();
    }
  });

  it('maps login failures to auth_invalid with a codex login action', () => {
    const summary = parseCodexJsonl(fixture('synthetic-auth-failed.jsonl'));
    for (const message of [
      summary.failureMessage!,
      'Please sign in again.',
      'Not logged in. Run codex login.',
      'unexpected status 401 Unauthorized',
    ]) {
      const outcome = expectError(classify({ failureMessage: message, exitCode: 1 }));
      expect(outcome.error.kind).toBe('auth_invalid');
      expect(outcome.error.action).toContain('codex login');
    }
  });

  it('maps an API-key login to setup_required', () => {
    const outcome = expectError(classify({ stderrTail: 'Logged in using an API key - sk-proj-abcdefghijklmnopqrstuvwxyz0123', exitCode: 1 }));
    expect(outcome.error.kind).toBe('setup_required');
    expect(outcome.error.code).toBe('codex_api_key_login');
    expect(outcome.error.message).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('maps rejected invocations (bad -c, unknown feature, bad model, clap errors) to setup_required', () => {
    for (const stderrTail of [
      'Error parsing -c overrides: invalid TOML value',
      'Error: Unknown feature flag: shell_toool',
      "error: unexpected argument '--foo' found",
      "error: invalid value 'x' for '--sandbox <SANDBOX_MODE>'",
      "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
      'unexpected status 400 Bad Request: Instructions are not valid',
    ]) {
      const outcome = expectError(classify({ stderrTail: `${CODEX_STDIN_NOTICE}\n${stderrTail}`, exitCode: 1 }));
      expect(outcome.error.kind).toBe('setup_required');
      expect(outcome.error.code).toBe('codex_invocation_rejected');
    }
  });

  it('maps upstream hiccups to transient', () => {
    for (const message of [
      'stream disconnected before completion: error sending request',
      'Connection failed: error sending request for url',
      'Error while reading the server response',
      'request timed out',
      "We're currently experiencing high demand, which may cause temporary errors.",
      'Hard cap exceeded: 3 active agents',
      'unexpected status 503 Service Unavailable',
    ]) {
      const outcome = expectError(classify({ failureMessage: message, exitCode: 1 }));
      expect(outcome.error.kind).toBe('transient');
      expect(outcome.rule).toBe('transient_upstream');
    }
  });

  it('returns overflow as content and a content-policy refusal as an empty batch', () => {
    const summary = parseCodexJsonl(fixture('synthetic-context-overflow.jsonl'));
    const overflow = classify({ failureMessage: summary.failureMessage, exitCode: 1 });
    expect(overflow).toEqual({ type: 'context_overflow', content: CODEX_CONTEXT_OVERFLOW_CONTENT, rule: 'context_overflow' });
    expect(/\bran out of room in the model'?s context window\b/.test(CODEX_CONTEXT_OVERFLOW_CONTENT)).toBe(true);
    const policy = classify({ failureMessage: 'This request has been flagged for possible cybersecurity risk.', exitCode: 1 });
    expect(policy).toEqual({ type: 'content_policy', content: '', rule: 'content_policy' });
  });
});

describe('classifyCodexFailure: runner conditions and precedence', () => {
  const expected: Record<CodexRunnerCondition, [string, string]> = {
    timeout: ['transient', 'codex_timeout'],
    hard_cap_exceeded: ['transient', 'codex_hard_cap'],
    not_executable: ['setup_required', 'codex_not_executable'],
    resolution_failed: ['setup_required', 'codex_not_found'],
    spawn_failed: ['setup_required', 'codex_spawn_failed'],
    lockdown_breach: ['setup_required', 'codex_lockdown_breach'],
    version_untested: ['setup_required', 'codex_version_untested'],
    self_check_failed: ['setup_required', 'codex_self_check_failed'],
    api_key_login: ['setup_required', 'codex_api_key_login'],
    missing_turn_completed: ['transient', 'codex_missing_turn_completed'],
    missing_agent_message: ['transient', 'codex_missing_agent_message'],
  };

  it('maps every condition to its kind and code', () => {
    for (const [condition, [kind, code]] of Object.entries(expected)) {
      const outcome = expectError(classify({ condition: condition as CodexRunnerCondition }));
      expect(outcome.error.kind).toBe(kind);
      expect(outcome.error.code).toBe(code);
      expect(isClassified(outcome.error)).toBe(true);
    }
  });

  it('definitive conditions win over upstream text; soft conditions lose to it', () => {
    const quotaText = "You've hit your usage limit. Try again at 3:45 PM.";
    expect(expectError(classify({ condition: 'timeout', failureMessage: quotaText })).error.code).toBe('codex_timeout');
    expect(expectError(classify({ condition: 'spawn_failed', stderrTail: quotaText })).error.code).toBe('codex_spawn_failed');
    expect(expectError(classify({ condition: 'missing_turn_completed', failureMessage: quotaText })).error.kind).toBe('quota_exhausted');
  });

  it('falls back to transient on an unexplained exit status or signal', () => {
    const exit = expectError(classify({ exitCode: 2, stderrTail: `${CODEX_STDIN_NOTICE}\n` }));
    expect(exit.error.kind).toBe('transient');
    expect(exit.error.code).toBe('codex_exit_nonzero');
    expect(exit.error.message).not.toContain('Reading additional input');
    const signalled = expectError(classify({ signal: 'SIGKILL', exitCode: null }));
    expect(signalled.error.code).toBe('codex_terminated');
    expect(expectError(classify({})).error.code).toBe('codex_unknown_failure');
  });
});

describe('redaction and kill markers', () => {
  it('never copies home paths, emails, keys, tokens or URL queries into message or cause', () => {
    const home = homedir();
    const secretText =
      `stream disconnected at ${home}/.codex/auth.json for user@example.com ` +
      'key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX012345 Bearer abcdefghijklmnop1234 ' +
      'https://chatgpt.com/backend-api/codex?token=supersecretvalue123 ' +
      'thread 01a0c399-0366-7850-a458-1ddf3e786ae9';
    for (const input of [{ failureMessage: secretText }, { stderrTail: secretText }, { condition: 'self_check_failed' as const, detail: secretText }]) {
      const outcome = expectError(classify({ ...input, exitCode: 1 }));
      const surfaces = [outcome.error.message, String((outcome.error.cause as Error).message)];
      for (const surface of surfaces) {
        expect(surface).not.toContain(home);
        expect(surface).not.toContain('user@example.com');
        expect(surface).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX012345');
        expect(surface).not.toContain('abcdefghijklmnop1234');
        expect(surface).not.toContain('supersecretvalue123');
        expect(surface).not.toContain('01a0c399-0366-7850-a458-1ddf3e786ae9');
      }
    }
  });

  it('keeps the cause a fixed diagnostic string without upstream text', () => {
    const outcome = expectError(classify({ failureMessage: 'Please sign in again. secret-detail', exitCode: 1 }));
    const cause = (outcome.error.cause as Error).message;
    expect(cause).toBe('codex exec failure (rule=auth_invalid, exit=1)');
  });

  it('caps the excerpt length', () => {
    const outcome = expectError(classify({ failureMessage: `stream disconnected ${'word '.repeat(500)}`, exitCode: 1 }));
    expect(outcome.error.message.length).toBeLessThanOrEqual('Codex request failed temporarily: '.length + CODEX_ERROR_EXCERPT_CHARS + 3);
    expect(redactCodexDiagnostic('x'.repeat(1000)).length).toBeLessThanOrEqual(CODEX_ERROR_EXCERPT_CHARS + 3);
  });

  it('no message or cause ever contains "code 143" or "signal SIGTERM"', () => {
    const texts = [
      'process exited with code 143',
      'killed by signal SIGTERM',
      "You've hit your usage limit (code 143). Try again later.",
      'stream disconnected: signal SIGTERM received',
      '',
    ];
    const conditions: Array<CodexRunnerCondition | undefined> = [undefined, 'timeout', 'spawn_failed', 'missing_turn_completed'];
    for (const text of texts) {
      for (const condition of conditions) {
        for (const signal of [null, 'SIGTERM', 'SIGKILL']) {
          for (const exitCode of [null, 0, 1, 143]) {
            const input: CodexErrorInput = { failureMessage: text, stderrTail: text, condition, signal, exitCode, detail: text };
            const error = classifyCodexError({ now: NOW, timeZone: IST, ...input });
            for (const surface of [error.message, String((error.cause as Error).message)]) {
              expect(surface).not.toContain('code 143');
              expect(surface).not.toContain('signal SIGTERM');
            }
          }
        }
      }
    }
    expect(neutralizeKillMarkers('code 143 / signal SIGTERM')).toBe('exit status 143 / SIGTERM');
  });
});

describe('classifyCodexError', () => {
  it('returns the classified error, and custom kinds for the soft outcomes', () => {
    expect(classifyCodexError({ failureMessage: 'Please sign in again.' }).kind).toBe('auth_invalid');
    expect(classifyCodexError({ failureMessage: "ran out of room in the model's context window" }).kind).toBe('context_overflow');
    expect(classifyCodexError({ failureMessage: 'flagged for possible cybersecurity risk' }).kind).toBe('content_policy');
  });
});

describe('interpretCodexTurn (plan 2.8 exit table)', () => {
  function turn(fixtureName: string, overrides: Partial<TurnResult> = {}): TurnResult {
    const summary = parseCodexJsonl(fixture(fixtureName));
    return {
      threadId: summary.threadId,
      text: summary.content,
      usage: summary.usage,
      turnCompleted: summary.turnCompleted,
      failureMessage: summary.failureMessage,
      nonFatalErrors: summary.nonFatalErrors,
      toolAttempt: summary.toolAttempts[0] ?? null,
      todoObservations: summary.todoObservations,
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      unknownEvents: 0,
      stderrTail: CODEX_STDIN_NOTICE,
      durationMs: 1000,
      ...overrides,
    };
  }
  const opts = { now: NOW, timeZone: IST };

  it('exit 0 + turn.completed + message -> success', () => {
    expect(interpretCodexTurn(turn('p0-success-trivial.jsonl'), opts)).toEqual({ type: 'success', content: '<ok/>' });
    expect(interpretCodexTurn(turn('synthetic-reconnect-then-success.jsonl'), opts)).toEqual({ type: 'success', content: '<ok/>' });
    expect(interpretCodexTurn(turn('synthetic-todo-list.jsonl'), opts)).toEqual({ type: 'success', content: '<ok/>' });
    expect(interpretCodexTurn(turn('synthetic-error-item.jsonl'), opts)).toEqual({ type: 'success', content: '<ok/>' });
  });

  it('exit 0 + turn.completed + no message and only reasoning output -> empty success', () => {
    expect(interpretCodexTurn(turn('synthetic-empty-by-choice.jsonl'), opts)).toEqual({ type: 'success', content: '' });
  });

  it('visible output without a message, or no turn.completed, is transient', () => {
    const noMessage = expectError(interpretCodexTurn(turn('synthetic-no-agent-message.jsonl'), opts) as CodexFailureClassification);
    expect(noMessage.error.code).toBe('codex_missing_agent_message');
    const noTurn = expectError(interpretCodexTurn(turn('synthetic-no-turn-completed.jsonl'), opts) as CodexFailureClassification);
    expect(noTurn.error.code).toBe('codex_missing_turn_completed');
  });

  it('a tool attempt wins over everything', () => {
    const outcome = interpretCodexTurn(turn('synthetic-tool-attempt-command.jsonl'), opts);
    expect(outcome.type).toBe('tool_attempt');
  });

  it('a truncated stream fails closed, even on an otherwise clean successful turn', () => {
    // Past the JSONL cap the parser stops emitting events, so the L4 guard no
    // longer sees the stream: the text can never settle as a success.
    const outcome = expectError(
      interpretCodexTurn(turn('p0-success-trivial.jsonl', { truncated: true, unknownEvents: 2 }), opts) as CodexFailureClassification,
    );
    expect(outcome.error.kind).toBe('setup_required');
    expect(outcome.error.code).toBe('codex_stream_truncated');
    expect(outcome.rule).toBe('condition:stream_truncated');

    // It also beats an upstream text rule that would otherwise recycle.
    const overflow = expectError(
      interpretCodexTurn(turn('synthetic-context-overflow.jsonl', { exitCode: 1, truncated: true }), opts) as CodexFailureClassification,
    );
    expect(overflow.error.code).toBe('codex_stream_truncated');
  });

  it('exit 1 is classified from the failure text; our timeout is transient', () => {
    const quota = expectError(interpretCodexTurn(turn('synthetic-usage-limit-same-day.jsonl', { exitCode: 1 }), opts) as CodexFailureClassification);
    expect(quota.error.kind).toBe('quota_exhausted');
    const overflow = interpretCodexTurn(turn('synthetic-context-overflow.jsonl', { exitCode: 1 }), opts);
    expect(overflow.type).toBe('context_overflow');
    const timeout = expectError(interpretCodexTurn(turn('p0-success-trivial.jsonl', { timedOut: true, exitCode: null, signal: 'SIGKILL' }), opts) as CodexFailureClassification);
    expect(timeout.error.code).toBe('codex_timeout');
    const killed = expectError(interpretCodexTurn(turn('synthetic-no-turn-completed.jsonl', { exitCode: null, signal: 'SIGTERM' }), opts) as CodexFailureClassification);
    expect(killed.error.kind).toBe('transient');
    expect(killed.error.message).not.toContain('signal SIGTERM');
  });
});
