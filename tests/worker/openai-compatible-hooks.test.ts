import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import {
  OpenAICompatibleProvider,
  type ProviderQueryContext,
  type ProviderQueryResult,
} from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { FieldCompressor } from '../../src/services/worker/field-optimizer.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

/**
 * The base-class hooks are opt-in, and "opt-in" has to mean something stronger
 * than "the suite still passes": a provider that overrides nothing must be
 * driven the way it was driven before the hooks existed, down to how many
 * arguments its query() receives. These tests pin that, and pin what each
 * override actually changes.
 */

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

const FIELD_COMPRESSION_PROMPT_HEAD = 'Condense the tool payload below';

interface TestConfig {
  apiKey: string;
  model: string;
  plainText?: boolean;
}

interface QueryCall {
  argCount: number;
  history: ConversationMessage[];
  config: TestConfig;
  signal: AbortSignal | undefined;
  ctx: ProviderQueryContext | undefined;
}

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
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
    lastGeneratorActivity: Date.now(),
    ...overrides,
  } as ActiveSession;
}

/**
 * Records the EXACT argument list of every query, which is the whole point:
 * a rest tuple cannot silently absorb an extra argument the way named
 * parameters can.
 */
class HookProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  readonly calls: QueryCall[] = [];
  apiKey = 'test-api-key';

  protected getConfig(): TestConfig {
    return { apiKey: this.apiKey, model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(
    ...args: [ConversationMessage[], TestConfig, (AbortSignal | undefined)?, (ProviderQueryContext | undefined)?]
  ): Promise<ProviderQueryResult> {
    const [history, config, signal, ctx] = args;
    this.calls.push({
      argCount: args.length,
      history: history.map(message => ({ ...message })),
      config,
      signal,
      ctx,
    });
    // Field compression is the one off-to-the-side, single-message call; answer
    // it usably so the success path (a <condensed> block) is exercised.
    return history.length === 1 && history[0].content.startsWith(FIELD_COMPRESSION_PROMPT_HEAD)
      ? { content: 'condensed payload' }
      : { content: '' };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function messageIterator(messages: unknown[]) {
  return {
    getMessageIterator: async function* () {
      for (const message of messages) yield message;
    },
  } as never;
}

const oversizedToolInput = { file_path: 'src/main.ts', blob: 'x'.repeat(20_000) };

const observationMessage = {
  type: 'observation',
  tool_name: 'Read',
  tool_input: { file_path: 'src/main.ts' },
  tool_response: 'file contents',
  prompt_number: 2,
};

const summarizeMessage = { type: 'summarize', last_assistant_message: 'done' };

describe('OpenAICompatibleProvider opt-in hooks', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as unknown as ModeManager));
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(
      () => SettingsDefaultsManager.getAllDefaults(),
    );
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  describe('wantsQueryContext', () => {
    it('leaves the lifecycle calls of an opted-out provider at exactly two arguments', async () => {
      const provider = new HookProvider({} as never, messageIterator([observationMessage, summarizeMessage]));

      await provider.startSession(makeSession());

      expect(provider.calls.map(call => call.argCount)).toEqual([2, 2, 2]);
      expect(provider.calls.every(call => call.ctx === undefined)).toBe(true);
      expect(provider.calls.every(call => call.signal === undefined)).toBe(true);
    });

    it('leaves the field-compression call of an opted-out provider at exactly three', async () => {
      const provider = new HookProvider({} as never, messageIterator([]));
      const controller = new AbortController();

      await (provider as any).compressField('payload', 100, { apiKey: 'k', model: 'm' }, controller.signal);

      expect(provider.calls.map(call => call.argCount)).toEqual([3]);
      expect(provider.calls[0].signal).toBe(controller.signal);
      expect(provider.calls[0].ctx).toBeUndefined();
    });

    it('delivers the context as a fourth argument only when the provider asks for it', async () => {
      class ContextProvider extends HookProvider {
        protected readonly wantsQueryContext = true;
      }
      const provider = new ContextProvider({} as never, messageIterator([observationMessage, summarizeMessage]));
      const session = makeSession();

      await provider.startSession(session);

      expect(provider.calls.map(call => call.argCount)).toEqual([4, 4, 4]);
      expect(provider.calls.map(call => call.ctx?.purpose)).toEqual(['init', 'observation', 'summary']);
      expect(provider.calls.every(call => call.ctx?.session === session)).toBe(true);
    });

    it('labels the field-compression call and attributes it to the session being observed', async () => {
      class ContextProvider extends HookProvider {
        protected readonly wantsQueryContext = true;
      }
      const provider = new ContextProvider({} as never, messageIterator([
        { ...observationMessage, tool_input: oversizedToolInput },
      ]));
      const session = makeSession();

      await provider.startSession(session);

      // init, the compression pass, then the observation itself.
      const compression = provider.calls[1];
      expect(compression.argCount).toBe(4);
      // The session travels with it. Without this a provider that spawns a
      // subprocess per call runs the compression exec under sessionDbId 0 — a
      // jail directory and a lockdown-violation counter shared by every
      // session in the process.
      expect(compression.ctx).toEqual({
        purpose: 'field-compression',
        session,
        sessionDbId: session.sessionDbId,
      });
      // Still its own bounded signal, never the session's controller.
      expect(compression.signal).toBeInstanceOf(AbortSignal);
      expect(compression.signal).not.toBe(session.abortController.signal);
    });

    it('carries no session when compressField is called without one', async () => {
      class ContextProvider extends HookProvider {
        protected readonly wantsQueryContext = true;
      }
      const provider = new ContextProvider({} as never, messageIterator([]));
      const controller = new AbortController();

      await (provider as any).compressField('payload', 100, { apiKey: 'k', model: 'm' }, controller.signal);

      expect(provider.calls[0].argCount).toBe(4);
      expect(provider.calls[0].ctx).toEqual({ purpose: 'field-compression' });
      expect(provider.calls[0].signal).toBe(controller.signal);
    });
  });

  describe('isConfigured', () => {
    it('defaults to the API-key check both paths used to do inline', async () => {
      const provider = new HookProvider({} as never, messageIterator([observationMessage]));
      provider.apiKey = '';

      await expect(provider.startSession(makeSession())).rejects.toThrow('missing key');
      await expect(provider.formatTelegramWrapup({ summaryText: 'summary' } as never)).rejects.toThrow('missing key');
      expect(provider.calls).toHaveLength(0);
    });

    it('lets a provider be ready without an API key at all', async () => {
      class KeylessProvider extends HookProvider {
        protected isConfigured(): boolean {
          return true;
        }
      }
      const provider = new KeylessProvider({} as never, messageIterator([]));
      provider.apiKey = '';

      await provider.startSession(makeSession());

      expect(provider.calls.map(call => call.ctx)).toEqual([undefined]);
      expect(provider.calls[0].config.apiKey).toBe('');
    });
  });

  describe('fieldCompressor', () => {
    it('defaults to the bounded compressField pass, so an oversized field is condensed', async () => {
      const provider = new HookProvider({} as never, messageIterator([
        { ...observationMessage, tool_input: oversizedToolInput },
      ]));

      await provider.startSession(makeSession());

      // init, the compression pass, then the observation itself.
      expect(provider.calls).toHaveLength(3);
      expect(provider.calls[1].history[0].content.startsWith(FIELD_COMPRESSION_PROMPT_HEAD)).toBe(true);
      const observationPrompt = provider.calls[2].history.at(-1)!.content;
      expect(observationPrompt).toContain('<condensed original_size_chars=');
      // The prompt's own boilerplate mentions `<elided chars=... />`, so the
      // discriminator is a real marker's quoted count (escaped or not, the
      // field may be embedded as a JSON string).
      expect(observationPrompt).not.toMatch(/<elided chars=\\?"/);
    });

    it('skips optimizeObservationFields entirely when a provider returns null', async () => {
      class NoCompressionProvider extends HookProvider {
        protected fieldCompressor(): FieldCompressor | null {
          return null;
        }
      }
      const provider = new NoCompressionProvider({} as never, messageIterator([
        { ...observationMessage, tool_input: oversizedToolInput },
      ]));

      await provider.startSession(makeSession());

      // No compression pass: init, then the observation, which falls back to
      // the existing truncation marker.
      expect(provider.calls).toHaveLength(2);
      const observationPrompt = provider.calls[1].history.at(-1)!.content;
      expect(observationPrompt).toMatch(/<elided chars=\\?"/);
      expect(observationPrompt).not.toContain('<condensed');
    });
  });

  describe('resolveSummaryModel', () => {
    it('defaults to the shared tier routing for the summary turn', async () => {
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
        CLAUDE_MEM_TIER_SUMMARY_MODEL: 'summary-model',
      }));
      const provider = new HookProvider({} as never, messageIterator([summarizeMessage]));

      await provider.startSession(makeSession());

      expect(provider.calls.map(call => call.config.model)).toEqual(['session-model', 'summary-model']);
    });

    it('lets a provider keep another backend tier alias out of its request', async () => {
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
        CLAUDE_MEM_TIER_SUMMARY_MODEL: 'summary-model',
      }));
      class OwnModelProvider extends HookProvider {
        protected resolveSummaryModel(config: TestConfig): string {
          return config.model;
        }
      }
      const provider = new OwnModelProvider({} as never, messageIterator([summarizeMessage]));

      await provider.startSession(makeSession());

      expect(provider.calls.map(call => call.config.model)).toEqual(['session-model', 'session-model']);
    });
  });

  describe('adoptForeignMemorySessionId', () => {
    function dbWithPersistedId(memorySessionId: string, updateMemorySessionId: () => void) {
      return {
        getSessionById: () => ({ memory_session_id: memorySessionId }),
        getSessionStore: () => ({ updateMemorySessionId }),
      } as never;
    }

    it('defaults to superseding an id written by another provider', async () => {
      const updateMemorySessionId = mock(() => {});
      const provider = new HookProvider(
        dbWithPersistedId('claude-native-id', updateMemorySessionId),
        messageIterator([]),
      );
      const session = makeSession({ memorySessionId: null });

      await provider.startSession(session);

      expect(session.memorySessionId).toStartWith('test-test-session-');
      expect(updateMemorySessionId).toHaveBeenCalledTimes(1);
    });

    it('adopts it when the provider opts in, without rewriting the row', async () => {
      const updateMemorySessionId = mock(() => {});
      class AdoptingProvider extends HookProvider {
        protected readonly adoptForeignMemorySessionId = true;
      }
      const provider = new AdoptingProvider(
        dbWithPersistedId('claude-native-id', updateMemorySessionId),
        messageIterator([]),
      );
      const session = makeSession({ memorySessionId: null });

      await provider.startSession(session);

      expect(session.memorySessionId).toBe('claude-native-id');
      expect(updateMemorySessionId).not.toHaveBeenCalled();
    });

    it('still generates one when nothing is persisted, opted in or not', async () => {
      const updateMemorySessionId = mock(() => {});
      class AdoptingProvider extends HookProvider {
        protected readonly adoptForeignMemorySessionId = true;
      }
      const provider = new AdoptingProvider(
        { getSessionById: () => ({ memory_session_id: null }), getSessionStore: () => ({ updateMemorySessionId }) } as never,
        messageIterator([]),
      );
      const session = makeSession({ memorySessionId: null });

      await provider.startSession(session);

      expect(session.memorySessionId).toStartWith('test-test-session-');
      // Generated in memory, but NOT published: an adopting provider leaves the
      // NULL row to ensureMemorySessionIdRegistered on the first store, so a
      // session that never stores anything costs no UPDATE and no prompt-sync
      // requeue. The default (below) still writes it at session start.
      expect(updateMemorySessionId).not.toHaveBeenCalled();
    });

    it('publishes a generated id at session start only when the provider does NOT adopt', async () => {
      const updateMemorySessionId = mock(() => {});
      const provider = new HookProvider(
        { getSessionById: () => ({ memory_session_id: null }), getSessionStore: () => ({ updateMemorySessionId }) } as never,
        messageIterator([]),
      );
      const session = makeSession({ memorySessionId: null });

      await provider.startSession(session);

      expect(updateMemorySessionId).toHaveBeenCalledTimes(1);
      expect(updateMemorySessionId).toHaveBeenCalledWith(session.sessionDbId, session.memorySessionId);
    });
  });

  describe('conversationMaxChars', () => {
    it('is handed the session it is budgeting for', async () => {
      const seen: Array<ActiveSession | undefined> = [];
      class BudgetProvider extends HookProvider {
        protected conversationMaxChars(session?: ActiveSession): number {
          seen.push(session);
          return super.conversationMaxChars(session);
        }
      }
      const provider = new BudgetProvider({} as never, messageIterator([observationMessage]));
      const session = makeSession();

      await provider.startSession(session);

      expect(seen).toEqual([session]);
    });
  });
});
