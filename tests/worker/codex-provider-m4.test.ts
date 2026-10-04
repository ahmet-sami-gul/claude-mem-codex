/**
 * CodexProvider, M4 (plan 3.3 hooks 8-10, 3.3 codex-budget / codex-metrics):
 * the cost levers end to end, through the REAL SessionManager and its in-RAM
 * buffer.
 *
 * Nothing here spawns codex. The transport is a double that honours the
 * runner's spawn contract — the pre-spawn check runs once the "slot" is
 * granted (not awaited when synchronous), and `onSpawned` fires once a
 * process would exist — so what the provider counts is exactly what the real
 * ExecTransport would make it count (that contract is pinned against real
 * processes in codex/codex-exec-runner.test.ts). One test uses the real
 * ExecTransport with its slot/spawn seams stubbed, to prove a budget refusal
 * happens before the slot wait.
 */

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../../src/services/domain/types.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession, ConversationMessage, ObservationData } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import * as recycleConversation from '../../src/services/worker/session/recycle-conversation.js';
import {
  CodexProvider,
  codexLocalBudgetPreflight,
  composeCodexPreflights,
  resetCodexConfigWarnings,
  type CodexConfig,
} from '../../src/services/worker/CodexProvider.js';
import { CodexExecBudget, CODEX_BUDGET_WINDOW_MS } from '../../src/services/worker/codex/codex-budget.js';
import { CodexMetrics } from '../../src/services/worker/codex/codex-metrics.js';
import { _internals, ExecTransport, CodexViolationTracker } from '../../src/services/worker/codex/codex-exec-runner.js';
import type { CodexTransport, CodexTurnContext, TurnResult } from '../../src/services/worker/codex/codex-transport.js';
import { renderCodexTranscriptPrefix } from '../../src/services/worker/codex/codex-prompt.js';
import {
  resetCodexSelfCheckCache,
  verifyCodexLockdown,
  type CodexProbeRequest,
  type CodexProbeResponse,
} from '../../src/services/worker/codex/codex-self-check.js';
import { resetCodexExecutableCache } from '../../src/shared/find-codex-executable.js';
import { isClassified } from '../../src/services/worker/provider-errors.js';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import { fixturePath } from './codex/fake-codex.js';

const SESSION = 1;
const T0 = Date.parse('2026-09-23T09:00:00.000Z');
const HOUR = 60 * 60_000;
const OPEN = '<observed_from_primary_session>';

const FEATURES = readFileSync(fixturePath('v0160-features-list-locked.txt'), 'utf8');
const PROMPT_INPUT = readFileSync(fixturePath('v0160-prompt-input-locked.json'), 'utf8');
const MODELS = readFileSync(fixturePath('v0156-models-catalog.json'), 'utf8');

const OBSERVATION_REPLY = '<observation><type>discovery</type><title>t</title><narrative>n</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>';
const SUMMARY_REPLY = '<summary><request>r</request><investigated>i</investigated><learned>l</learned><completed>c</completed><next_steps>n</next_steps><notes></notes></summary>';

const roots: string[] = [];
const originalInternals = { ..._internals };

function dummyBinary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-m4-')));
  roots.push(root);
  const file = join(root, 'codex');
  writeFileSync(file, '#!/bin/sh\nexit 99\n');
  chmodSync(file, 0o755);
  return file;
}

function turn(text: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    threadId: 'thread-1',
    text,
    usage: { input: 1200, cached: 900, output: 60, reasoning: 20 },
    turnCompleted: true,
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
    durationMs: 12,
    ...overrides,
  };
}

interface SpawnedCall {
  prompt: string;
  ctx: CodexTurnContext;
  /** The session's conversation when the call was made. */
  history: ConversationMessage[];
}

/**
 * The runner's spawn contract without a process: the pre-spawn check once the
 * slot is granted (awaited only when it returns a promise), then `onSpawned`,
 * then the scripted outcome. A refused check means nothing was spawned.
 */
class SpawningTransport implements CodexTransport {
  readonly kind = 'exec' as const;
  readonly violations = new CodexViolationTracker();
  readonly calls: SpawnedCall[] = [];
  refusedBeforeSpawn = 0;
  session: ActiveSession | null = null;

  constructor(private readonly script: (call: SpawnedCall) => TurnResult | Promise<TurnResult> = defaultReply) {}

  async oneShot(prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
    const gate = ctx.beforeSpawn?.();
    try {
      if (gate) await gate;
    } catch (error) {
      this.refusedBeforeSpawn += 1;
      throw error;
    }
    ctx.onSpawned?.();
    const call: SpawnedCall = {
      prompt,
      ctx,
      history: (this.session?.conversationHistory ?? []).map(message => ({ ...message })),
    };
    this.calls.push(call);
    return this.script(call);
  }
}

function defaultReply(call: SpawnedCall): TurnResult {
  return turn(call.ctx.purpose === 'summary' ? SUMMARY_REPLY : OBSERVATION_REPLY);
}

function probeRunner(): (request: CodexProbeRequest) => Promise<CodexProbeResponse> {
  const responses: Record<CodexProbeRequest['kind'], CodexProbeResponse> = {
    version: { exitCode: 0, signal: null, stdout: 'codex-cli 0.160.0\n', stderr: '', timedOut: false },
    login_status: { exitCode: 0, signal: null, stdout: '', stderr: 'Logged in using ChatGPT\n', timedOut: false },
    models_catalog: { exitCode: 0, signal: null, stdout: MODELS, stderr: '', timedOut: false },
    features_list: { exitCode: 0, signal: null, stdout: FEATURES, stderr: '', timedOut: false },
    prompt_input: { exitCode: 0, signal: null, stdout: PROMPT_INPUT, stderr: '', timedOut: false },
  };
  return async (request) => responses[request.kind];
}

function snapshotMode(): ModeConfig {
  const prompts = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? `«${key}»` : undefined) });
  return { name: 'm', prompts, observation_types: [{ id: 'discovery' }], observation_concepts: [] } as unknown as ModeConfig;
}

let settings: SettingsDefaults;

function harness() {
  const storeObservations = mock((
    _memorySessionId: string, _project: string, observations: unknown[], summary: unknown,
  ) => ({
    observationIds: observations.map((_o, index) => 100 + index),
    summaryId: summary ? 7 : null,
    createdAtEpoch: T0,
  }));
  const dbManager = {
    getSessionById: () => ({
      content_session_id: 'content-1',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'Refactor the parser',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      getLatestPromptTextFromUserPrompts: () => null,
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => undefined,
      linkToolUsesToObservation: () => 0,
      storeObservations,
    }),
    getChromaSync: () => ({ syncObservation: () => Promise.resolve(), syncSummary: () => Promise.resolve() }),
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
  const sm = new SessionManager(dbManager);
  const session = sm.initializeSession(SESSION, 'Refactor the parser', 1);
  const confirmed: number[][] = [];
  const realConfirm = sm.confirmClaimedMessages.bind(sm);
  spyOn(sm, 'confirmClaimedMessages').mockImplementation(async (id: number) => {
    confirmed.push([...(sm.getSession(id)?.claimedMessageIds ?? [])]);
    return realConfirm(id);
  });
  return { sm, session, dbManager, storeObservations, confirmed };
}

let toolCounter = 0;
function obsData(overrides: Partial<ObservationData> = {}): ObservationData {
  toolCounter++;
  return {
    tool_name: `Tool${toolCounter}`,
    tool_input: { step: toolCounter },
    tool_response: { ok: true },
    prompt_number: 1,
    cwd: '/repo',
    ...overrides,
  };
}

interface Built {
  provider: CodexProvider;
  transport: SpawningTransport;
  budget: CodexExecBudget;
  metrics: CodexMetrics;
  clock: { now: number };
}

async function codex(
  sm: SessionManager,
  dbManager: DatabaseManager,
  session: ActiveSession,
  options: { transport?: CodexTransport; script?: ConstructorParameters<typeof SpawningTransport>[0] } = {},
): Promise<Built> {
  const clock = { now: T0 };
  const budget = new CodexExecBudget({ persist: false, now: () => clock.now });
  const metrics = new CodexMetrics({ now: () => T0 });
  const transport = new SpawningTransport(options.script);
  transport.session = session;
  const provider = new CodexProvider(dbManager, sm, {
    transport: options.transport ?? transport,
    budget,
    metrics,
  });
  const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();
  const verdict = await verifyCodexLockdown(config.binaryPath!, {
    model: config.model,
    effort: config.effort,
    verbosity: config.verbosity,
    allowUntestedVersion: config.allowUntestedVersion,
    envSettings: {},
    probeRunner: probeRunner(),
  });
  expect(verdict.state).toBe('passed');
  return { provider, transport, budget, metrics, clock };
}

/** Run one generator until the buffer is empty, then end it like a shutdown. */
async function runUntilDrained(provider: CodexProvider, sm: SessionManager, session: ActiveSession): Promise<void> {
  const poll = setInterval(() => {
    if (sm.getMessageBuffer().getPendingCount(SESSION) === 0) session.abortController.abort();
  }, 5);
  const safety = setTimeout(() => session.abortController.abort(), 4_000);
  try {
    await provider.startSession(session);
  } finally {
    clearInterval(poll);
    clearTimeout(safety);
  }
}

beforeEach(() => {
  setSystemTime(new Date(T0));
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_PROVIDER: 'codex',
    CLAUDE_MEM_CODEX_PATH: dummyBinary(),
    // No waiting in these tests unless one asks for it.
    CLAUDE_MEM_CODEX_BATCH_LINGER_MS: '0',
  };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
  spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
    getActiveMode: () => snapshotMode(),
    loadMode: () => {},
  } as unknown as ModeManager));
  spyOn(recycleConversation, 'loadSessionStartContext').mockResolvedValue('');
  for (const level of ['debug', 'info', 'warn', 'error', 'success', 'failure'] as const) {
    spyOn(logger, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  setSystemTime();
  mock.restore();
  Object.assign(_internals, originalInternals);
  resetCodexSelfCheckCache();
  resetCodexExecutableCache();
  resetCodexConfigWarnings();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('CodexProvider M4 — deferred init and fresh generations', () => {
  it('a generator start with no work spends no exec, and books nothing as saved until a call carries the init turn', async () => {
    const { sm, session, dbManager } = harness();
    const { provider, transport, budget, metrics } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls).toEqual([]);
    expect(budget.usedInWindow()).toBe(0);
    // "Init turns that rode along with the first real call": there was none.
    expect(metrics.snapshot()).toMatchObject({ execs: 0, skipped: { init: 0 } });
  });

  it('sends the init turn as the head of the first real call, not as an exec of its own', async () => {
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_name: 'Read' }));
    await sm.queueSummarize(SESSION, 'done');
    const { provider, transport, metrics } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation', 'summary']);
    const [first, second] = transport.calls;
    expect(first.history.map(message => message.role)).toEqual(['user', 'user']);
    expect(first.history[0].content).toContain('<user_request>Refactor the parser</user_request>');
    expect(first.prompt).toContain('<user_request>Refactor the parser</user_request>');
    // The same init turn stays the stable head of every later call.
    expect(second.history[0]).toEqual(first.history[0]);
    expect(metrics.snapshot()).toMatchObject({ execs: 2, calls: { init: 0, observation: 1, summary: 1 }, skipped: { init: 1 } });
  });

  it('starts every generation fresh: turns a paused run left behind are not re-sent', async () => {
    const { sm, session, dbManager } = harness();
    session.conversationHistory = [
      { role: 'user', content: 'OLD INIT' },
      { role: 'user', content: 'OLD OBSERVATION' },
      { role: 'assistant', content: 'OLD REPLY' },
    ];
    await sm.queueObservation(SESSION, obsData());
    const { provider, transport } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].history.some(message => message.content.startsWith('OLD'))).toBe(false);
    expect(transport.calls[0].prompt).not.toContain('OLD ');
    expect(transport.calls[0].history[0].content).toContain('<user_request>Refactor the parser</user_request>');
  });
});

describe('CodexProvider M4 — batching', () => {
  it('reads its policy from CLAUDE_MEM_CODEX_BATCH_* (defaults 4 / 48000 / 2000); 1 turns batching off', async () => {
    const policyOf = (provider: CodexProvider) => {
      const p = provider as unknown as { getConfig(): CodexConfig; observationBatchPolicy(config: CodexConfig): unknown };
      return p.observationBatchPolicy(p.getConfig());
    };
    const provider = new CodexProvider({} as never, {} as never, { transport: new SpawningTransport() });

    settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CODEX_PATH: settings.CLAUDE_MEM_CODEX_PATH };
    expect(policyOf(provider)).toEqual({ maxMessages: 4, maxChars: 48_000, lingerMs: 2_000 });

    settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS = '6';
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_CHARS = '20000';
    settings.CLAUDE_MEM_CODEX_BATCH_LINGER_MS = '500';
    expect(policyOf(provider)).toEqual({ maxMessages: 6, maxChars: 20_000, lingerMs: 500 });

    settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS = '1';
    expect(policyOf(provider)).toBeNull();
  });

  it('sends a burst as ONE exec, confirms the whole batch together, and counts it as one exec of four', async () => {
    const { sm, session, dbManager, confirmed, storeObservations } = harness();
    for (let i = 0; i < 4; i++) await sm.queueObservation(SESSION, obsData({ tool_name: `Step${i}` }));
    const { provider, transport, budget, metrics } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    const sentTurn = transport.calls[0].history.at(-1)!.content;
    expect(sentTurn.split(OPEN)).toHaveLength(5);
    expect(sentTurn).toContain('The 4 tool uses above are consecutive, oldest first.');
    expect(confirmed).toEqual([[1, 2, 3, 4]]);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    expect(budget.usedInWindow()).toBe(1);
    expect(metrics.snapshot().observations).toMatchObject({ sent: 4, execs: 1, perExec: 4, maxPerExec: 4, batchSizes: { '4': 1 } });
  });

  it('stops a batch at a summarize (FIFO), which is its own exec', async () => {
    const { sm, session, dbManager, confirmed } = harness();
    await sm.queueObservation(SESSION, obsData());
    await sm.queueObservation(SESSION, obsData());
    await sm.queueSummarize(SESSION, 'done');
    await sm.queueObservation(SESSION, obsData());
    const { provider, transport, metrics } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation', 'summary', 'observation']);
    expect(confirmed).toEqual([[1, 2], [3], [4]]);
    expect(metrics.snapshot().observations).toMatchObject({ sent: 3, execs: 2, perExec: 1.5 });
  });

  it('BATCH_MAX_OBSERVATIONS=1 is the unbatched provider: no batch claim, one exec and the single-observation bytes each', async () => {
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS = '1';
    const { sm, session, dbManager, confirmed } = harness();
    const claim = spyOn(sm, 'claimObservationBatch');
    await sm.queueObservation(SESSION, obsData({ tool_name: 'Same', tool_input: { a: 1 } }));
    await sm.queueObservation(SESSION, obsData());
    const { provider, transport } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(claim).not.toHaveBeenCalled();
    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation', 'observation']);
    expect(confirmed).toEqual([[1], [2]]);
    expect(transport.calls[0].history.at(-1)!.content).toBe(buildObservationPrompt({
      id: 0,
      tool_name: 'Same',
      tool_input: JSON.stringify({ a: 1 }),
      tool_output: JSON.stringify({ ok: true }),
      created_at_epoch: T0,
      cwd: '/repo',
    }));
  });

  it('keeps the byte-prefix invariant across batched Codex calls', async () => {
    const { sm, session, dbManager } = harness();
    for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData());
    await sm.queueObservation(SESSION, obsData({ prompt_number: 2 }));
    await sm.queueObservation(SESSION, obsData({ prompt_number: 2 }));
    await sm.queueSummarize(SESSION, 'done');
    const { provider, transport } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation', 'observation', 'summary']);
    for (let k = 0; k + 1 < transport.calls.length; k++) {
      // Call k's whole conversation — its own batched task included — opens
      // call k+1's stdin byte for byte.
      const sentBefore = renderCodexTranscriptPrefix(transport.calls[k].history);
      expect(transport.calls[k + 1].prompt.startsWith(sentBefore)).toBe(true);
    }
  });
});

describe('CodexProvider M4 — the local 5-hour exec budget', () => {
  it('refuses before the slot wait and before any spawn, with the exact resume time, keeping the batch', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '2';
    const { sm, session, dbManager } = harness();
    for (let i = 0; i < 4; i++) await sm.queueObservation(SESSION, obsData({ tool_name: `Step${i}` }));

    // The REAL runner, with its slot and spawn seams counting.
    let slotWaits = 0;
    let spawns = 0;
    _internals.waitForSlot = (async () => {
      slotWaits += 1;
      return { release: () => {} };
    }) as typeof _internals.waitForSlot;
    _internals.spawnSdkProcess = (() => {
      spawns += 1;
      return null;
    }) as typeof _internals.spawnSdkProcess;
    const { provider, budget, metrics, clock } = await codex(sm, dbManager, session, {
      transport: new ExecTransport({ maxConcurrent: () => 2 }),
    });
    clock.now = T0 - 2 * HOUR;
    budget.recordExec();
    clock.now = T0 - HOUR;
    budget.recordExec();
    clock.now = T0;

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(slotWaits).toBe(0);
    expect(spawns).toBe(0);
    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
    expect(isClassified(error) && error.code).toBe('local_budget');
    // The exec from two hours ago leaves the window in exactly three hours.
    expect(isClassified(error) && error.retryAfterMs).toBe(T0 - 2 * HOUR + CODEX_BUDGET_WINDOW_MS - T0);
    // The shared policy's quota pause: labelled, aborted, buffer kept.
    expect(session.abortReason).toBe('quota:quota_exhausted');
    expect(session.lastProviderError).toBe(error as never);
    expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(4);
    expect(budget.usedInWindow()).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ execs: 0, budgetRefusals: 1 });
  });

  it('once the window slides, the next generator sends the SAME batch — nothing was dropped', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const { sm, session, dbManager, confirmed, storeObservations } = harness();
    for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData({ tool_name: `Step${i}` }));
    const { provider, transport, budget, clock } = await codex(sm, dbManager, session);
    clock.now = T0 - HOUR;
    budget.recordExec();
    clock.now = T0;

    await expect(provider.startSession(session)).rejects.toThrow('Local Codex exec budget reached');
    expect(transport.calls).toHaveLength(0);

    // The window has slid; the route gives the resumed start a fresh controller.
    clock.now = T0 - HOUR + CODEX_BUDGET_WINDOW_MS;
    session.abortController = new AbortController();
    session.abortReason = null;
    await runUntilDrained(provider, sm, session);

    expect(transport.calls).toHaveLength(1);
    const sentTurn = transport.calls[0].history.at(-1)!.content;
    expect(sentTurn).toContain('<what_happened>Step0</what_happened>');
    expect(sentTurn).toContain('<what_happened>Step2</what_happened>');
    expect(confirmed).toEqual([[1, 2, 3]]);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    expect(budget.usedInWindow()).toBe(1);
  });

  it('counts every spawned exec whatever its outcome, and nothing that was not spawned', async () => {
    const { sm, session, dbManager } = harness();
    for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData({ prompt_number: i + 1 }));
    let call = 0;
    const { provider, transport, budget, metrics } = await codex(sm, dbManager, session, {
      script: () => {
        call += 1;
        // A usage-limit refusal from Codex: the exec happened and was paid.
        if (call === 1) return turn('', { failureMessage: "You've hit your usage limit.", exitCode: 1, turnCompleted: false, usage: null });
        return turn(OBSERVATION_REPLY);
      },
    });

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(isClassified(error) && error.code).toBe('codex_usage_limit');
    expect(transport.calls).toHaveLength(1);
    expect(budget.usedInWindow()).toBe(1);
    expect(metrics.snapshot()).toMatchObject({ execs: 1, calls: { observation: 1 }, tokens: { turnsReported: 0 } });
  });

  it('counts an exec the session aborted mid-turn', async () => {
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData());
    const { provider, budget } = await codex(sm, dbManager, session, {
      script: () => {
        session.abortController.abort();
        const aborted = new Error('Codex exec aborted');
        aborted.name = 'AbortError';
        throw aborted;
      },
    });

    await provider.startSession(session).catch(() => {});

    expect(budget.usedInWindow()).toBe(1);
  });

  it('the provider re-checks the budget once the slot is granted: a turn parked while the last exec went elsewhere never spawns', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData());
    const holder: { budget: CodexExecBudget | null } = { budget: null };
    let spawns = 0;
    let onSpawnedCalls = 0;
    class ParkedTransport extends SpawningTransport {
      override async oneShot(_prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
        // Parked for a pool slot; meanwhile another turn got one first and
        // spawned, taking the last exec of the window.
        holder.budget!.recordExec();
        await ctx.beforeSpawn?.();
        spawns += 1;
        ctx.onSpawned?.();
        onSpawnedCalls += 1;
        return turn(OBSERVATION_REPLY);
      }
    }
    const { provider, budget, metrics } = await codex(sm, dbManager, session, { transport: new ParkedTransport() });
    holder.budget = budget;

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(spawns).toBe(0);
    expect(onSpawnedCalls).toBe(0);
    expect(isClassified(error) && error.code).toBe('local_budget');
    // Only the other turn's exec: the limit is exactly reached, not overrun.
    expect(budget.usedInWindow()).toBe(1);
    expect(session.abortReason).toBe('quota:quota_exhausted');
    expect(metrics.snapshot()).toMatchObject({ execs: 0, budgetRefusals: 1 });
    expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(1);
  });

  it('enforces a limit lowered while a generator runs on its very next call, and /api/health agrees', async () => {
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS = '1';
    const { sm, session, dbManager } = harness();
    for (let i = 0; i < 4; i++) await sm.queueObservation(SESSION, obsData());
    const { provider, transport, budget } = await codex(sm, dbManager, session, {
      script: () => {
        // Unlimited when the generator started; the user sets a limit of 1
        // while its first exec runs.
        settings = { ...settings, CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '1' };
        return turn(OBSERVATION_REPLY);
      },
    });

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(transport.calls).toHaveLength(1);
    expect(isClassified(error) && error.code).toBe('local_budget');
    expect(budget.usedInWindow()).toBe(1);
    expect(provider.getUsageStatus().budget).toMatchObject({ limit: 1, used: 1, remaining: 0 });
    expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(3);
  });

  it('checks again just before the spawn: turns queued for slots cannot overrun the last exec of the window', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const budget = new CodexExecBudget({ persist: false, now: () => T0 });
    const metrics = new CodexMetrics();
    const check = composeCodexPreflights(() => {}, codexLocalBudgetPreflight(budget, metrics));
    const config = { maxExecsPer5h: 1 } as CodexConfig;
    // Two turns both passed the first check while the window was empty, then
    // waited for slots; the first to get one spawns and is counted...
    check(config, { sessionDbId: 1, purpose: 'observation' });
    check(config, { sessionDbId: 2, purpose: 'observation' });
    expect(check(config, { sessionDbId: 1, purpose: 'observation' })).toBeUndefined(); // synchronous
    budget.recordExec();
    // ...and the second one's pre-spawn check now refuses it.
    expect(() => check(config, { sessionDbId: 2, purpose: 'observation' })).toThrow('Local Codex exec budget reached');
    expect(metrics.snapshot().budgetRefusals).toBe(1);
  });

  it('runs after the quota circuit: a call the circuit withholds is not a budget refusal', async () => {
    const budget = new CodexExecBudget({ persist: false, now: () => T0 });
    budget.recordExec();
    const metrics = new CodexMetrics();
    const order: string[] = [];
    const circuit = () => {
      order.push('circuit');
      throw new Error('circuit says no');
    };
    const check = composeCodexPreflights(circuit, (config, ctx) => {
      order.push('budget');
      return codexLocalBudgetPreflight(budget, metrics)(config, ctx);
    });

    expect(() => check({ maxExecsPer5h: 1 } as CodexConfig, { sessionDbId: 1, purpose: 'observation' })).toThrow('circuit says no');
    expect(order).toEqual(['circuit']);
    expect(metrics.snapshot().budgetRefusals).toBe(0);
  });

  it('in the provider, the circuit is consulted first: a held breaker refuses, the budget is not charged a refusal', async () => {
    resetQuotaCooldownsForTesting();
    try {
      settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
      const { sm, session, dbManager } = harness();
      await sm.queueObservation(SESSION, obsData());
      const { provider, transport, budget, metrics } = await codex(sm, dbManager, session);
      budget.recordExec();
      recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', Date.now(), Date.now() + 2 * HOUR);

      const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

      expect(isClassified(error) && error.code).toBe('codex_quota_cooldown');
      expect(transport.calls).toHaveLength(0);
      expect(metrics.snapshot().budgetRefusals).toBe(0);
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });

  it('still applies when the circuit seam is injected: the budget is composed after whatever preflight is given', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData());
    const budget = new CodexExecBudget({ persist: false, now: () => T0 });
    budget.recordExec();
    const transport = new SpawningTransport();
    const circuitCalls: string[] = [];
    const provider = new CodexProvider(dbManager, sm, {
      transport,
      budget,
      metrics: new CodexMetrics(),
      preflight: (_config, ctx) => { circuitCalls.push(ctx.purpose); },
    });
    const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();
    await verifyCodexLockdown(config.binaryPath!, {
      model: config.model, effort: config.effort, verbosity: config.verbosity,
      allowUntestedVersion: config.allowUntestedVersion, envSettings: {}, probeRunner: probeRunner(),
    });

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(circuitCalls).toEqual(['observation']);
    expect(isClassified(error) && error.code).toBe('local_budget');
    expect(transport.calls).toHaveLength(0);
  });

  it('lifts its own pause as soon as the limit is raised, not at the resume time the old limit implied', async () => {
    resetQuotaCooldownsForTesting();
    try {
      settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
      const { sm, session, dbManager, storeObservations } = harness();
      await sm.queueObservation(SESSION, obsData());
      const { provider, transport, budget, clock } = await codex(sm, dbManager, session);
      clock.now = T0 - HOUR;
      budget.recordExec();
      clock.now = T0;
      // What the route books for a local_budget refusal: the breaker, tagged
      // with its cause, until the oldest exec leaves the window (4 h away).
      recordQuotaExhausted('codex', 'Local Codex exec budget reached', undefined, T0, T0 - HOUR + CODEX_BUDGET_WINDOW_MS, 'local_budget');

      // Budget still spent: the hold is right and stays.
      expect(provider.releaseStaleLocalBudgetHold()).toBe(false);
      expect(getQuotaCooldown('codex')).not.toBeNull();

      // The user raises the limit: the next call finds the hold unjustified,
      // lifts it and goes through.
      settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '5';
      await runUntilDrained(provider, sm, session);

      expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
      expect(storeObservations).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')).toBeNull();
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });

  it('never lifts a hold with another cause, or one set to 0 while the budget is still spent elsewhere', async () => {
    resetQuotaCooldownsForTesting();
    try {
      settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '0';
      const { sm, session, dbManager } = harness();
      const { provider } = await codex(sm, dbManager, session);
      // A real Codex usage limit: the local budget has nothing to say about it.
      recordQuotaExhausted('codex', "You've hit your usage limit", undefined, T0, T0 + 2 * HOUR, 'codex_usage_limit');
      expect(provider.releaseStaleLocalBudgetHold()).toBe(false);
      expect(getQuotaCooldown('codex')?.code).toBe('codex_usage_limit');

      // A local_budget hold with the limit turned off (0 = unlimited) goes.
      recordQuotaExhausted('codex', 'Local Codex exec budget reached', undefined, T0, T0 + 2 * HOUR, 'local_budget');
      expect(provider.releaseStaleLocalBudgetHold()).toBe(true);
      expect(getQuotaCooldown('codex')).toBeNull();

      // One whose window already elapsed is the ordinary single probe's job.
      recordQuotaExhausted('codex', 'Local Codex exec budget reached', undefined, T0 - 3 * HOUR, T0 - HOUR, 'local_budget');
      expect(provider.releaseStaleLocalBudgetHold()).toBe(false);
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });

  it('applies to every Codex call, the Telegram wrap-up included', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const { sm, session, dbManager } = harness();
    const { provider, transport, budget, metrics } = await codex(sm, dbManager, session, {
      script: () => turn('• Finished the session'),
    });

    await expect(provider.formatTelegramWrapup({
      sessionDbId: 42, contentSessionId: 'c', project: 'p', platformSource: 'claude', summaryText: 's',
    })).resolves.toBe('• Finished the session');
    await expect(provider.formatTelegramWrapup({
      sessionDbId: 42, contentSessionId: 'c', project: 'p', platformSource: 'claude', summaryText: 's',
    })).rejects.toThrow('Local Codex exec budget reached');

    expect(transport.calls).toHaveLength(1);
    expect(budget.usedInWindow()).toBe(1);
    expect(metrics.snapshot().calls.telegram).toBe(1);
  });
});

describe('CodexProvider M4 — field compression under the budget', () => {
  const BIG = 'x'.repeat(20_000);

  it('never lets a compression take the exec the observation turn needs (one exec left: truncation, then the send)', async () => {
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '2';
    const { sm, session, dbManager, storeObservations } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    const { provider, transport, budget, clock } = await codex(sm, dbManager, session, {
      script: (call) => turn(call.ctx.purpose === 'field_compression' ? 'condensed' : OBSERVATION_REPLY),
    });
    clock.now = T0 - HOUR;
    budget.recordExec();
    clock.now = T0;

    await runUntilDrained(provider, sm, session);

    // Before: the freed exec went to the compression, the observation was
    // refused, and every slide of the window repeated that with nothing stored.
    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    expect(budget.usedInWindow()).toBe(2);
  });

  it('compresses when the window has room for the compression AND the observation, but never both fields past that', async () => {
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '3';
    const { sm, session, dbManager, storeObservations } = harness();
    // Two oversized fields, compressed in parallel: only one fits the reserve.
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG }, tool_response: { out: BIG } }));
    const { provider, transport, budget, clock } = await codex(sm, dbManager, session, {
      script: (call) => turn(call.ctx.purpose === 'field_compression' ? 'condensed' : OBSERVATION_REPLY),
    });
    clock.now = T0 - HOUR;
    budget.recordExec();
    clock.now = T0;

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['field_compression', 'observation']);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    expect(budget.usedInWindow()).toBe(3);
  });

  it('after a usage-limit refusal, the rest of the turn goes to truncation without spawning another compression', async () => {
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    const { sm, session, dbManager } = harness();
    // One batch, two observations, one oversized field each: compressed one
    // after the other.
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    const { provider, transport } = await codex(sm, dbManager, session, {
      script: (call) => (call.ctx.purpose === 'field_compression'
        ? turn('', { failureMessage: "You've hit your usage limit.", exitCode: 1, turnCompleted: false, usage: null })
        : turn(OBSERVATION_REPLY)),
    });

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['field_compression', 'observation']);
  });

  it('stops compressing the rest of a batch when the session aborts mid-way, and sends nothing', async () => {
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: BIG } }));
    const { provider, transport } = await codex(sm, dbManager, session, {
      script: (call) => {
        // Shutdown (or a pause raised elsewhere) while the first pass runs.
        if (call.ctx.purpose === 'field_compression') session.abortController.abort();
        return turn(call.ctx.purpose === 'field_compression' ? 'condensed' : OBSERVATION_REPLY);
      },
    });

    await provider.startSession(session).catch(() => {});

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['field_compression']);
    // The batch is left for the next generator.
    expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(3);
  });
});

describe('CodexProvider M4 — metrics', () => {
  it('books what the levers saved only when the call carrying them spawns: refused starts and rebuilt turns count nothing', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '1';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: 'x'.repeat(20_000) } }));
    const { provider, transport, budget, metrics, clock } = await codex(sm, dbManager, session);
    clock.now = T0 - HOUR;
    budget.recordExec();
    clock.now = T0;

    // Three starts, each refused by the spent budget before any exec: the
    // same oversized field is rebuilt into a turn every time.
    for (let attempt = 0; attempt < 3; attempt++) {
      session.abortController = new AbortController();
      session.abortReason = null;
      await provider.startSession(session).catch(() => {});
    }

    expect(transport.calls).toHaveLength(0);
    expect(metrics.snapshot()).toMatchObject({ execs: 0, budgetRefusals: 3, skipped: { init: 0, fieldCompression: 0 } });

    // The window slides: the same turn is sent once, and booked once.
    clock.now = T0 - HOUR + CODEX_BUDGET_WINDOW_MS;
    session.abortController = new AbortController();
    session.abortReason = null;
    await runUntilDrained(provider, sm, session);

    expect(transport.calls).toHaveLength(1);
    expect(metrics.snapshot()).toMatchObject({ execs: 1, skipped: { init: 1, fieldCompression: 1 } });
  });

  it('records token totals and tool attempts from the turns it spawned', async () => {
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ prompt_number: 1 }));
    await sm.queueObservation(SESSION, obsData({ prompt_number: 2 }));
    let call = 0;
    const { provider, budget, metrics } = await codex(sm, dbManager, session, {
      script: () => {
        call += 1;
        if (call === 2) {
          return turn('', {
            toolAttempt: { eventType: 'item.started', itemType: 'command_execution', itemId: 'x', toolName: 'command_execution', toolInput: '{}' },
            usage: { input: 10, cached: 0, output: 1, reasoning: 0 },
          });
        }
        return turn(OBSERVATION_REPLY, { usage: { input: 5570, cached: 4864, output: 7, reasoning: 3 } });
      },
    });

    await runUntilDrained(provider, sm, session);

    const snapshot = metrics.snapshot();
    expect(snapshot.execs).toBe(2);
    expect(snapshot.toolAttempts).toBe(1);
    expect(snapshot.tokens).toEqual({ input: 5580, cached: 4864, output: 8, reasoning: 3, turnsReported: 2 });
    // The same counts are kept per exec in the budget window.
    expect(budget.snapshot(0).tokens).toEqual({ input: 5580, cached: 4864, output: 8, reasoning: 3 });
  });

  it('counts the compression execs a skipped pass saved (oversized fields only)', async () => {
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: 'x'.repeat(20_000) } }));
    await sm.queueObservation(SESSION, obsData({ tool_input: { small: true } }));
    const { provider, transport, metrics } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    expect(metrics.snapshot().skipped.fieldCompression).toBe(1);
  });

  it('counts nothing as skipped when field compression is on', async () => {
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData({ tool_input: { blob: 'x'.repeat(20_000) } }));
    const { provider, transport, metrics } = await codex(sm, dbManager, session, {
      script: (call) => turn(call.ctx.purpose === 'field_compression' ? 'condensed' : OBSERVATION_REPLY),
    });

    await runUntilDrained(provider, sm, session);

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['field_compression', 'observation']);
    expect(metrics.snapshot().skipped.fieldCompression).toBe(0);
    expect(metrics.snapshot().calls.fieldCompression).toBe(1);
  });

  it('reports the budget and the counters for /api/health, with the configured limit', async () => {
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '150';
    const { sm, session, dbManager } = harness();
    await sm.queueObservation(SESSION, obsData());
    const { provider } = await codex(sm, dbManager, session);

    await runUntilDrained(provider, sm, session);
    const status = provider.getUsageStatus();

    expect(status.budget).toMatchObject({ limit: 150, used: 1, remaining: 149, windowMs: CODEX_BUDGET_WINDOW_MS, resumeAtMs: null });
    expect(status.metrics).toMatchObject({ execs: 1, calls: { observation: 1 }, skipped: { init: 1 } });
  });
});
