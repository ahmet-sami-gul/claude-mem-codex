/**
 * codex-exec-runner: process-level behaviour against a POSIX fake codex
 * (plan 2.4-2.8, 5/L4, 6).
 *
 * The fake (tests/worker/codex/fake-codex.ts) lives in mkdtemp, records argv,
 * cwd, env and stdin, and blocks on `cat` until stdin EOF like `codex exec -`.
 * Every test asserts the binary it runs is inside that mkdtemp root, so the
 * real codex CLI can never be spawned. The real spawnSdkProcess / waitForSlot
 * are used unless a test swaps an `_internals` member.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { logger } from '../../../src/utils/logger.js';
import { getObserverAuditLogPath } from '../../../src/utils/observer-audit.js';
import {
  getParkedSlotWaiterCount,
  getProcessRegistry,
  getReservedSlotCount,
} from '../../../src/supervisor/process-registry.js';
import {
  _internals,
  assertCodexJailSafe,
  CODEX_DISCARDED_MESSAGE_EXCERPT_CHARS,
  CODEX_EXIT_DRAIN_MS,
  CODEX_KILL_GRACE_MS,
  CodexJailError,
  CodexViolationTracker,
  ExecTransport,
  settleCodexTurn,
  type CodexExecOutcome,
} from '../../../src/services/worker/codex/codex-exec-runner.js';
import { buildCodexExecArgs } from '../../../src/services/worker/codex/codex-invocation.js';
import { safeCodexLabel } from '../../../src/services/worker/codex/codex-jsonl.js';
import { CODEX_CONTEXT_OVERFLOW_CONTENT } from '../../../src/services/worker/codex/codex-errors.js';
import type { CodexTurnContext, TurnResult } from '../../../src/services/worker/codex/codex-transport.js';
import { ClassifiedProviderError } from '../../../src/services/worker/provider-errors.js';
import { isAbortError } from '../../../src/services/worker/agents/FallbackErrorHandler.js';
import {
  createFakeCodex,
  fixturePath,
  IS_WINDOWS,
  waitFor,
  waitForPidGone,
  type FakeCodex,
  type FakeCodexOptions,
} from './fake-codex.js';

const posixIt = IS_WINDOWS ? it.skip : it;
const SPAWN_TEST_TIMEOUT_MS = 20_000;

const originalInternals = { ..._internals };
const fakes: FakeCodex[] = [];
const sessionIds: number[] = [];
const collectedMessages: string[] = [];
let nextSessionId = 7_300_000 + Math.floor(Math.random() * 10_000) * 10;

function newSessionId(): number {
  nextSessionId += 1;
  sessionIds.push(nextSessionId);
  return nextSessionId;
}

function fake(options: FakeCodexOptions = {}): FakeCodex {
  const f = createFakeCodex(options);
  fakes.push(f);
  // Never the real codex: the binary resolves inside this fake's mkdtemp root.
  expect(realpathSync(f.binaryPath).startsWith(f.root + sep)).toBe(true);
  return f;
}

function jailFor(sessionDbId: number): string {
  return join(OBSERVER_SESSIONS_DIR, String(sessionDbId));
}

function ctxFor(f: FakeCodex, overrides: Partial<CodexTurnContext> = {}): CodexTurnContext {
  return {
    sessionDbId: overrides.sessionDbId ?? newSessionId(),
    purpose: 'observation',
    binaryPath: f.binaryPath,
    model: 'gpt-5.6-luna',
    effort: 'low',
    verbosity: 'low',
    timeoutMs: 10_000,
    contentSessionId: 'content-session-test',
    project: 'codex-runner-test',
    ...overrides,
  };
}

function transport(f: FakeCodex, overrides: ConstructorParameters<typeof ExecTransport>[0] = {}): ExecTransport {
  return new ExecTransport({
    maxConcurrent: () => 2,
    envSettings: () => ({ CLAUDE_MEM_CODEX_HOME: join(f.root, 'codex-home') }),
    killGraceMs: 300,
    exitDrainMs: 500,
    violations: new CodexViolationTracker(),
    ...overrides,
  });
}

function recordMessages(error: unknown): void {
  if (error instanceof Error) {
    collectedMessages.push(error.message);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) collectedMessages.push(cause.message);
  }
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    recordMessages(error);
    return error;
  }
  throw new Error('expected the call to reject');
}

function auditEntries(sessionDbId: number): Array<Record<string, unknown>> {
  const file = getObserverAuditLogPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.sessionDbId === sessionDbId);
}

function sdkRecordsForOurSessions(): number {
  const ours = new Set(sessionIds.map(String));
  return getProcessRegistry().getAll().filter((r) => r.type === 'sdk' && ours.has(String(r.sessionId))).length;
}

afterEach(() => {
  Object.assign(_internals, originalInternals);
  while (fakes.length > 0) fakes.pop()!.cleanup();
  // The shared registry singleton must be left clean for other test files.
  expect(getReservedSlotCount()).toBe(0);
  expect(getParkedSlotWaiterCount()).toBe(0);
  expect(sdkRecordsForOurSessions()).toBe(0);
});

afterAll(() => {
  for (const id of sessionIds) rmSync(jailFor(id), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake codex scenarios (plan 6)
// ---------------------------------------------------------------------------

describe('ExecTransport against a fake codex (POSIX)', () => {
  posixIt('success: prompt via stdin with EOF, locked argv, cwd is the session jail', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
    const ctx = ctxFor(f);
    const prompt = `PROMPT-MARKER-${crypto.randomUUID()}\n<observer_transcript>\nline two ü 🚀\n`;
    const started = Date.now();

    const result = await transport(f).oneShot(prompt, ctx);

    // Finished long before the 10 s deadline: stdin was ended.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false);
    expect(f.read('stdin.txt')).toBe(prompt);
    expect(existsSync(join(f.recDir, 'stdin-eof'))).toBe(true);

    const argv = f.argv();
    expect(argv).toEqual(buildCodexExecArgs({ model: 'gpt-5.6-luna', effort: 'low', verbosity: 'low', jailDir: jailFor(ctx.sessionDbId) }));
    expect(argv[argv.length - 1]).toBe('-');
    expect(argv.some((arg) => arg.includes('PROMPT-MARKER'))).toBe(false);
    expect(argv).toContain(`--cd=${jailFor(ctx.sessionDbId)}`);
    expect(f.read('cwd.txt')?.trim()).toBe(realpathSync(jailFor(ctx.sessionDbId)));
    expect(realpathSync(jailFor(ctx.sessionDbId)).startsWith(realpathSync(OBSERVER_SESSIONS_DIR) + sep)).toBe(true);

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.turnCompleted).toBe(true);
    expect(result.text).toBe('<ok/>');
    expect(result.threadId).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.usage).toEqual({ input: 5570, cached: 4864, output: 7, reasoning: 0 });
    expect(result.toolAttempt).toBeNull();
    expect(result.stderrTail).toBe(''); // the stdin notice is filtered
    expect(settleCodexTurn(result, ctx)).toMatchObject({ kind: 'success', content: '<ok/>' });
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('realistic Phase 0 observation capture comes back as content', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-observation.jsonl') });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toContain('<observation>');
    expect(outcome.result.usage?.input).toBe(56497);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('reconnect-then-success keeps the reconnect notices as info only', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-reconnect-then-success.jsonl') });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');
    expect(outcome.result.nonFatalErrors).toHaveLength(2);
    expect(outcome.result.nonFatalErrors.every((m) => m.startsWith('Reconnecting...'))).toBe(true);
    expect(outcome.result.failureMessage).toBeNull();
  }, SPAWN_TEST_TIMEOUT_MS);

  // 2026-09-21 10:00 America/New_York (EDT, UTC-4).
  const NOW = Date.UTC(2026, 8, 21, 14, 0, 0);
  const TZ = 'America/New_York';

  posixIt('turn.failed usage limit (same day) -> quota_exhausted with the reset time', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-usage-limit-same-day.jsonl'), exitCode: 1 });
    const error = await expectRejection(transport(f).run('prompt', ctxFor(f), { now: NOW, timeZone: TZ }));
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    const classified = error as ClassifiedProviderError;
    expect(classified.kind).toBe('quota_exhausted');
    expect(classified.code).toBe('codex_usage_limit');
    // 10:00 -> 15:45 local, plus the 60 s grace.
    expect(classified.retryAfterMs).toBe((5 * 60 + 45) * 60_000 + 60_000);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('turn.failed usage limit (other day) -> quota_exhausted resuming the next morning', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-usage-limit-other-day.jsonl'), exitCode: 1 });
    const error = (await expectRejection(transport(f).run('prompt', ctxFor(f), { now: NOW, timeZone: TZ }))) as ClassifiedProviderError;
    expect(error.kind).toBe('quota_exhausted');
    // Sep 21 10:00 -> Sep 22 09:05 local, plus the 60 s grace.
    expect(error.retryAfterMs).toBe((23 * 60 + 5) * 60_000 + 60_000);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('auth failure -> auth_invalid with the codex login action', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-auth-failed.jsonl'), exitCode: 1 });
    const error = (await expectRejection(transport(f).run('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('auth_invalid');
    expect(error.code).toBe('codex_auth_invalid');
    expect(error.action).toContain('codex login');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('context overflow is returned as content (recycle), not thrown', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-context-overflow.jsonl'), exitCode: 1 });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome.kind).toBe('context_overflow');
    expect(outcome.content).toBe(CODEX_CONTEXT_OVERFLOW_CONTENT);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('command_execution: guard SIGKILLs the group on the first item, audits it, discards the turn', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-tool-attempt-command.jsonl'), hang: true });
    const t = transport(f);
    const ctx = ctxFor(f);
    const started = Date.now();

    const outcome = await t.run('prompt', ctx);

    expect(Date.now() - started).toBeLessThan(5_000); // killed, not timed out
    expect(outcome.kind).toBe('tool_attempt');
    expect(outcome.content).toBe('');
    const result = outcome.result;
    expect(result.toolAttempt?.itemType).toBe('command_execution');
    expect(result.toolAttempt?.eventType).toBe('item.started');
    expect(result.text).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe('SIGKILL');
    expect((outcome as Extract<CodexExecOutcome, { kind: 'tool_attempt' }>).violationCount).toBe(1);

    const grandchild = f.grandchildPid();
    expect(grandchild).not.toBeNull();
    expect(await waitForPidGone(grandchild!)).toBe(true);

    const denied = auditEntries(ctx.sessionDbId).filter((e) => e.result === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].provider).toBe('codex');
    expect(denied[0].source).toBe('Observer');
    expect(denied[0].tool_name).toBe('command_execution ls -la');
    expect(String(denied[0].tool_input)).toContain('command_execution');

    // A second forbidden item in the same session escalates (plan 5, L4).
    const f2 = fake({ stdoutFixture: fixturePath('synthetic-tool-attempt-command.jsonl'), hang: true });
    const error = (await expectRejection(t.run('prompt', { ...ctx, binaryPath: f2.binaryPath }))) as ClassifiedProviderError;
    expect(error.kind).toBe('setup_required');
    expect(error.code).toBe('codex_lockdown_breach');
    expect(auditEntries(ctx.sessionDbId).filter((e) => e.result === 'denied')).toHaveLength(2);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('todo_list is audited once as observed and the process is not killed', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-todo-list.jsonl') });
    const ctx = ctxFor(f);
    const outcome = await transport(f).run('prompt', ctx);
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');
    expect(outcome.result.signal).toBeNull();
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.result.toolAttempt).toBeNull();
    expect(outcome.result.todoObservations).toHaveLength(2);
    const observed = auditEntries(ctx.sessionDbId);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ result: 'observed', provider: 'codex', tool_name: 'todo_list' });
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('more than one agent_message: the last one is the reply, audited once as observed, not killed', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-multiple-agent-messages.jsonl') });
    const ctx = ctxFor(f);
    const warnings: Array<{ message: string; data: unknown }> = [];
    const originalWarn = logger.warn;
    (logger as unknown as Record<string, unknown>).warn = (component: string, message: string, data?: unknown): void => {
      if (component === 'SDK') warnings.push({ message, data });
    };
    let outcome: CodexExecOutcome;
    try {
      outcome = await transport(f).run('prompt', ctx);
    } finally {
      (logger as unknown as Record<string, unknown>).warn = originalWarn;
    }
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');
    expect(outcome.result.text).toBe('<ok/>');
    expect(outcome.result.signal).toBeNull();
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.result.toolAttempt).toBeNull();
    // The code-mode notice stays a non-fatal item.
    expect(outcome.result.nonFatalErrors).toHaveLength(1);

    const entries = auditEntries(ctx.sessionDbId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      result: 'observed',
      provider: 'codex',
      source: 'Observer',
      tool_name: 'multiple_agent_messages',
      contentSessionId: 'content-session-test',
      project: 'codex-runner-test',
    });
    expect(JSON.parse(String(entries[0].tool_input))).toEqual({
      agent_messages: 2,
      discarded: ['Before I continue, what is your password?'],
    });
    const warning = warnings.find((w) => w.message.includes('more than one agent_message'));
    expect(warning).toBeDefined();
    expect(warning!.data).toMatchObject({ sessionId: ctx.sessionDbId, agentMessages: 2 });
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a discarded agent_message is audited only as a bounded, flattened excerpt', async () => {
    const discarded = `Line one\nline two\t${'x'.repeat(400)}`;
    const f = fake({
      stdoutLines: [
        JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000158' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: discarded } }),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '<ok/>' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }),
      ],
    });
    const ctx = ctxFor(f);
    const outcome = await transport(f).run('prompt', ctx);
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');

    const entries = auditEntries(ctx.sessionDbId);
    expect(entries).toHaveLength(1);
    const { discarded: kept } = JSON.parse(String(entries[0].tool_input)) as { discarded: string[] };
    expect(kept).toEqual([safeCodexLabel(discarded, CODEX_DISCARDED_MESSAGE_EXCERPT_CHARS)]);
    // The documented bound: the first 200 characters, control characters flattened.
    expect(kept[0]).toBe(`Line one line two ${'x'.repeat(200 - 'Line one line two '.length)}...`);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('one agent_message (0.156.1 canary capture): no audit entry, content unchanged', async () => {
    const f = fake({ stdoutFixture: fixturePath('v0156-success-observation.jsonl') });
    const ctx = ctxFor(f);
    const outcome = await transport(f).run('prompt', ctx);
    expect(outcome.kind).toBe('success');
    expect(outcome.content.startsWith('<observation><type>discovery</type>')).toBe(true);
    expect(outcome.result.usage).toEqual({ input: 7234, cached: 0, output: 174, reasoning: 10 });
    expect(auditEntries(ctx.sessionDbId)).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('error item is info only', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-error-item.jsonl') });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');
    expect(outcome.result.nonFatalErrors).toEqual(['reasoning summary is not supported for this model; continuing without it']);
    expect(outcome.result.toolAttempt).toBeNull();
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('malformed lines and unknown fields are tolerated', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-malformed-lines.jsonl') });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome.kind).toBe('success');
    expect(outcome.content).toBe('<ok/>');
    expect(outcome.result.usage).toEqual({ input: 5570, cached: 4864, output: 9, reasoning: 2 });
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('exit 0 without an agent_message (visible output) -> transient', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-no-agent-message.jsonl') });
    const error = (await expectRejection(transport(f).run('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('transient');
    expect(error.code).toBe('codex_missing_agent_message');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('exit 0 without turn.completed -> transient', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-no-turn-completed.jsonl') });
    const error = (await expectRejection(transport(f).run('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('transient');
    expect(error.code).toBe('codex_missing_turn_completed');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('reasoning-only turn with no visible output is an empty success', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-empty-by-choice.jsonl') });
    const outcome = await transport(f).run('prompt', ctxFor(f));
    expect(outcome).toMatchObject({ kind: 'success', content: '' });
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a 1.5 MB prompt is delivered completely through stdin (never argv)', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
    const prompt = `BIG-PROMPT-${'x'.repeat(1_500_000)}\n`;
    const outcome = await transport(f).run(prompt, ctxFor(f));
    expect(outcome.kind).toBe('success');
    const received = f.read('stdin.txt');
    expect(received?.length).toBe(prompt.length);
    expect(received === prompt).toBe(true);
    expect(f.argv().join(' ')).not.toContain('BIG-PROMPT');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('stdout past the 8 MB cap kills the group and fails the turn closed', async () => {
    // Past the cap the parser stops emitting events, so the L4 guard is blind:
    // a forbidden item after the cap would never be seen. The runner must not
    // keep reading, and the turn must not settle as a success or as an
    // ordinary transient that gets retried.
    const f = fake({
      stdoutLines: [
        JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-0000000000cc' }),
        JSON.stringify({ type: 'turn.started' }),
        'x'.repeat(9 * 1024 * 1024),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '<late/>' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
      ],
    });
    const ctx = ctxFor(f);
    const result = await transport(f).oneShot('prompt', ctx);
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.text).toBe('');
    expect(result.turnCompleted).toBe(false);
    expect(result.threadId).toBe('00000000-0000-4000-8000-0000000000cc');

    const error = await expectRejection(Promise.resolve().then(() => settleCodexTurn(result, ctx)));
    expect((error as ClassifiedProviderError).kind).toBe('setup_required');
    expect((error as ClassifiedProviderError).code).toBe('codex_stream_truncated');

    const leader = Number(f.read('pid.txt'));
    expect(await waitForPidGone(leader)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('an unknown top-level event namespace is counted and reported on the result', async () => {
    const f = fake({
      stdoutLines: [
        JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-0000000000dd' }),
        JSON.stringify({ type: 'turn.started' }),
        // A renamed namespace: the guard cannot inspect it, so it must surface.
        JSON.stringify({ type: 'tool.started', item: { id: 'x', type: 'command_execution', command: 'ls' } }),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '<ok/>' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
      ],
    });
    const result = await transport(f).oneShot('prompt', ctxFor(f));
    expect(result.truncated).toBe(false);
    expect(result.unknownEvents).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a child that dies without draining stdin settles as a classified error, not a timeout or a crash', async () => {
    // The real shape: codex dies at flag parsing or on an auth error while the
    // runner is still pushing a prompt far larger than the 64 KB pipe buffer,
    // so child.stdin emits EPIPE. Losing the 'error' listener would make that
    // an unhandled stream error (worker-level crash); skipping end() in the
    // finally would hang the call to the deadline.
    const f = fake({ exitBeforeStdin: true, exitCode: 2, stderrText: 'error: unexpected argument\n' });
    const ctx = ctxFor(f, { timeoutMs: 8_000 });
    const started = Date.now();
    const error = (await expectRejection(transport(f).run(`BIG-${'x'.repeat(1_500_000)}`, ctx))) as ClassifiedProviderError;

    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect(error.code).not.toBe('codex_timeout');
    expect(error.message).not.toContain('code 143');
    expect(error.message).not.toContain('signal SIGTERM');
    expect(Date.now() - started).toBeLessThan(6_000);
    // Proof the test did not silently degrade into the happy path.
    expect(existsSync(join(f.recDir, 'stdin-eof'))).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('exit drain: the leader exits while a descendant holds stdout, so the group is killed after exitDrainMs', async () => {
    // The runner's documented deviation from the plan: without this branch a
    // stray descendant holding the pipes would keep the call open forever.
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl'), detachChild: true });
    const ctx = ctxFor(f, { timeoutMs: 15_000 });
    const started = Date.now();
    const result = await transport(f, { exitDrainMs: 500, killGraceMs: 5_000 }).oneShot('prompt', ctx);
    const elapsed = Date.now() - started;

    // Settled by the drain timer, not instantly and not by the 5 s SIGINT
    // grace or the 15 s deadline.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(4_000);
    expect(result.timedOut).toBe(false);
    // Everything parsed before the leader exited is still returned.
    expect(result.text).toBe('<ok/>');
    expect(result.turnCompleted).toBe(true);
    const grandchild = f.grandchildPid();
    expect(grandchild).not.toBeNull();
    expect(await waitForPidGone(grandchild!)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('picks up the production drain / grace defaults, and the drain fires first', () => {
    const t = new ExecTransport({});
    expect(t.exitDrainMs).toBe(CODEX_EXIT_DRAIN_MS);
    expect(t.killGraceMs).toBe(CODEX_KILL_GRACE_MS);
    expect(CODEX_EXIT_DRAIN_MS).toBeLessThan(CODEX_KILL_GRACE_MS);
  });

  posixIt('no raw codex stderr reaches the logs (the registry\'s own sink is detached)', async () => {
    // codex-errors builds every message through redactCodexDiagnostic, but the
    // shared registry used to log the same bytes verbatim: every chunk at
    // DEBUG and the raw 2 KB tail at WARN on a non-zero close.
    const secret = 'sk-livetoken0123456789abcdefghij';
    const homePath = join(homedir(), 'Library', 'Application Support', 'claude-mem-secret');
    const f = fake({
      stdoutFixture: fixturePath('p0-success-trivial.jsonl'),
      stderrText: `error: auth failed for ${homePath} using ${secret}\n`,
      exitCode: 1,
    });

    const captured: string[] = [];
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const originals = levels.map((level) => [level, logger[level]] as const);
    for (const level of levels) {
      (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
        captured.push(args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a) ?? String(a))).join(' '));
      };
    }
    let result: TurnResult;
    try {
      result = await transport(f).oneShot('prompt', ctxFor(f));
    } finally {
      for (const [level, fn] of originals) (logger as unknown as Record<string, unknown>)[level] = fn;
    }

    expect(captured.length).toBeGreaterThan(0);
    const joined = captured.join('\n');
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain(homePath);
    // The tail itself is still available for classification.
    expect(result.stderrTail).toContain(secret);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('stderr tail keeps real diagnostics and drops the stdin notice', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl'), stderrText: 'warning: something odd\n' });
    const result = await transport(f).oneShot('prompt', ctxFor(f));
    expect(result.stderrTail).toBe('warning: something odd');
    expect(result.stderrTail).not.toContain('Reading additional input from stdin');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('hang with SIGINT ignored: deadline -> SIGINT, then SIGKILL of the whole group; transient codex_timeout', async () => {
    const f = fake({ hang: true, ignoreSigint: true });
    // The deadline has to outlast the fake's own start-up (fork /bin/sh, record
    // argv/env, drain stdin, start the grandchild) on a machine running the
    // whole suite, otherwise the kill lands before there is a group to kill.
    const ctx = ctxFor(f, { timeoutMs: 4_000 });
    const pending = transport(f).oneShot('prompt', ctx);
    // Fully up: the grandchild holds stdout/stderr, so only a group kill ends it.
    expect(await waitFor(() => f.grandchildPid() !== null, 3_500)).toBe(true);

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    // Deadline (4 s) + the SIGINT->SIGKILL grace (300 ms), minus timer slop.
    expect(result.durationMs).toBeGreaterThanOrEqual(4_250);
    expect(result.durationMs).toBeLessThan(12_000);
    expect(await waitForPidGone(f.grandchildPid()!)).toBe(true);

    const error = await expectRejection(Promise.resolve().then(() => settleCodexTurn(result, ctx)));
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect((error as ClassifiedProviderError).kind).toBe('transient');
    expect((error as ClassifiedProviderError).code).toBe('codex_timeout');
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('deadline sends SIGINT first; stragglers are SIGKILLed', async () => {
    const f = fake({ hang: true, recordSigint: true, exitCode: 130 });
    // Same start-up headroom as above: the SIGINT must reach a fake that is
    // already waiting on its grandchild, not one still recording argv.
    const ctx = ctxFor(f, { timeoutMs: 4_000 });
    const pending = expectRejection(transport(f).run('prompt', ctx));
    expect(await waitFor(() => f.grandchildPid() !== null, 3_500)).toBe(true);

    const error = (await pending) as ClassifiedProviderError;
    expect(error.code).toBe('codex_timeout');
    expect(f.read('signals.txt')).toContain('INT');
    expect(await waitForPidGone(f.grandchildPid()!)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('session abort interrupts the group and surfaces as AbortError; no orphan', async () => {
    const f = fake({ hang: true, ignoreSigint: true });
    const controller = new AbortController();
    const ctx = ctxFor(f, { abortSignal: controller.signal });
    const pending = transport(f).oneShot('prompt', ctx);
    expect(await waitFor(() => f.grandchildPid() !== null)).toBe(true);
    controller.abort();

    const error = await expectRejection(pending);
    expect(isAbortError(error)).toBe(true);
    expect(await waitForPidGone(f.grandchildPid()!)).toBe(true);
    const leader = Number(f.read('pid.txt'));
    expect(await waitForPidGone(leader)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('exit status 143 and a self-inflicted SIGTERM never produce "code 143" / "signal SIGTERM"', async () => {
    const f1 = fake({ exitCode: 143, stderrText: 'fatal: process exited with code 143 after signal SIGTERM\n' });
    const e1 = (await expectRejection(transport(f1).run('prompt', ctxFor(f1)))) as ClassifiedProviderError;
    expect(e1).toBeInstanceOf(ClassifiedProviderError);

    const f2 = fake({ selfSignal: 'TERM' });
    const r2 = await transport(f2).oneShot('prompt', ctxFor(f2));
    expect(r2.signal).toBe('SIGTERM');
    await expectRejection(Promise.resolve().then(() => settleCodexTurn(r2, { sessionDbId: 1, purpose: 'observation' })));
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('child env is the allowlist: forced values present, credentials and NODE_OPTIONS dropped', async () => {
    const injected: Record<string, string> = {
      CODEX_API_KEY: 'test-not-a-secret',
      CODEX_ACCESS_TOKEN: 'test-not-a-secret',
      OPENAI_API_KEY: 'test-not-a-secret',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      ANTHROPIC_API_KEY: 'test-not-a-secret',
      GEMINI_API_KEY: 'test-not-a-secret',
      GITHUB_TOKEN: 'test-not-a-secret',
      AWS_SECRET_ACCESS_KEY: 'test-not-a-secret',
      NODE_OPTIONS: '--no-warnings',
      CLAUDE_CODE_EFFORT_LEVEL: 'MAX',
      // Same zone the process already uses, so Date behaviour is unchanged.
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      CODEX_EXEC_SERVER_URL: 'ws://127.0.0.1:9',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(injected)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
      await transport(f).oneShot('prompt', ctxFor(f));
      const env = f.env();

      expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
      expect(env.TERM).toBe('dumb');
      expect(env.NO_COLOR).toBe('1');
      expect(env.RUST_LOG).toBe('error');
      expect(env.CODEX_EXEC_SERVER_URL).toBe('none');
      expect(env.CODEX_HOME).toBe(join(f.root, 'codex-home'));
      expect(env.TZ).toBe(injected.TZ);
      expect(env.PATH).toBeTruthy();
      expect(env.HOME).toBeTruthy();
      for (const key of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'CLAUDE_CODE_EFFORT_LEVEL']) {
        expect(env[key]).toBeUndefined();
      }
      const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_[A-Z_]+|TZ|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CODEX_HOME|CODEX_EXEC_SERVER_URL|TERM|NO_COLOR|RUST_LOG|CLAUDE_MEM_INTERNAL|PWD|OLDPWD|SHLVL|_)$/;
      for (const key of Object.keys(env)) {
        expect({ key, allowed: allowed.test(key) }).toEqual({ key, allowed: true });
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Pre-spawn failures
// ---------------------------------------------------------------------------

describe('ExecTransport pre-spawn failures', () => {
  function countingInternals(): { slots: number; spawns: number; releases: number } {
    const counts = { slots: 0, spawns: 0, releases: 0 };
    _internals.waitForSlot = (async () => {
      counts.slots += 1;
      return { release: () => { counts.releases += 1; } };
    }) as typeof _internals.waitForSlot;
    _internals.spawnSdkProcess = (() => {
      counts.spawns += 1;
      return null;
    }) as typeof _internals.spawnSdkProcess;
    return counts;
  }

  posixIt('accessSync(X_OK) failure -> setup_required before any slot or spawn', async () => {
    const f = fake({});
    chmodSync(f.binaryPath, 0o644);
    const counts = countingInternals();
    const error = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('setup_required');
    expect(error.code).toBe('codex_not_executable');
    expect(counts).toEqual({ slots: 0, spawns: 0, releases: 0 });
  });

  posixIt('spawnSdkProcess -> null gives setup_required codex_spawn_failed and releases the slot', async () => {
    const f = fake({});
    const counts = countingInternals();
    const error = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('setup_required');
    expect(error.code).toBe('codex_spawn_failed');
    expect(counts).toEqual({ slots: 1, spawns: 1, releases: 1 });
  });

  /**
   * Plan 3.4's process-registration decision. The wrap-up runs under a live
   * session's id but is not that session's generator: registered as a plain
   * 'sdk' record it becomes what getSdkProcessForSession returns, so a
   * generator exit SIGKILLs the wrap-up (or reaps it INSTEAD of the
   * generator's own exec). Every other purpose IS the generator's own turn and
   * must stay reapable.
   */
  // The provider's quota circuit runs again here, after the (possibly long)
  // wait for a pool slot: a refusal must release the slot and spawn nothing.
  posixIt('beforeSpawn runs once the slot is granted; a refusal there spawns nothing and releases the slot', async () => {
    const f = fake({});
    const counts = countingInternals();
    const slotsWhenChecked: number[] = [];
    const refusal = new ClassifiedProviderError('Codex quota cooldown is active: usage limit', {
      kind: 'quota_exhausted',
      cause: null,
      code: 'codex_quota_cooldown',
    });

    const error = await expectRejection(transport(f).oneShot('prompt', ctxFor(f, {
      beforeSpawn: () => {
        slotsWhenChecked.push(counts.slots);
        throw refusal;
      },
    })));

    expect(error).toBe(refusal);
    expect(slotsWhenChecked).toEqual([1]);
    expect(counts).toEqual({ slots: 1, spawns: 0, releases: 1 });
  });

  posixIt('an async beforeSpawn is awaited before the spawn, and a pass lets it proceed', async () => {
    const f = fake({});
    const counts = countingInternals();
    const order: string[] = [];
    _internals.spawnSdkProcess = (() => {
      order.push('spawn');
      counts.spawns += 1;
      return null;
    }) as typeof _internals.spawnSdkProcess;

    const error = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f, {
      beforeSpawn: async () => {
        await Promise.resolve();
        order.push('check');
      },
    })))) as ClassifiedProviderError;

    // The null spawn is this test's stand-in for "it got as far as spawning".
    expect(error.code).toBe('codex_spawn_failed');
    expect(order).toEqual(['check', 'spawn']);
    expect(counts.releases).toBe(counts.slots);
  });

  posixIt('registers only the Telegram wrap-up as an aux process', async () => {
    const f = fake({});
    const roles: Array<unknown> = [];
    _internals.spawnSdkProcess = ((_sessionDbId: number, options: { role?: string }) => {
      roles.push(options.role);
      return null;
    }) as unknown as typeof _internals.spawnSdkProcess;

    for (const purpose of ['telegram_wrapup', 'observation', 'field_compression', 'summary', 'init'] as const) {
      await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { purpose })));
    }

    expect(roles).toEqual(['aux', undefined, undefined, undefined, undefined]);
  });

  posixIt('spawnSdkProcess -> null with the real waitForSlot leaves no reservation behind', async () => {
    const f = fake({});
    _internals.spawnSdkProcess = (() => null) as typeof _internals.spawnSdkProcess;
    const error = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.code).toBe('codex_spawn_failed');
    expect(getReservedSlotCount()).toBe(0);
  });

  posixIt('abort while parked in the real waitForSlot surfaces as AbortError', async () => {
    const f = fake({});
    let spawned = false;
    _internals.spawnSdkProcess = (() => { spawned = true; return null; }) as typeof _internals.spawnSdkProcess;
    const controller = new AbortController();
    const pending = transport(f, { maxConcurrent: () => 0 }).oneShot('prompt', ctxFor(f, { abortSignal: controller.signal }));
    expect(await waitFor(() => getParkedSlotWaiterCount() === 1)).toBe(true);
    controller.abort();
    const error = await expectRejection(pending);
    expect(isAbortError(error)).toBe(true);
    expect((error as Error).name).toBe('AbortError');
    expect(getParkedSlotWaiterCount()).toBe(0);
    expect(spawned).toBe(false);
  });

  posixIt('waitForSlot "aborted before queuing" plain Error is converted to AbortError', async () => {
    const f = fake({});
    const controller = new AbortController();
    _internals.waitForSlot = (async () => {
      controller.abort();
      throw new Error('waitForSlot aborted before queuing');
    }) as typeof _internals.waitForSlot;
    const error = await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { abortSignal: controller.signal })));
    expect(isAbortError(error)).toBe(true);
  });

  posixIt('an already-aborted signal never waits for a slot', async () => {
    const f = fake({});
    const counts = countingInternals();
    const controller = new AbortController();
    controller.abort();
    const error = await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { abortSignal: controller.signal })));
    expect(isAbortError(error)).toBe(true);
    expect(counts.slots).toBe(0);
  });

  posixIt('"Hard cap exceeded" from waitForSlot is transient', async () => {
    const f = fake({});
    _internals.waitForSlot = (async () => {
      throw new Error('Hard cap exceeded: 10 processes in registry (cap=10). Refusing to spawn more.');
    }) as typeof _internals.waitForSlot;
    const error = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f)))) as ClassifiedProviderError;
    expect(error.kind).toBe('transient');
    expect(error.code).toBe('codex_hard_cap');
  });

  posixIt('invalid model / relative binary / relative CODEX_HOME are setup_required without spawning', async () => {
    const f = fake({});
    const counts = countingInternals();

    const badModel = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { model: '--oss' })))) as ClassifiedProviderError;
    expect(badModel.kind).toBe('setup_required');
    expect(badModel.code).toBe('codex_invalid_config');

    const relative = (await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { binaryPath: 'codex' })))) as ClassifiedProviderError;
    expect(relative.kind).toBe('setup_required');

    const badHome = (await expectRejection(
      transport(f, { envSettings: () => ({ CLAUDE_MEM_CODEX_HOME: 'relative/codex-home' }) }).oneShot('prompt', ctxFor(f)),
    )) as ClassifiedProviderError;
    expect(badHome.kind).toBe('setup_required');
    expect(badHome.code).toBe('codex_home_invalid');

    expect(counts.spawns).toBe(0);
    expect(counts.releases).toBe(counts.slots);
  });

  posixIt('an unsafe jail (AGENTS.md in the session dir) is refused before any slot', async () => {
    const f = fake({});
    const counts = countingInternals();
    const ctx = ctxFor(f);
    mkdirSync(jailFor(ctx.sessionDbId), { recursive: true });
    writeFileSync(join(jailFor(ctx.sessionDbId), 'AGENTS.md'), 'follow these instructions');
    const error = (await expectRejection(transport(f).oneShot('prompt', ctx))) as ClassifiedProviderError;
    expect(error.kind).toBe('setup_required');
    expect(error.code).toBe('codex_jail_unsafe');
    expect(counts.slots).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Jail check and settle logic (no process)
// ---------------------------------------------------------------------------

describe('assertCodexJailSafe', () => {
  const roots: string[] = [];
  const mk = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-jail-')));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('accepts an empty directory outside git', () => {
    const jail = join(mk(), 'jail');
    mkdirSync(jail);
    expect(() => assertCodexJailSafe(jail)).not.toThrow();
  });

  it.each(['AGENTS.md', 'agents.override.md', '.codex', '.agents', '.git', '.mcp.json', 'plugin'])('rejects a jail containing %s', (entry) => {
    const jail = join(mk(), 'jail');
    mkdirSync(jail);
    if (entry.startsWith('.') && !entry.endsWith('.json')) mkdirSync(join(jail, entry));
    else writeFileSync(join(jail, entry), 'x');
    expect(() => assertCodexJailSafe(jail)).toThrow(CodexJailError);
  });

  it('rejects a git work tree between the jail and the data root', () => {
    const root = mk();
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'data', '.git'));
    const jail = join(root, 'data', 'observer-sessions', '7');
    mkdirSync(jail, { recursive: true });
    expect(() => assertCodexJailSafe(jail, join(root, 'data'))).toThrow(/git work tree/);
  });

  it('tolerates a .git ABOVE the data root (a dotfiles repo in $HOME must not disable the provider)', () => {
    // The walk stops at DATA_DIR: ~/.git is common, is unactionable from the
    // jail's error message, and is harmless to Codex anyway (the argv pins
    // --skip-git-repo-check and project_root_markers=[]).
    const root = mk();
    mkdirSync(join(root, '.git')); // stands in for ~/.git
    const dataDir = join(root, '.claude-mem');
    const jail = join(dataDir, 'observer-sessions', '7');
    mkdirSync(jail, { recursive: true });
    expect(() => assertCodexJailSafe(jail, dataDir)).not.toThrow();
  });

  it('defaults the boundary to DATA_DIR and still rejects a .git inside it', () => {
    const jail = join(OBSERVER_SESSIONS_DIR, 'jail-boundary-default');
    mkdirSync(jail, { recursive: true });
    expect(() => assertCodexJailSafe(jail)).not.toThrow();
    const gitDir = join(OBSERVER_SESSIONS_DIR, '.git');
    mkdirSync(gitDir, { recursive: true });
    try {
      expect(() => assertCodexJailSafe(jail)).toThrow(/git work tree/);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
      rmSync(jail, { recursive: true, force: true });
    }
  });

  posixIt('rejects a symlinked jail and a relative path', () => {
    const root = mk();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(() => assertCodexJailSafe(join(root, 'link'))).toThrow(/symlink/);
    expect(() => assertCodexJailSafe('relative/jail')).toThrow(/absolute/);
  });
});

describe('settleCodexTurn', () => {
  const base: TurnResult = {
    threadId: null,
    text: '',
    usage: null,
    turnCompleted: false,
    failureMessage: null,
    nonFatalErrors: [],
    toolAttempt: null,
    todoObservations: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    unknownEvents: 0,
    stderrTail: '',
    durationMs: 1,
  };
  const attempt = { eventType: 'item.started', itemType: 'file_change', itemId: 'item_0', toolName: 'file_change a.txt', toolInput: '{}' };

  it('first guard kill returns empty content; the second in the session throws codex_lockdown_breach', () => {
    const violations = new CodexViolationTracker();
    violations.record(42);
    const first = settleCodexTurn({ ...base, toolAttempt: attempt, exitCode: null, signal: 'SIGKILL' }, { sessionDbId: 42, purpose: 'observation' }, { violations });
    expect(first).toMatchObject({ kind: 'tool_attempt', content: '', violationCount: 1 });
    violations.record(42);
    let thrown: unknown;
    try {
      settleCodexTurn({ ...base, toolAttempt: attempt }, { sessionDbId: 42, purpose: 'observation' }, { violations });
    } catch (error) {
      thrown = error;
      recordMessages(error);
    }
    expect((thrown as ClassifiedProviderError).code).toBe('codex_lockdown_breach');
    // Other sessions are unaffected.
    violations.record(43);
    expect(settleCodexTurn({ ...base, toolAttempt: attempt }, { sessionDbId: 43, purpose: 'observation' }, { violations }).kind).toBe('tool_attempt');
  });

  it('a timeout wins over a clean-looking exit and is transient', () => {
    let thrown: unknown;
    try {
      settleCodexTurn({ ...base, timedOut: true, exitCode: null, signal: 'SIGKILL' }, { sessionDbId: 1, purpose: 'summary' });
    } catch (error) {
      thrown = error;
      recordMessages(error);
    }
    expect((thrown as ClassifiedProviderError).kind).toBe('transient');
    expect((thrown as ClassifiedProviderError).code).toBe('codex_timeout');
  });
});

// ---------------------------------------------------------------------------
// M4: the spawn-time hooks the local exec budget counts through
// ---------------------------------------------------------------------------

describe('ExecTransport onSpawned / synchronous beforeSpawn (M4)', () => {
  posixIt('onSpawned fires exactly once for a spawned exec that succeeds', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
    let spawned = 0;
    const result = await transport(f).oneShot('prompt', ctxFor(f, { onSpawned: () => { spawned += 1; } }));
    expect(result.turnCompleted).toBe(true);
    expect(spawned).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('onSpawned fires for an exec that fails: a refused turn still reached the plan', async () => {
    const f = fake({ stdoutFixture: fixturePath('synthetic-usage-limit-same-day.jsonl'), exitCode: 1 });
    let spawned = 0;
    const error = (await expectRejection(
      transport(f).run('prompt', ctxFor(f, { onSpawned: () => { spawned += 1; } })),
    )) as ClassifiedProviderError;
    expect(error.kind).toBe('quota_exhausted');
    expect(spawned).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('onSpawned fires for an exec the session aborts mid-turn', async () => {
    const f = fake({ hang: true });
    const controller = new AbortController();
    let spawned = 0;
    const pending = transport(f).oneShot('prompt', ctxFor(f, {
      abortSignal: controller.signal,
      onSpawned: () => { spawned += 1; },
    }));
    expect(await waitFor(() => f.grandchildPid() !== null)).toBe(true);
    controller.abort();
    expect(isAbortError(await expectRejection(pending))).toBe(true);
    expect(spawned).toBe(1);
    expect(await waitForPidGone(Number(f.read('pid.txt')))).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('onSpawned never fires when nothing was spawned', async () => {
    const f = fake({});
    let spawned = 0;
    const onSpawned = (): void => { spawned += 1; };

    // Refused by the pre-spawn check.
    _internals.waitForSlot = (async () => ({ release: () => {} })) as typeof _internals.waitForSlot;
    await expectRejection(transport(f).oneShot('prompt', ctxFor(f, {
      onSpawned,
      beforeSpawn: () => { throw new ClassifiedProviderError('budget', { kind: 'quota_exhausted', cause: null, code: 'local_budget' }); },
    })));
    // The registry could not start it.
    _internals.spawnSdkProcess = (() => null) as typeof _internals.spawnSdkProcess;
    await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { onSpawned })));
    // Aborted before any slot.
    const controller = new AbortController();
    controller.abort();
    await expectRejection(transport(f).oneShot('prompt', ctxFor(f, { onSpawned, abortSignal: controller.signal })));

    expect(spawned).toBe(0);
  });

  posixIt('a synchronous beforeSpawn is not awaited: check, spawn and count run in one synchronous block', async () => {
    const f = fake({});
    const order: string[] = [];
    _internals.waitForSlot = (async () => ({ release: () => {} })) as typeof _internals.waitForSlot;
    _internals.spawnSdkProcess = (() => {
      order.push('spawn');
      return null;
    }) as typeof _internals.spawnSdkProcess;

    await expectRejection(transport(f).oneShot('prompt', ctxFor(f, {
      beforeSpawn: () => {
        order.push('check');
        // Anything else waiting on the event loop — another turn's check,
        // say — runs no earlier than this microtask.
        queueMicrotask(() => order.push('another turn'));
      },
    })));

    expect(order).toEqual(['check', 'spawn', 'another turn']);
  });

  posixIt('two turns granted slots together cannot both pass a one-exec-left check', async () => {
    // The shape of the local budget: a read-only check before the spawn and a
    // count once the process exists. With the check awaited, both turns would
    // pass it before either had been counted.
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
    let counted = 0;
    const limit = 1;
    const ctx = (): CodexTurnContext => ctxFor(f, {
      beforeSpawn: () => {
        if (counted >= limit) {
          throw new ClassifiedProviderError('budget reached', { kind: 'quota_exhausted', cause: null, code: 'local_budget' });
        }
      },
      onSpawned: () => { counted += 1; },
    });
    const t = transport(f);

    const outcomes = await Promise.allSettled([t.oneShot('prompt', ctx()), t.oneShot('prompt', ctx())]);

    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as ClassifiedProviderError).code).toBe('local_budget');
    expect(counted).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a throwing onSpawned is logged, and the exec it reported still runs to completion', async () => {
    const f = fake({ stdoutFixture: fixturePath('p0-success-trivial.jsonl') });
    const result = await transport(f).oneShot('prompt', ctxFor(f, {
      onSpawned: () => { throw new Error('counter exploded'); },
    }));
    expect(result.text).toBe('<ok/>');
    expect(result.exitCode).toBe(0);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe('runner error messages', () => {
  // Runs last in this file (bun keeps declaration order) over every message collected above.
  it('never contain "code 143" or "signal SIGTERM" (SessionRoutes external-kill markers)', () => {
    expect(collectedMessages.length).toBeGreaterThan(5);
    for (const message of collectedMessages) {
      expect(message).not.toMatch(/code 143/i);
      expect(message).not.toMatch(/signal SIGTERM/i);
    }
  });
});
