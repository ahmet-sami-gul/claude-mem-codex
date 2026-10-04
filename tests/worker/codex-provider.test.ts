/**
 * CodexProvider (plan 3.3 / M2).
 *
 * Every model call goes through an injected fake transport: nothing here
 * spawns codex, and the one place the REAL machinery is exercised is the
 * lockdown self-check, which is driven with an injected probe runner over the
 * Phase 0 fixtures (the same pattern as tests/worker/codex/codex-self-check.test.ts).
 *
 * The bar is the two things a provider on someone's paid plan must never do:
 * send a call it was not asked for, and send it with a model that belongs to a
 * different backend.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import {
  CodexProvider,
  isCodexQuotaCircuitRefusal,
  isCodexSelected,
  resetCodexConfigWarnings,
  type CodexConfig,
} from '../../src/services/worker/CodexProvider.js';
import { isCodexReadinessSource } from '../../src/services/worker/session/codex-readiness-gate.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import type {
  CodexTransport,
  CodexTurnContext,
  TurnResult,
} from '../../src/services/worker/codex/codex-transport.js';
import {
  resetCodexSelfCheckCache,
  verifyCodexLockdown,
  type CodexProbeRequest,
  type CodexProbeResponse,
  type VerifyCodexLockdownOptions,
} from '../../src/services/worker/codex/codex-self-check.js';
import { CodexViolationTracker } from '../../src/services/worker/codex/codex-exec-runner.js';
import { telemetryBuffer } from '../../src/services/telemetry/buffer.js';
import * as findCodex from '../../src/shared/find-codex-executable.js';
import { resetCodexExecutableCache } from '../../src/shared/find-codex-executable.js';
import { isClassified } from '../../src/services/worker/provider-errors.js';
import {
  clearQuotaCooldown,
  getQuotaCooldown,
  isQuotaCooldownActive,
  recordQuotaExhausted,
  releaseQuotaProbe,
  resetQuotaCooldownsForTesting,
  tryAdmitQuotaProbe,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
} from '../../src/shared/quota-cooldown.js';
import { fixturePath } from './codex/fake-codex.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const FEATURES = readFileSync(fixturePath('v0160-features-list-locked.txt'), 'utf8');
const PROMPT_INPUT = readFileSync(fixturePath('v0160-prompt-input-locked.json'), 'utf8');
const MODELS = readFileSync(fixturePath('v0156-models-catalog.json'), 'utf8');

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

const observationXml = `
  <observation>
    <type>discovery</type>
    <title>Read the entry point</title>
    <narrative>The observer saw a Read of src/main.ts.</narrative>
    <facts></facts>
    <concepts></concepts>
    <files_read></files_read>
    <files_modified></files_modified>
  </observation>
`;

const roots: string[] = [];

/** A dummy executable in mkdtemp; the fake transport never runs it. */
function dummyBinary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-provider-')));
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

/**
 * A turn the observer deliberately answered with nothing: exit 0,
 * turn.completed, no agent_message AND no visible output tokens — which plan
 * 2.8 settles as a successful empty turn rather than a transient failure.
 */
function silentTurn(): TurnResult {
  return turn('', { usage: { input: 1200, cached: 900, output: 20, reasoning: 20 } });
}

class FakeTransport implements CodexTransport {
  readonly kind = 'exec' as const;
  readonly calls: Array<{ prompt: string; ctx: CodexTurnContext }> = [];
  /** Same public field ExecTransport exposes, so the provider finds it the same way. */
  readonly violations = new CodexViolationTracker();
  private readonly queue: TurnResult[];

  constructor(results: TurnResult[] = []) {
    this.queue = [...results];
  }

  async oneShot(prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
    this.calls.push({ prompt, ctx });
    return this.queue.shift() ?? turn(observationXml);
  }
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

let settings: SettingsDefaults;
let storeObservations: ReturnType<typeof mock>;
let updateMemorySessionId: ReturnType<typeof mock>;
let persistedMemorySessionId: string | null;
let modeManagerSpy: ReturnType<typeof spyOn>;

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 7,
    contentSessionId: 'content-7',
    memorySessionId: 'mem-session-7',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  };
}

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({ memory_session_id: persistedMemorySessionId }),
    getSessionStore: () => ({
      storeObservations,
      updateMemorySessionId,
      ensureMemorySessionIdRegistered: mock(() => {}),
    }),
    getChromaSync: () => ({
      syncObservation: mock(() => Promise.resolve()),
      syncSummary: mock(() => Promise.resolve()),
    }),
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
}

function makeSessionManager(messages: unknown[]): SessionManager {
  return {
    getMessageIterator: async function* () {
      for (const message of messages) yield message;
    },
    getClaimedMessages: mock(() => []),
    confirmClaimedMessages: mock(() => Promise.resolve(0)),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
    // Codex batches by default (M4); this double has no queue behind the
    // iterator, so every batch is just the message the drain yielded.
    claimObservationBatch: mock(async (_sessionDbId: number, first: unknown) => [first]),
  } as unknown as SessionManager;
}

const observationMessage = {
  type: 'observation',
  tool_name: 'Read',
  tool_input: { file_path: 'src/main.ts' },
  tool_response: 'file contents',
  prompt_number: 1,
};

const summarizeMessage = { type: 'summarize', last_assistant_message: 'done' };

/** The provider under test, with the self-check already satisfied. */
async function readyProvider(
  transport: CodexTransport,
  messages: unknown[] = [],
): Promise<CodexProvider> {
  const provider = new CodexProvider(makeDbManager(), makeSessionManager(messages), { transport });
  const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();
  const verdict = await verifyCodexLockdown(config.binaryPath!, {
    model: config.model,
    summaryModel: config.summaryModel,
    effort: config.effort,
    verbosity: config.verbosity,
    allowUntestedVersion: config.allowUntestedVersion,
    envSettings: {},
    probeRunner: probeRunner(),
  });
  expect(verdict.state).toBe('passed');
  return provider;
}

beforeEach(() => {
  persistedMemorySessionId = null;
  storeObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));
  updateMemorySessionId = mock(() => {});
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    // Deliberately loaded with another backend's model settings: none of them
    // may reach a Codex invocation.
    CLAUDE_MEM_MODEL: '$TIER:fast',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
    CLAUDE_MEM_TIER_SUMMARY_MODEL: 'claude-sonnet-4-5',
    CLAUDE_MEM_TIER_FAST_MODEL: 'haiku',
    CLAUDE_MEM_PROVIDER: 'codex',
    CLAUDE_MEM_CODEX_PATH: dummyBinary(),
  };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
  modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
    getActiveMode: () => mockMode,
    loadMode: () => {},
  } as unknown as ModeManager));
});

afterEach(() => {
  modeManagerSpy.mockRestore();
  mock.restore();
  resetCodexSelfCheckCache();
  resetCodexExecutableCache();
  resetCodexConfigWarnings();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('CodexProvider.getConfig', () => {
  function config(provider: CodexProvider): CodexConfig {
    return (provider as unknown as { getConfig(): CodexConfig }).getConfig();
  }

  it('reads the CLAUDE_MEM_CODEX_* keys and resolves the binary', () => {
    settings.CLAUDE_MEM_CODEX_MODEL = 'gpt-5.6-terra';
    settings.CLAUDE_MEM_CODEX_REASONING_EFFORT = 'medium';
    settings.CLAUDE_MEM_CODEX_VERBOSITY = 'high';
    settings.CLAUDE_MEM_CODEX_TIMEOUT_MS = '240000';
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';

    const resolved = config(new CodexProvider({} as never, {} as never, { transport: new FakeTransport() }));

    expect(resolved).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'medium',
      verbosity: 'high',
      timeoutMs: 240000,
      fieldCompression: true,
      transportKind: 'exec',
      binaryPath: realpathSync(settings.CLAUDE_MEM_CODEX_PATH),
      binaryError: null,
    });
    // Never an apiKey: this provider authenticates through the CLI's own login.
    expect(resolved.apiKey).toBeUndefined();
  });

  it('clamps or rejects every out-of-range value instead of passing it to the CLI', () => {
    // All fifteen validated keys, so the title stays true as bounds move.
    settings.CLAUDE_MEM_CODEX_MODEL = '-not-a-model-id';
    settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL = '-bad-id';
    settings.CLAUDE_MEM_CODEX_REASONING_EFFORT = 'extreme';
    settings.CLAUDE_MEM_CODEX_VERBOSITY = '';
    settings.CLAUDE_MEM_CODEX_TIMEOUT_MS = '5';
    settings.CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS = '9999999';
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS = 'four';
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_CHARS = '500';
    settings.CLAUDE_MEM_CODEX_BATCH_LINGER_MS = '600000';
    settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H = '-3';
    settings.CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT = '60';
    settings.CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS = '1000';
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'yes';
    // Feeds the lockdown self-check's version gate: anything but an explicit
    // 'true' has to read as false, or an untested build could run on the plan.
    settings.CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION = 'maybe';
    settings.CLAUDE_MEM_CODEX_TRANSPORT = 'app-server';

    const resolved = config(new CodexProvider({} as never, {} as never, { transport: new FakeTransport() }));

    expect(resolved).toMatchObject({
      model: 'gpt-5.6-luna',
      // '' means "use the observer model", never an invalid -m argument.
      summaryModel: '',
      effort: 'low',
      verbosity: 'low',
      timeoutMs: 30000,
      maxConversationChars: 400000,
      batchMaxObservations: 4,
      batchMaxChars: 8000,
      batchLingerMs: 30000,
      maxExecsPer5h: 0,
      quotaReservePercent: 50,
      rateLimitProbeMs: 60000,
      fieldCompression: false,
      allowUntestedVersion: false,
      // 'app-server' is a reserved name, not an implementation.
      transportKind: 'exec',
    });
  });

  /**
   * settings.json is hand-editable and the settings POST route is
   * unauthenticated, so a JSON number/boolean/array can reach the loaded
   * object. getConfig is on every codex path (readiness, startSession, the
   * wrap-up, the per-observation budget) and is documented never to throw:
   * a non-string must degrade to the documented default, not to a TypeError
   * that leaves the observer dead until someone edits the file by hand.
   */
  it('falls back to the defaults for a non-string value instead of throwing', () => {
    const loaded = settings as unknown as Record<string, unknown>;
    loaded.CLAUDE_MEM_CODEX_TIMEOUT_MS = 240000;            // a JSON number
    loaded.CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS = [150000]; // an array
    loaded.CLAUDE_MEM_CODEX_BATCH_LINGER_MS = true;          // a boolean
    loaded.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = true;
    loaded.CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION = true;
    loaded.CLAUDE_MEM_CODEX_MODEL = 42;
    loaded.CLAUDE_MEM_CODEX_REASONING_EFFORT = 3;
    loaded.CLAUDE_MEM_CODEX_VERBOSITY = {};
    loaded.CLAUDE_MEM_CODEX_TRANSPORT = ['exec'];
    loaded.CLAUDE_MEM_CODEX_HOME = 7;

    const provider = new CodexProvider({} as never, {} as never, { transport: new FakeTransport() });

    expect(config(provider)).toMatchObject({
      timeoutMs: 180000,
      maxConversationChars: 120000,
      batchLingerMs: 2000,
      fieldCompression: false,
      allowUntestedVersion: false,
      model: 'gpt-5.6-luna',
      effort: 'low',
      verbosity: 'low',
      transportKind: 'exec',
      codexHome: '',
    });
  });

  /**
   * getConfig runs on the ingest hot path — the base class calls
   * conversationMaxChars once per captured tool call — and on every
   * /api/status poll. An unmemoized miss walks every absolute PATH entry with
   * a statSync + accessSync, then realpathSync + statSync on the hit: tens of
   * syscalls per observation for an answer that cannot change between two
   * calls a millisecond apart.
   */
  it('resolves the binary once and reuses it across getConfig calls', () => {
    const resolve = spyOn(findCodex, 'findCodexExecutable');
    try {
      const provider = new CodexProvider({} as never, {} as never, { transport: new FakeTransport() });
      const first = config(provider);
      const second = config(provider);
      const third = config(provider);

      expect(first.binaryPath).toBe(realpathSync(settings.CLAUDE_MEM_CODEX_PATH));
      expect(second.binaryPath).toBe(first.binaryPath);
      expect(third.binaryPath).toBe(first.binaryPath);
      expect(resolve).toHaveBeenCalledTimes(1);

      // A changed CLAUDE_MEM_CODEX_PATH re-resolves at once — the memo is
      // keyed on the configured path, not on time alone.
      settings.CLAUDE_MEM_CODEX_PATH = join(tmpdir(), 'claude-mem-no-such-codex-binary');
      expect(config(provider).binaryPath).toBeNull();
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      resolve.mockRestore();
    }
  });

  it('reports an unresolvable binary instead of throwing out of getConfig', () => {
    settings.CLAUDE_MEM_CODEX_PATH = join(tmpdir(), 'claude-mem-no-such-codex-binary');

    const resolved = config(new CodexProvider({} as never, {} as never, { transport: new FakeTransport() }));

    expect(resolved.binaryPath).toBeNull();
    expect(resolved.binaryError).toContain('unusable');
  });
});

describe('CodexProvider readiness', () => {
  it('is not configured without a resolved binary, and says how to fix it', async () => {
    settings.CLAUDE_MEM_CODEX_PATH = join(tmpdir(), 'claude-mem-no-such-codex-binary');
    const transport = new FakeTransport();
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([observationMessage]), { transport });
    const session = makeSession();

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(isClassified(error)).toBe(true);
    expect(isClassified(error) && error.kind).toBe('setup_required');
    expect(isClassified(error) && error.code).toBe('codex_setup_required');
    expect(isClassified(error) && error.action).toContain('codex login');
    expect(transport.calls).toHaveLength(0);
    // The readiness gate throws before any try/catch, so the shared error
    // policy never sees it — but it is still the failure that ended this run,
    // and the one a codex user hits most.
    expect(session.lastProviderError).toBe(error as never);
  });

  it('treats a self-check that has not passed as setup_required and starts one in the background', async () => {
    const transport = new FakeTransport();
    const startSelfCheck = mock(() => {});
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([observationMessage]), {
      transport,
      startSelfCheck,
    });

    const error = await provider.startSession(makeSession()).then(() => null, (thrown: unknown) => thrown);

    expect(isClassified(error) && error.kind).toBe('setup_required');
    // "Pending" is a refusal, not a maybe: nothing was sent.
    expect(transport.calls).toHaveLength(0);
    expect(startSelfCheck).toHaveBeenCalled();
  });

  it('runs once the lockdown self-check has passed for that binary', async () => {
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, [observationMessage]);

    await provider.startSession(makeSession());

    // No init exec of its own (M4 deferInitQuery): the first call is the
    // observation, carrying the init turn as its head.
    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    expect(provider.lockdownStatus()?.state).toBe('passed');
    expect(provider.getAuthMethodDescription()).toBe('Codex CLI (ChatGPT login)');
  });
});

describe('CodexProvider session lifecycle', () => {
  it('stores an observation and a summary through one Codex turn each', async () => {
    const transport = new FakeTransport([
      turn(observationXml),     // observation (the deferred init turn rides along as its head)
      turn(observationXml),     // summary
    ]);
    const provider = await readyProvider(transport, [observationMessage, summarizeMessage]);
    const session = makeSession();

    await provider.startSession(session);

    // Exactly one exec per message: no standalone init exec (M4 hook 8).
    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation', 'summary']);
    expect(storeObservations).toHaveBeenCalledTimes(2);
    // The init turn is the stable head of the conversation, sent inside the
    // first real call's transcript rather than on its own.
    expect(session.conversationHistory[0].role).toBe('user');
    expect(session.conversationHistory[0].content).toContain('<user_request>test prompt</user_request>');
    expect(transport.calls[0].prompt).toContain('<user_request>test prompt</user_request>');
    // Every turn is rendered by renderCodexPrompt: framed transcript plus the
    // message being answered now.
    for (const call of transport.calls) {
      expect(call.prompt.startsWith('<observer_transcript>\n')).toBe(true);
      expect(call.prompt).toContain('<current_task turn="');
    }
    // The turn context carries the session and the resolved invocation.
    expect(transport.calls[0].ctx).toMatchObject({
      sessionDbId: 7,
      contentSessionId: 'content-7',
      project: 'test-project',
      model: 'gpt-5.6-luna',
      effort: 'low',
      verbosity: 'low',
      timeoutMs: 180000,
    });
    expect(transport.calls[0].ctx.abortSignal).toBe(session.abortController.signal);
    // The reported counts reached the session's accounting (the stored
    // lastUsage itself is consumed and cleared by the telemetry path).
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
    expect(session.cumulativeOutputTokens).toBeGreaterThan(0);
  });

  it('reports the real token counts and never a cost', () => {
    const provider = new CodexProvider({} as never, {} as never, { transport: new FakeTransport() });
    const build = (provider as unknown as {
      buildLastUsage(result: { inputTokens?: number; outputTokens?: number }): ActiveSession['lastUsage'];
    }).buildLastUsage;

    expect(build.call(provider, { inputTokens: 1200, outputTokens: 60 })).toEqual({ input: 1200, output: 60 });
    // Both sides or nothing, and never a costUsd: a ChatGPT-plan exec has no
    // per-call price to report.
    expect(build.call(provider, { inputTokens: 1200 })).toBeNull();
    expect(build.call(provider, {})).toBeNull();
  });

  it('sends the summary turn to CLAUDE_MEM_CODEX_SUMMARY_MODEL, never a tier alias', async () => {
    settings.CLAUDE_MEM_CODEX_MODEL = 'gpt-5.6-luna';
    // Listed in the catalog fixture: the self-check checks the summary model too.
    settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL = 'gpt-5.5';
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, [observationMessage, summarizeMessage]);

    await provider.startSession(makeSession());

    expect(transport.calls.map(call => call.ctx.model)).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
  });

  it('falls back to the observer model when no summary model is configured', async () => {
    settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL = '';
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, [observationMessage, summarizeMessage]);

    await provider.startSession(makeSession());

    expect(transport.calls.map(call => call.ctx.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-luna']);
  });

  it('adopts a memory_session_id written by another provider without re-keying the row', async () => {
    persistedMemorySessionId = 'claude-native-id';
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, []);
    const session = makeSession({ memorySessionId: null });

    await provider.startSession(session);

    expect(session.memorySessionId).toBe('claude-native-id');
    expect(updateMemorySessionId).not.toHaveBeenCalled();
  });

  it('generates its own memory_session_id when the row has none', async () => {
    persistedMemorySessionId = null;
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, []);
    const session = makeSession({ memorySessionId: null });

    await provider.startSession(session);

    expect(session.memorySessionId).toStartWith('codex-content-7-');
    // Kept in memory only. The row stays NULL until the first store calls
    // ensureMemorySessionIdRegistered, so a codex session that never stores
    // anything (setup gate, guard kill, content policy) costs no UPDATE and no
    // requeuePromptSync at session start.
    expect(updateMemorySessionId).not.toHaveBeenCalled();
  });

  it('spends no exec on field compression by default, and one when it is turned on', async () => {
    const oversized = { ...observationMessage, tool_input: { blob: 'x'.repeat(20_000) } };

    const offTransport = new FakeTransport();
    const off = await readyProvider(offTransport, [oversized]);
    await off.startSession(makeSession());
    expect(offTransport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);

    resetCodexSelfCheckCache();
    settings.CLAUDE_MEM_CODEX_FIELD_COMPRESSION = 'true';
    const onTransport = new FakeTransport([turn('condensed payload'), turn(observationXml)]);
    const on = await readyProvider(onTransport, [oversized]);
    const onSession = makeSession();
    await on.startSession(onSession);
    expect(onTransport.calls.map(call => call.ctx.purpose)).toEqual(['field_compression', 'observation']);

    // The compression exec is attributed to the session it belongs to, not to
    // sessionDbId 0. Under the real transport 0 means the shared jail
    // directory OBSERVER_SESSIONS_DIR/0, a registry entry no session owns, an
    // observer-audit row for the wrong session, and — worst — one
    // lockdown-violation counter shared by every session in the process.
    const compression = onTransport.calls[0];
    expect(compression.ctx).toMatchObject({
      sessionDbId: 7,
      contentSessionId: 'content-7',
      project: 'test-project',
      purpose: 'field_compression',
    });
    // Its own bounded deadline, never the session's controller: the optimizer
    // caps a compression pass well below the turn timeout.
    expect(compression.ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(compression.ctx.abortSignal).not.toBe(onSession.abortController.signal);
  });

  /**
   * plan 2.8: an empty Codex turn is a real answer, not a transport failure.
   * forwardEmptyMessageResponse=true is what makes it reach processAgentResponse
   * so the claimed batch is confirmed and dropped; with it false the batch stays
   * queued and the next ingest buys the same nothing again, forever, on a
   * metered plan.
   */
  it('forwards an empty observation turn so the batch is confirmed instead of re-sent', async () => {
    const transport = new FakeTransport([
      silentTurn(),          // the observer chose to say nothing about this tool call
    ]);
    const sessionManager = makeSessionManager([observationMessage]);
    const provider = new CodexProvider(makeDbManager(), sessionManager, { transport });
    const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();
    await verifyCodexLockdown(config.binaryPath!, {
      model: config.model,
      effort: config.effort,
      verbosity: config.verbosity,
      allowUntestedVersion: config.allowUntestedVersion,
      envSettings: {},
      probeRunner: probeRunner(),
    });

    await provider.startSession(makeSession());

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    expect(sessionManager.confirmClaimedMessages).toHaveBeenCalled();
    expect(sessionManager.resetProcessingToPending).not.toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });

  /**
   * ResponseProcessor's agentName -> telemetry provider map. A codex session
   * whose currentProvider has not been stamped yet (a direct provider call, as
   * here) falls through to that map; without the Codex entry every codex
   * observation would be reported as Claude's.
   */
  it('stamps codex observations with the codex provider label', async () => {
    const recorded: Array<{ event: string; props: Record<string, unknown> }> = [];
    const record = spyOn(telemetryBuffer, 'record').mockImplementation(((event: string, _id: number, props: Record<string, unknown>) => {
      recorded.push({ event, props });
    }) as never);
    try {
      const transport = new FakeTransport([turn(observationXml)]);
      const provider = await readyProvider(transport, [observationMessage]);

      await provider.startSession(makeSession({ currentProvider: null }));
    } finally {
      record.mockRestore();
    }

    const compressed = recorded.filter(entry => entry.event === 'session_compressed');
    expect(compressed).not.toHaveLength(0);
    expect(compressed.every(entry => entry.props.provider === 'codex')).toBe(true);
  });

  /**
   * CODEX_LOCKDOWN_BREACH_THRESHOLD escalates the SECOND forbidden-tool attempt
   * to setup_required. The counter is a process-lifetime map, so without a
   * per-run reset "second" would mean "second ever" and two unrelated guard
   * kills hours apart would take a healthy install down.
   */
  it('forgets this session\'s lockdown violations when the generator exits', async () => {
    const transport = new FakeTransport();
    transport.violations.record(7);
    expect(transport.violations.count(7)).toBe(1);
    const provider = await readyProvider(transport, []);

    await provider.startSession(makeSession());

    expect(transport.violations.count(7)).toBe(0);
  });

  it('forgets them on a failed run too', async () => {
    const transport = new FakeTransport([
      turn('', { failureMessage: "You've hit your usage limit.", exitCode: 1, turnCompleted: false }),
    ]);
    transport.violations.record(7);
    const provider = await readyProvider(transport, [observationMessage]);

    await provider.startSession(makeSession()).catch(() => {});

    expect(transport.violations.count(7)).toBe(0);
  });

  it('stashes a classified failure on the session and preserves the buffered work', async () => {
    const transport = new FakeTransport([
      turn('', { failureMessage: "You've hit your usage limit.", exitCode: 1, turnCompleted: false }),
    ]);
    const provider = await readyProvider(transport, [observationMessage]);
    const session = makeSession();

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
    expect(isClassified(error) && error.code).toBe('codex_usage_limit');
    expect(session.lastProviderError).toBe(error as never);
    expect(session.abortReason).toBe('quota:quota_exhausted');
  });
});

describe('CodexProvider budgets and estimates', () => {
  it('estimates four characters per token', () => {
    const provider = new CodexProvider({} as never, {} as never, { transport: new FakeTransport() });
    const estimate = (provider as unknown as { estimateTokens(text: string): number }).estimateTokens;

    expect(estimate.call(provider, '')).toBe(0);
    expect(estimate.call(provider, 'abc')).toBe(1);
    expect(estimate.call(provider, 'x'.repeat(4000))).toBe(1000);
  });

  it('floors the conversation budget at first turn + one batch + head-room', () => {
    settings.CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS = '120000';
    settings.CLAUDE_MEM_CODEX_BATCH_MAX_CHARS = '48000';
    const provider = new CodexProvider({} as never, {} as never, { transport: new FakeTransport() });
    const budget = (provider as unknown as { conversationMaxChars(session?: ActiveSession): number });

    expect(budget.conversationMaxChars.call(provider, makeSession())).toBe(120000);
    // A large init turn raises the ceiling so a FRESH generation is never
    // already over it (two recycles in a row arm the overflow pause).
    const big = makeSession({ conversationHistory: [{ role: 'user', content: 'x'.repeat(200_000) }] });
    expect(budget.conversationMaxChars.call(provider, big)).toBe(200_000 + 48_000 + 16_000);
  });
});

describe('CodexProvider Telegram wrap-up', () => {
  it('formats through Codex with the wrap-up session id', async () => {
    const transport = new FakeTransport([turn('• Finished the session')]);
    const provider = await readyProvider(transport, []);

    await expect(provider.formatTelegramWrapup({
      sessionDbId: 42,
      contentSessionId: 'content-42',
      project: 'test-project',
      platformSource: 'claude',
      summaryText: 'whole summary',
    })).resolves.toBe('• Finished the session');

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].ctx.purpose).toBe('telegram_wrapup');
    expect(transport.calls[0].ctx.sessionDbId).toBe(42);
  });
});

describe('isCodexSelected', () => {
  it('is settings-only, with no availability gate beside it', () => {
    settings.CLAUDE_MEM_PROVIDER = 'codex';
    expect(isCodexSelected()).toBe(true);

    settings.CLAUDE_MEM_PROVIDER = 'claude';
    expect(isCodexSelected()).toBe(false);
  });
});

/**
 * The quota circuit at the head of query() (plan 3.5, M3).
 *
 * SessionRoutes' `tryAdmitQuotaProbe` only runs when a generator STARTS. A Plus
 * allowance runs out mid-session, and every generator already running at that
 * moment keeps spawning `codex exec` — one paid subprocess per captured tool
 * call — until each earns its own "You've hit your usage limit". This is the
 * second gate, at the only place that repeats per call.
 *
 * The assertion that matters in every one of these is `transport.calls` being
 * empty: a refusal that still spawned would have spent the user's plan anyway.
 */
describe('CodexProvider quota circuit', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterEach(() => {
    // Nested one level in, so it runs before this file's top-level teardown and
    // before any cross-file singleton guard: the breaker is process-global and
    // an armed codex window would gate every later codex test in this process.
    resetQuotaCooldownsForTesting();
  });

  it('refuses without spawning while the cooldown is active', async () => {
    const transport = new FakeTransport();
    const provider = await readyProvider(transport, [observationMessage]);
    const session = makeSession();
    const armedAt = Date.now();
    const resumeAt = armedAt + 4 * 60 * 60_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", '5h', armedAt, resumeAt);

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(transport.calls).toHaveLength(0);
    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
    expect(isClassified(error) && error.code).toBe('codex_quota_cooldown');
    // The provider's own words, so the user can tell "wait" from "change plan".
    expect(isClassified(error) && error.message).toContain("You've hit your usage limit");
    // Derived from the REAL resume time, not the fixed 30-minute guess.
    expect(isClassified(error) && error.retryAfterMs).toBeGreaterThan(3 * 60 * 60_000);
    // Stashed before it unwinds, because the route's .finally() reads it while
    // this call is still on the stack.
    expect(session.lastProviderError?.kind).toBe('quota_exhausted');
    // Buffered work is preserved rather than finalized away.
    expect(session.abortReason).toBe('quota:quota_exhausted');
  });

  it('proceeds normally when no breaker is armed', async () => {
    const transport = new FakeTransport([silentTurn()]);
    const provider = await readyProvider(transport, [observationMessage]);

    await provider.startSession(makeSession());

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
  });

  it('lets the generator that OWNS the in-flight probe spend its one exec', async () => {
    const transport = new FakeTransport([silentTurn()]);
    const armedAt = Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const admission = tryAdmitQuotaProbe('codex');
    expect(admission.admitted).toBe(true);

    const provider = await readyProvider(transport, [observationMessage]);
    // The route hands its claim to the session; this generator IS the probe.
    await provider.startSession(makeSession({ quotaProbeClaimId: admission.claimId }));

    expect(transport.calls.map(call => call.ctx.purpose)).toEqual(['observation']);
    releaseQuotaProbe('codex', admission.claimId);
  });

  it('withholds every OTHER session while that probe is out', async () => {
    const transport = new FakeTransport();
    const armedAt = Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const admission = tryAdmitQuotaProbe('codex');

    const provider = await readyProvider(transport, [observationMessage]);
    // The window has elapsed, so isQuotaCooldownActive() answers false here —
    // which is exactly why the circuit cannot be built on it.
    expect(isQuotaCooldownActive('codex')).toBe(false);

    const error = await provider
      .startSession(makeSession({ quotaProbeClaimId: (admission.claimId ?? 0) + 1 }))
      .then(() => null, (thrown: unknown) => thrown);

    expect(transport.calls).toHaveLength(0);
    expect(isClassified(error) && error.code).toBe('codex_quota_probe_in_flight');
    releaseQuotaProbe('codex', admission.claimId);
  });

  it('withholds a generator that started before the breaker armed and holds no claim', async () => {
    const transport = new FakeTransport();
    const armedAt = Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    const admission = tryAdmitQuotaProbe('codex');

    const provider = await readyProvider(transport, [observationMessage]);
    const error = await provider
      .startSession(makeSession({ quotaProbeClaimId: null }))
      .then(() => null, (thrown: unknown) => thrown);

    expect(transport.calls).toHaveLength(0);
    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
    releaseQuotaProbe('codex', admission.claimId);
  });

  it('is read-only: refusing never claims the probe another session must take', async () => {
    const transport = new FakeTransport();
    const armedAt = Date.now();
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);

    const provider = await readyProvider(transport, [observationMessage]);
    await provider.startSession(makeSession()).catch(() => {});

    expect(getQuotaCooldown('codex')?.probeInFlightSinceMs).toBeNull();
    expect(getQuotaCooldown('codex')?.probeClaimId).toBeNull();
    // And it never re-arms: arming is the route's job, from a real refusal.
    expect(getQuotaCooldown('codex')?.armedAtMs).toBe(armedAt);
  });

  it('is scoped to codex: another provider breaker does not gate it', async () => {
    const transport = new FakeTransport([silentTurn()]);
    recordQuotaExhausted('openrouter', 'Spend cap reached');

    const provider = await readyProvider(transport, [observationMessage]);
    await provider.startSession(makeSession());

    expect(transport.calls).toHaveLength(1);
    clearQuotaCooldown('openrouter');
  });

  // A turn is handed to the transport after the check above, and the
  // transport can then park it for a pool slot indefinitely (#2756). A breaker
  // armed while it waited must still stop it before a process exists.
  it('checks the circuit again once the slot is granted, so a turn parked when the breaker armed never spawns', async () => {
    let spawned = 0;
    class ParkedTransport extends FakeTransport {
      override async oneShot(prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
        // Parked for a slot; meanwhile another session's refusal arms the breaker.
        recordQuotaExhausted('codex', "You've hit your usage limit", 'quota_exhausted', Date.now(), Date.now() + 4 * 60 * 60_000);
        await ctx.beforeSpawn?.();
        spawned += 1;
        return super.oneShot(prompt, ctx);
      }
    }
    const transport = new ParkedTransport();
    const provider = await readyProvider(transport, [observationMessage]);
    const session = makeSession();

    const error = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

    expect(spawned).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(isClassified(error) && error.code).toBe('codex_quota_cooldown');
    // Stashed like the first check's refusal, for the route's .finally().
    expect(session.lastProviderError?.code).toBe('codex_quota_cooldown');
    expect(session.abortReason).toBe('quota:quota_exhausted');
  });

  it("keeps the probe's claim fresh each time it lets the probe through", async () => {
    const transport = new FakeTransport([silentTurn()]);
    const armedAt = Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 60 * 60_000;
    recordQuotaExhausted('codex', "You've hit your usage limit", undefined, armedAt);
    // Claimed almost a whole staleness window ago: a slow init exec.
    const claimedAt = Date.now() - QUOTA_PROBE_STALE_MS + 1_000;
    const admission = tryAdmitQuotaProbe('codex', claimedAt);
    expect(admission.admitted).toBe(true);

    const provider = await readyProvider(transport, [observationMessage]);
    await provider.startSession(makeSession({ quotaProbeClaimId: admission.claimId }));

    const refreshed = getQuotaCooldown('codex')!.probeInFlightSinceMs!;
    expect(refreshed).toBeGreaterThan(claimedAt);
    // So where the original claim would have gone stale, no second probe.
    expect(tryAdmitQuotaProbe('codex', claimedAt + QUOTA_PROBE_STALE_MS + 1).admitted).toBe(false);
    releaseQuotaProbe('codex', admission.claimId);
  });

  it('keeps the injectable seam M4 composes the exec budget onto', async () => {
    const calls: string[] = [];
    const transport = new FakeTransport([silentTurn()]);
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([observationMessage]), {
      transport,
      preflight: (_config, ctx) => { calls.push(ctx.purpose); },
    });
    const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();
    await verifyCodexLockdown(config.binaryPath!, {
      model: config.model,
      effort: config.effort,
      verbosity: config.verbosity,
      allowUntestedVersion: config.allowUntestedVersion,
      envSettings: {},
      probeRunner: probeRunner(),
    });

    await provider.startSession(makeSession());

    // The fake transport never reaches beforeSpawn, so this is the one check
    // made before the prompt is rendered.
    expect(calls).toEqual(['observation']);
  });
});

/**
 * getAiStatus reads this string (worker-service.ts). It must describe the
 * CACHED self-check for the configured binary, including the state where the
 * check has started and not finished — reporting a logged-out or unverified
 * Codex as "ChatGPT login" is how a user ends up staring at a silent observer.
 */
describe('CodexProvider.getAuthMethodDescription', () => {
  it('says "verifying" while the self-check is still running, then the real verdict', async () => {
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), { transport: new FakeTransport() });
    const config = (provider as unknown as { getConfig(): CodexConfig }).getConfig();

    expect(provider.getAuthMethodDescription()).toBe('Codex CLI (not verified yet)');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedRunner = probeRunner();
    const pending = verifyCodexLockdown(config.binaryPath!, {
      model: config.model,
      effort: config.effort,
      verbosity: config.verbosity,
      allowUntestedVersion: config.allowUntestedVersion,
      envSettings: {},
      probeRunner: async (request) => {
        if (request.kind === 'version') await gate;
        return gatedRunner(request);
      },
    });

    expect(provider.lockdownStatus()?.state).toBe('pending');
    expect(provider.getAuthMethodDescription()).toBe('Codex CLI (verifying ChatGPT login)');

    release();
    expect((await pending).state).toBe('passed');
    expect(provider.getAuthMethodDescription()).toBe('Codex CLI (ChatGPT login)');
  });

  it('never borrows another binary verdict when this one cannot be resolved', () => {
    settings.CLAUDE_MEM_CODEX_PATH = '/nonexistent/codex';
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), { transport: new FakeTransport() });

    expect(provider.getAuthMethodDescription()).toBe('Codex CLI (not found; install it or set CLAUDE_MEM_CODEX_PATH)');
  });
});

/**
 * The readiness surface the route's codex gate reads (M3, plan 3.5). The gate
 * must be able to ask "ready?" on the ingest path without anything spawning,
 * and to start the model-free self-check in the background when the answer is
 * "not yet".
 */
describe('CodexProvider readiness surface (M3 gate)', () => {
  const PASSED = (binaryPath: string) => ({
    state: 'passed' as const,
    binaryPath,
    cacheKey: 'key',
    version: '0.144.4',
    authMethod: 'chatgpt' as const,
    failure: null,
    warnings: [],
    startedAt: 0,
    finishedAt: 1,
  });

  it('is what the gate recognises as a readiness source', () => {
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), { transport: new FakeTransport() });
    expect(isCodexReadinessSource(provider)).toBe(true);
  });

  it('reports a missing binary without starting anything', async () => {
    settings.CLAUDE_MEM_CODEX_PATH = join(tmpdir(), 'claude-mem-no-such-codex-binary');
    const startSelfCheck = mock(() => {});
    const runSelfCheck = mock(async (binaryPath: string) => PASSED(binaryPath));
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport: new FakeTransport(),
      startSelfCheck,
      runSelfCheck,
    });

    expect(provider.readinessSnapshot().state).toBe('binary_missing');
    expect(await provider.verifyLockdown()).toBeNull();
    expect(startSelfCheck).not.toHaveBeenCalled();
    expect(runSelfCheck).not.toHaveBeenCalled();
  });

  it('is unverified until a check runs, pending while it runs, and passed after — without spawning a turn', async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = probeRunner();
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport,
      runSelfCheck: (binaryPath, options) => verifyCodexLockdown(binaryPath, {
        ...options,
        probeRunner: async (request) => {
          if (request.kind === 'version') await gate;
          return runner(request);
        },
      }),
    });

    expect(provider.readinessSnapshot()).toEqual({ state: 'unverified' });

    const running = provider.verifyLockdown();
    expect(provider.readinessSnapshot()).toEqual({ state: 'pending' });

    release();
    expect((await running)?.state).toBe('passed');
    expect(provider.readinessSnapshot()).toEqual({ state: 'passed' });
    expect(transport.calls).toHaveLength(0);
  });

  it('reports a failed verdict with the failure the gate books', async () => {
    const runner = probeRunner();
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport: new FakeTransport(),
      runSelfCheck: (binaryPath, options) => verifyCodexLockdown(binaryPath, {
        ...options,
        probeRunner: async (request) => request.kind === 'login_status'
          ? { exitCode: 1, signal: null, stdout: '', stderr: 'Not logged in\n', timedOut: false }
          : runner(request),
      }),
    });

    expect((await provider.verifyLockdown())?.state).toBe('failed');
    const snapshot = provider.readinessSnapshot();
    expect(snapshot.state).toBe('failed');
    expect(snapshot.state === 'failed' && snapshot.result.authMethod).toBe('not_logged_in');
  });

  it('fingerprints the setup with the very key a finished verdict is cached under, and changes with it', async () => {
    const runner = probeRunner();
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport: new FakeTransport(),
      runSelfCheck: (binaryPath, options) => verifyCodexLockdown(binaryPath, { ...options, probeRunner: runner }),
    });

    const before = provider.readinessFingerprint();
    const verdict = await provider.verifyLockdown();
    expect(before).not.toBeNull();
    expect(verdict?.cacheKey).toBe(before);
    // Stable while nothing changes...
    expect(provider.readinessFingerprint()).toBe(before);
    // ...and different when a setting the check depends on changes.
    settings.CLAUDE_MEM_CODEX_MODEL = 'gpt-5.6-luna-mini';
    expect(provider.readinessFingerprint()).not.toBe(before);

    settings.CLAUDE_MEM_CODEX_PATH = join(tmpdir(), 'claude-mem-no-such-codex-binary');
    expect(provider.readinessFingerprint()).toBeNull();
  });

  it('checks the summary model too: it is a self-check input and part of the key', async () => {
    const runner = probeRunner();
    const runSelfCheck = mock((binaryPath: string, options: VerifyCodexLockdownOptions) =>
      verifyCodexLockdown(binaryPath, { ...options, probeRunner: runner }));
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport: new FakeTransport(),
      runSelfCheck,
    });

    const observerOnly = provider.readinessFingerprint();
    settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL = 'gpt-5.6-luna'; // the observer model: same key
    expect(provider.readinessFingerprint()).toBe(observerOnly);

    // Summary and wrap-up execs run this model, and the catalog does not list it.
    settings.CLAUDE_MEM_CODEX_SUMMARY_MODEL = 'gpt-5.3-codex';
    expect(provider.readinessFingerprint()).not.toBe(observerOnly);
    const verdict = await provider.verifyLockdown();
    expect(runSelfCheck.mock.calls[0][1]).toMatchObject({ model: 'gpt-5.6-luna', summaryModel: 'gpt-5.3-codex' });
    expect(verdict?.state).toBe('failed');
    expect(verdict?.failure?.step).toBe('models_catalog');
    expect(verdict?.failure?.error.message).toContain('summary model gpt-5.3-codex is not in the Codex model catalog');
    expect(provider.readinessSnapshot().state).toBe('failed');
  });

  it('passes `force` through with the same inputs the status read keys on', async () => {
    const runSelfCheck = mock(async (binaryPath: string) => PASSED(binaryPath));
    const provider = new CodexProvider(makeDbManager(), makeSessionManager([]), {
      transport: new FakeTransport(),
      runSelfCheck,
    });

    await provider.verifyLockdown({ force: true });
    await provider.verifyLockdown();

    expect(runSelfCheck.mock.calls[0][1]).toMatchObject({
      force: true,
      model: 'gpt-5.6-luna',
      summaryModel: 'gpt-5.6-luna',
      effort: 'low',
      verbosity: 'low',
      allowUntestedVersion: false,
      envSettings: {},
    });
    expect((runSelfCheck.mock.calls[1][1] as { force?: boolean }).force).toBeUndefined();
  });

  it("tells the route which quota refusals are the circuit's own", async () => {
    resetQuotaCooldownsForTesting();
    try {
      const provider = await readyProvider(new FakeTransport(), [observationMessage]);
      const session = makeSession();
      recordQuotaExhausted('codex', "You've hit your usage limit", '5h', Date.now(), Date.now() + 60 * 60_000);

      const refusal = await provider.startSession(session).then(() => null, (thrown: unknown) => thrown);

      expect(isCodexQuotaCircuitRefusal(refusal)).toBe(true);
      // A refusal Codex itself returned is news, and must be booked.
      expect(isCodexQuotaCircuitRefusal(new ClassifiedProviderError("You've hit your usage limit", {
        kind: 'quota_exhausted',
        cause: null,
        code: 'codex_usage_limit',
      }))).toBe(false);
      expect(isCodexQuotaCircuitRefusal(new Error('codex_quota_cooldown'))).toBe(false);
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });
});
