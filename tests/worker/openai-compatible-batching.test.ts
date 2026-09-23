/**
 * The M4 cost hooks of OpenAICompatibleProvider (plan 3.3, hooks 8-10), driven
 * through the REAL SessionManager and its in-RAM buffer:
 *
 *   - deferInitQuery: no standalone init call; the init turn becomes the head
 *     of the first real call;
 *   - freshGenerationOnStart: a (re)started generator does not re-send the
 *     turns a paused run left behind;
 *   - observationBatchPolicy / buildObservationTurn: consecutive observations
 *     share one turn, and the claimed set is confirmed or reset as a whole.
 *
 * Each hook is off by default; what "off" means byte-for-byte for OpenRouter
 * and Gemini is pinned by provider-prompt-snapshots.test.ts. Here the defaults
 * are only checked where a hook could leak into them (the batch claim must
 * never run without a policy).
 */

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../../src/services/domain/types.js';
import {
  OpenAICompatibleProvider,
  type ProviderQueryContext,
  type ProviderQueryResult,
} from '../../src/services/worker/OpenAICompatibleProvider.js';
import { SessionManager, type ObservationBatchPolicy } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession, ConversationMessage, ObservationData } from '../../src/services/worker-types.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import * as recycleConversation from '../../src/services/worker/session/recycle-conversation.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  buildObservationPrompt,
  buildObservationBatchPrompt,
  type Observation,
} from '../../src/sdk/prompts.js';
import {
  renderCodexPromptFromConversation,
  renderCodexTranscriptPrefix,
} from '../../src/services/worker/codex/codex-prompt.js';

const SESSION = 1;
const T0 = Date.parse('2026-09-21T09:00:00.000Z');
const OPEN = '<observed_from_primary_session>';

interface TestConfig {
  apiKey: string;
  model: string;
  plainText?: boolean;
}

interface Call {
  purpose: ProviderQueryContext['purpose'] | undefined;
  history: ConversationMessage[];
  rendered: string;
}

const OBSERVATION_REPLY = '<observation><type>discovery</type><title>t</title><narrative>n</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>';
const SUMMARY_REPLY = '<summary><request>r</request><investigated>i</investigated><learned>l</learned><completed>c</completed><next_steps>n</next_steps><notes></notes></summary>';

interface HookOptions {
  deferInit?: boolean;
  fresh?: boolean;
  policy?: ObservationBatchPolicy | null;
  reply?: (call: Call) => ProviderQueryResult | Promise<ProviderQueryResult>;
}

class HookedProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = true;
  protected readonly wantsQueryContext = true;
  protected readonly deferInitQuery: boolean;
  protected readonly freshGenerationOnStart: boolean;
  readonly calls: Call[] = [];
  private readonly options: HookOptions;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager, options: HookOptions = {}) {
    super(dbManager, sessionManager);
    this.options = options;
    this.deferInitQuery = options.deferInit ?? false;
    this.freshGenerationOnStart = options.fresh ?? false;
  }

  protected getConfig(): TestConfig {
    return { apiKey: 'k', model: 'test-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected observationBatchPolicy(): ObservationBatchPolicy | null {
    return this.options.policy ?? null;
  }

  protected async query(
    history: ConversationMessage[],
    _config: TestConfig,
    _signal?: AbortSignal,
    ctx?: ProviderQueryContext,
  ): Promise<ProviderQueryResult> {
    const call: Call = {
      purpose: ctx?.purpose,
      history: history.map(message => ({ ...message })),
      // What a Codex-style transport would put on stdin for this call.
      rendered: renderCodexPromptFromConversation(history),
    };
    this.calls.push(call);
    if (this.options.reply) return this.options.reply(call);
    if (call.purpose === 'summary') return { content: SUMMARY_REPLY };
    if (call.purpose === 'init') return { content: 'ready' };
    return { content: OBSERVATION_REPLY };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function snapshotMode(): ModeConfig {
  const prompts = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? `«${key}»` : undefined) });
  return { name: 'm', prompts, observation_types: [{ id: 'discovery' }], observation_concepts: [] } as unknown as ModeConfig;
}

function harness() {
  const storeObservations = mock((
    _memorySessionId: string, _project: string, observations: unknown[], summary: unknown,
    _promptNumber: number, _tokens: number, _createdAtEpoch?: number,
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
    toolUseId: `tu-${toolCounter}`,
    ...overrides,
  };
}

/**
 * Run one generator to the point where the buffer is empty, then end it the
 * way a shutdown does. A safety abort keeps a broken test from hanging.
 */
async function runUntilDrained(provider: HookedProvider, sm: SessionManager, session: ActiveSession): Promise<void> {
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

describe('OpenAICompatibleProvider M4 hooks', () => {
  beforeEach(() => {
    setSystemTime(new Date(T0));
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => snapshotMode(),
      loadMode: () => {},
    } as unknown as ModeManager));
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults());
    spyOn(recycleConversation, 'loadSessionStartContext').mockResolvedValue('');
    for (const level of ['debug', 'info', 'warn', 'error', 'success'] as const) {
      spyOn(logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    setSystemTime();
    mock.restore();
  });

  describe('defaults', () => {
    it('never touches the batch claim without a policy, and answers one observation per turn', async () => {
      const { sm, session, dbManager, confirmed } = harness();
      const claim = spyOn(sm, 'claimObservationBatch');
      await sm.queueObservation(SESSION, obsData());
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm);

      await runUntilDrained(provider, sm, session);

      expect(claim).not.toHaveBeenCalled();
      expect(provider.calls.map(call => call.purpose)).toEqual(['init', 'observation', 'observation']);
      expect(confirmed).toEqual([[1], [2]]);
    });
  });

  describe('deferInitQuery', () => {
    it('spends no call on the init prompt: it becomes the first turn of the first real call', async () => {
      const { sm, session, dbManager, confirmed } = harness();
      await sm.queueObservation(SESSION, obsData({ tool_name: 'Read' }));
      await sm.queueObservation(SESSION, obsData({ tool_name: 'Bash' }));
      await sm.queueSummarize(SESSION, 'done');
      const provider = new HookedProvider(dbManager, sm, { deferInit: true });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls.map(call => call.purpose)).toEqual(['observation', 'observation', 'summary']);
      const [first, second] = provider.calls;
      expect(first.history).toHaveLength(2);
      expect(first.history.map(message => message.role)).toEqual(['user', 'user']);
      expect(first.history[0].content).toContain('<user_request>Refactor the parser</user_request>');
      expect(first.history[1].content).toContain('<what_happened>Read</what_happened>');
      // The init turn stays the stable head of every later call.
      expect(second.history[0]).toEqual(first.history[0]);
      expect(confirmed).toEqual([[1], [2], [3]]);
    });

    it('a generator that ends before any work arrives costs nothing at all', async () => {
      const { sm, session, dbManager } = harness();
      const provider = new HookedProvider(dbManager, sm, { deferInit: true });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls).toEqual([]);
      expect(session.conversationHistory).toHaveLength(1);
    });

    it('without the hook the init prompt is still sent on its own first', async () => {
      const { sm, session, dbManager } = harness();
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm);

      await runUntilDrained(provider, sm, session);

      expect(provider.calls.map(call => call.purpose)).toEqual(['init', 'observation']);
      expect(provider.calls[0].history).toHaveLength(1);
    });
  });

  describe('freshGenerationOnStart', () => {
    const leftover: ConversationMessage[] = [
      { role: 'user', content: 'OLD INIT' },
      { role: 'user', content: 'OLD OBSERVATION' },
      { role: 'assistant', content: 'OLD REPLY' },
    ];

    it('drops the turns a paused run left behind before the new init turn', async () => {
      const { sm, session, dbManager } = harness();
      session.conversationHistory = leftover.map(message => ({ ...message }));
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm, { deferInit: true, fresh: true });

      await runUntilDrained(provider, sm, session);

      const sent = provider.calls[0].history;
      expect(sent.some(message => message.content.startsWith('OLD'))).toBe(false);
      expect(sent[0].content).toContain('<user_request>Refactor the parser</user_request>');
    });

    it('without the hook the old turns are kept and the init turn is appended', async () => {
      const { sm, session, dbManager } = harness();
      session.conversationHistory = leftover.map(message => ({ ...message }));
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm, { deferInit: true });

      await runUntilDrained(provider, sm, session);

      const sent = provider.calls[0].history;
      expect(sent.slice(0, 3)).toEqual(leftover);
      expect(sent[3].content).toContain('<user_request>Refactor the parser</user_request>');
    });
  });

  describe('observation batching', () => {
    const POLICY: ObservationBatchPolicy = { maxMessages: 4, maxChars: 48_000, lingerMs: 0 };

    it('sends consecutive observations as one turn, stamps each with its own time, and confirms them together', async () => {
      const { sm, session, dbManager, confirmed, storeObservations } = harness();
      for (let i = 0; i < 3; i++) {
        setSystemTime(new Date(T0 + i * 1_000));
        await sm.queueObservation(SESSION, obsData({ tool_name: `Step${i}` }));
      }
      await sm.queueSummarize(SESSION, 'done');
      const provider = new HookedProvider(dbManager, sm, { deferInit: true, fresh: true, policy: POLICY });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls.map(call => call.purpose)).toEqual(['observation', 'summary']);
      const turn = provider.calls[0].history.at(-1)!.content;
      expect(turn.split(OPEN)).toHaveLength(4);
      expect(turn).toContain('The 3 tool uses above are consecutive, oldest first.');
      expect(turn.indexOf('<what_happened>Step0</what_happened>')).toBeLessThan(turn.indexOf('<what_happened>Step2</what_happened>'));
      expect(turn).toContain('<occurred_at>2026-09-21T09:00:00.000Z</occurred_at>');
      expect(turn).toContain('<occurred_at>2026-09-21T09:00:01.000Z</occurred_at>');
      expect(turn).toContain('<occurred_at>2026-09-21T09:00:02.000Z</occurred_at>');
      // One confirm for the whole batch, then the summary on its own.
      expect(confirmed).toEqual([[1, 2, 3], [4]]);
      // The stored rows carry the batch's earliest enqueue time.
      expect(storeObservations.mock.calls[0][6]).toBe(T0);
    });

    it('lingers for the rest of a burst when the queue is idle', async () => {
      const { sm, session, dbManager, confirmed } = harness();
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm, {
        deferInit: true,
        policy: { maxMessages: 3, maxChars: 48_000, lingerMs: 2_000 },
      });
      setTimeout(() => { void sm.queueObservation(SESSION, obsData()); }, 20);
      setTimeout(() => { void sm.queueObservation(SESSION, obsData()); }, 40);

      await runUntilDrained(provider, sm, session);

      expect(provider.calls.map(call => call.purpose)).toEqual(['observation']);
      expect(confirmed).toEqual([[1, 2, 3]]);
    });

    it('resets the whole claimed batch to pending when the reply is a refusal', async () => {
      const { sm, session, dbManager, storeObservations } = harness();
      for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData());
      await sm.queueSummarize(SESSION, 'done');
      const provider = new HookedProvider(dbManager, sm, {
        deferInit: true,
        policy: POLICY,
        reply: () => ({ content: "You've hit your session limit · resets 5:50pm" }),
      });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls).toHaveLength(1);
      expect(storeObservations).not.toHaveBeenCalled();
      expect(session.abortReason).toBe('quota:observer_text');
      expect(session.claimedMessageIds).toEqual([]);
      // Nothing was lost and nothing is stuck claimed: all four wait again.
      expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(4);
      expect(sm.getMessageBuffer().getUnclaimedCount(SESSION)).toBe(4);
    });

    it('a failed call leaves the whole batch for the next generator, which re-yields it in order', async () => {
      const { sm, session, dbManager } = harness();
      for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData({ tool_name: `Step${i}` }));
      const provider = new HookedProvider(dbManager, sm, {
        deferInit: true,
        policy: POLICY,
        reply: () => {
          throw new ClassifiedProviderError('usage limit', { kind: 'quota_exhausted', cause: new Error('limit') });
        },
      });

      await expect(provider.startSession(session)).rejects.toThrow();

      expect(session.claimedMessageIds).toHaveLength(3);
      expect(session.abortController.signal.aborted).toBe(true);
      // What the route does before the next start: a fresh controller.
      session.abortController = new AbortController();
      const iterator = sm.getMessageIterator(SESSION);
      const again: string[] = [];
      for (let i = 0; i < 3; i++) again.push((await iterator.next()).value!.tool_name!);
      expect(again).toEqual(['Step0', 'Step1', 'Step2']);
      sm.getSession(SESSION)!.abortController.abort();
      await iterator.return?.();
    });

    it('does not start a call when the session aborts while lingering', async () => {
      const { sm, session, dbManager } = harness();
      await sm.queueObservation(SESSION, obsData());
      const provider = new HookedProvider(dbManager, sm, {
        deferInit: true,
        // Well inside the test timeout, so a linger that ignored the abort
        // fails the elapsed assertion below rather than timing the test out.
        policy: { maxMessages: 4, maxChars: 48_000, lingerMs: 3_000 },
      });
      setTimeout(() => session.abortController.abort(), 30);

      // performance.now(), not Date.now(): setSystemTime freezes Date.now() in
      // this file, so an elapsed time measured with it is always 0.
      const start = performance.now();
      await provider.startSession(session);

      expect(performance.now() - start).toBeLessThan(1_000);
      expect(provider.calls).toEqual([]);
      // Still buffered and still claimed; the next generator resets it.
      expect(sm.getMessageBuffer().getPendingCount(SESSION)).toBe(1);
    });

    it('files the batch under ITS prompt and project even when a new prompt re-initializes the session mid-linger', async () => {
      const { sm, session, dbManager, storeObservations } = harness();
      await sm.queueObservation(SESSION, obsData({ tool_name: 'PromptOneTool', prompt_number: 1 }));
      const provider = new HookedProvider(dbManager, sm, {
        deferInit: true,
        policy: { maxMessages: 4, maxChars: 48_000, lingerMs: 300 },
      });
      // The user submits prompt 2 (in another project root) while the batch is
      // still lingering for company: the session-init route re-initializes the
      // live session, overwriting lastPromptNumber and project.
      setTimeout(() => { sm.initializeSession(SESSION, 'prompt two', 2, 'otherproj'); }, 100);

      await runUntilDrained(provider, sm, session);

      expect(session.lastPromptNumber).toBe(2);
      expect(provider.calls.map(call => call.purpose)).toEqual(['observation']);
      expect(storeObservations).toHaveBeenCalledTimes(1);
      const [, project, , , promptNumber] = storeObservations.mock.calls[0];
      expect(project).toBe('proj');
      expect(promptNumber).toBe(1);
    });

    it('maxMessages 1 sends exactly the turn an unbatched provider sends', async () => {
      const turns: string[] = [];
      for (const policy of [null, { maxMessages: 1, maxChars: 48_000, lingerMs: 2_000 }]) {
        const { sm, session, dbManager } = harness();
        await sm.queueObservation(SESSION, obsData({ tool_name: 'Same', tool_input: { a: 1 } }));
        const provider = new HookedProvider(dbManager, sm, { deferInit: true, policy });
        await runUntilDrained(provider, sm, session);
        turns.push(provider.calls[0].history.at(-1)!.content);
      }
      expect(turns[1]).toBe(turns[0]);
      expect(turns[0]).toBe(buildObservationPrompt({
        id: 0,
        tool_name: 'Same',
        tool_input: JSON.stringify({ a: 1 }),
        tool_output: JSON.stringify({ ok: true }),
        created_at_epoch: T0,
        cwd: '/repo',
      }));
    });

    it('the default buildObservationTurn sends every claimed observation', async () => {
      const { sm, session, dbManager } = harness();
      const inputs: Observation[] = [];
      for (let i = 0; i < 2; i++) {
        await sm.queueObservation(SESSION, obsData({ tool_name: `T${i}`, tool_input: { i } }));
        inputs.push({
          id: 0, tool_name: `T${i}`, tool_input: JSON.stringify({ i }), tool_output: JSON.stringify({ ok: true }),
          created_at_epoch: T0, cwd: '/repo',
        });
      }
      const provider = new HookedProvider(dbManager, sm, { deferInit: true, policy: POLICY });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls[0].history.at(-1)!.content).toBe(buildObservationBatchPrompt(inputs));
    });

    it('keeps the byte-prefix invariant across batched calls', async () => {
      const { sm, session, dbManager } = harness();
      for (let i = 0; i < 3; i++) await sm.queueObservation(SESSION, obsData());
      await sm.queueObservation(SESSION, obsData({ prompt_number: 2 }));
      await sm.queueObservation(SESSION, obsData({ prompt_number: 2 }));
      await sm.queueSummarize(SESSION, 'done');
      const provider = new HookedProvider(dbManager, sm, { deferInit: true, fresh: true, policy: POLICY });

      await runUntilDrained(provider, sm, session);

      expect(provider.calls.map(call => call.purpose)).toEqual(['observation', 'observation', 'summary']);
      for (let k = 0; k + 1 < provider.calls.length; k++) {
        // Call k's history — its current task included — is re-sent verbatim
        // as the opening bytes of call k+1.
        const sentBefore = renderCodexTranscriptPrefix(provider.calls[k].history);
        expect(provider.calls[k + 1].rendered.startsWith(sentBefore)).toBe(true);
      }
    });
  });
});
