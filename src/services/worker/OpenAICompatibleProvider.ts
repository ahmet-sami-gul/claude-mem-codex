import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager, type ObservationBatchPolicy } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  buildInitPrompt,
  buildObservationPrompt,
  buildObservationBatchPrompt,
  buildSummaryPrompt,
  buildContinuationPrompt,
  type Observation,
} from '../../sdk/prompts.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { resolveSummaryTierModel } from './model-aliases.js';
import { isClassified } from './provider-errors.js';
import {
  shouldRecycleConversation,
  conversationChars,
  resolveConversationMaxChars,
} from '../../shared/observer-recycle.js';
import { recycleObserverConversation, loadSessionStartContext } from './session/recycle-conversation.js';
import { optimizeObservationFields, buildFieldCompressionPrompt, type FieldCompressor } from './field-optimizer.js';
import { buildTelegramWrapupPrompt, type TelegramWrapupFormatterInput } from '../integrations/TelegramWrapupNotifier.js';
import { handleSessionError as applyProviderErrorPolicy } from './session/provider-error-policy.js';

import {
  processAgentResponse,
  snapshotResponseContext,
  type WorkerRef
} from './agents/index.js';

/** Re-exported for providers that override observationBatchPolicy. */
export type { ObservationBatchPolicy } from './SessionManager.js';

/**
 * Normalized result returned by a concrete provider's `query()`.
 * Optional fields (costUsd, servedModel) are populated only by providers that
 * surface them; absent fields are simply not forwarded.
 */
export interface ProviderQueryResult {
  content: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Real provider-reported spend in USD (only some gateways report it). */
  costUsd?: number;
  /** The model that actually served the request, when reported. */
  servedModel?: string;
}

/**
 * The minimum a provider config must carry for the shared lifecycle to run.
 *
 * `apiKey` is optional because a provider need not have one: a CLI-backed
 * provider authenticates through the binary's own session. Key-based providers
 * keep declaring it as required in their own config type, and the default
 * `isConfigured` still reads it.
 */
export interface ProviderConfigBase {
  model: string;
  apiKey?: string;
  plainText?: boolean;
}

/**
 * Which call site a `query()` came from, and the session behind it.
 *
 * Only handed to providers that opt in via `wantsQueryContext`; a provider that
 * does not need it is never called with a fourth argument.
 */
export interface ProviderQueryContext {
  purpose: 'init' | 'observation' | 'summary' | 'field-compression' | 'telegram-wrapup';
  /** Absent for the Telegram wrap-up, which formats a stored summary with no live session. */
  session?: ActiveSession;
  /**
   * The session this call belongs to when there is no live `session` object —
   * only the Telegram wrap-up, which is formatted from a stored summary. A
   * provider that spawns a subprocess still has to attribute it to a session
   * (jail directory, process registry, logs), and the wrap-up's own input
   * carries the id — and the field-compression call, which carries it beside
   * `session` so the id is readable without unwrapping the session. The three
   * lifecycle calls read it off `session`.
   */
  sessionDbId?: number;
}

/**
 * Shared scaffolding for OpenAI-compatible, multi-turn HTTP providers
 * (Gemini, OpenRouter). The session lifecycle — synthetic memory-session-id
 * generation, init/continuation prompt, the observation/summary message loop,
 * cumulative token accounting, abort-aware error handling, and history
 * truncation — is identical between them. Per-provider differences (config
 * resolution, request shape, token estimation, usage/cost reporting) are
 * supplied by abstract members.
 *
 * A second family of members — the opt-in hooks below (`isConfigured`,
 * `wantsQueryContext`, `fieldCompressor`, `resolveSummaryModel`,
 * `adoptForeignMemorySessionId`, `conversationMaxChars`, and the M4 cost hooks
 * `deferInitQuery`, `freshGenerationOnStart`, `observationBatchPolicy`,
 * `buildObservationTurn`) — exists for providers that are not
 * HTTP-and-a-key, such as a local CLI where every call is one metered plan
 * message. Every one of them defaults to what this class did before the hook
 * existed, so a provider that overrides nothing behaves identically to how it
 * behaved without them: same queries, same prompt bytes, same claim/confirm
 * sequence (pinned by tests/worker/provider-prompt-snapshots.test.ts).
 */
export abstract class OpenAICompatibleProvider<TConfig extends ProviderConfigBase> {
  protected dbManager: DatabaseManager;
  protected sessionManager: SessionManager;

  /** Human-readable provider name passed to logging + processAgentResponse. */
  protected abstract readonly providerName: string;
  /** Prefix for the synthetic memorySessionId (e.g. 'gemini', 'openrouter'). */
  protected abstract readonly syntheticIdPrefix: string;
  /**
   * When a query returns empty content for an observation/summary message:
   * OpenRouter still calls processAgentResponse('') (forwards the empty batch
   * to the parser/recovery path); Gemini skips it and logs a warning. This flag
   * preserves that per-provider divergence.
   */
  protected abstract readonly forwardEmptyMessageResponse: boolean;
  /**
   * Whether `query()` is invoked with the fourth `ctx` argument.
   *
   * Deliberately not "always pass it and let providers ignore it": Gemini's and
   * OpenRouter's call shape is asserted argument-for-argument by their tests,
   * and a silent extra argument is exactly the kind of drift those assertions
   * exist to catch. With this false — the default — a query is issued with the
   * same two (or, from the field compressor, three) arguments as before.
   */
  protected readonly wantsQueryContext: boolean = false;
  /**
   * Whether a persisted memory_session_id written by a DIFFERENT provider may
   * be adopted instead of replaced.
   *
   * False — the default and the long-standing behaviour — means only this
   * provider's own `${syntheticIdPrefix}-${contentSessionId}-` ids are reused,
   * and anything else is superseded by a freshly generated one.
   */
  protected readonly adoptForeignMemorySessionId: boolean = false;
  /**
   * Skip the standalone init query (M4, plan hook 8).
   *
   * False — the default — sends the init/continuation prompt on its own and
   * records the reply as an assistant turn, exactly as before. True sends
   * nothing at start: the init turn stays at the head of the history and
   * becomes the stable first turn of the first real call. Nothing is lost —
   * the init reply is never stored (see handleInitResponse) — and for a
   * provider where every call is a paid plan message it saves one per
   * generator start. A generator that ends before any work arrives then costs
   * nothing at all.
   */
  protected readonly deferInitQuery: boolean = false;
  /**
   * Start every generator from an empty conversation (M4, plan hook 9).
   *
   * False — the default — keeps whatever conversation the session still holds
   * (a generator restarted after a quota/auth/transport pause keeps its old
   * turns) and appends the new init turn to it, as before. True drops it first:
   * continuity comes from the session-start context the init turn is seeded
   * with (loadSessionStartContext), not from re-sending old turns — which a
   * provider that pays for every input token on every call cannot afford.
   */
  protected readonly freshGenerationOnStart: boolean = false;

  /**
   * Called once per generator start whose init query `deferInitQuery` skipped
   * (the call it saved). Default: nothing. Only reachable with
   * `deferInitQuery` true, so a provider that does not defer never gets here.
   */
  protected onInitQueryDeferred(_session: ActiveSession): void {}

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /** Resolve API key, model, and any per-provider request parameters. */
  protected abstract getConfig(): TConfig;

  /** Throw a provider-specific "API key not configured" error. */
  protected abstract missingApiKeyError(): Error;

  /**
   * Whether the resolved config is usable. Default: a non-empty API key — the
   * identical check the two `!config.apiKey` sites performed. A provider whose
   * readiness is something else (a resolved binary, a passed self-check)
   * overrides this; `missingApiKeyError()` is still what a false answer throws.
   */
  protected isConfigured(config: TConfig): boolean {
    return Boolean(config.apiKey);
  }

  /**
   * Issue the actual HTTP request and normalize its response. `ctx` is only
   * supplied when `wantsQueryContext` is true.
   */
  protected abstract query(
    history: ConversationMessage[],
    config: TConfig,
    signal?: AbortSignal,
    ctx?: ProviderQueryContext,
  ): Promise<ProviderQueryResult>;

  /**
   * The single place a query leaves this class, so the opt-in context cannot
   * change any existing provider's call shape by accident.
   */
  private invokeQuery(
    history: ConversationMessage[],
    config: TConfig,
    signal: AbortSignal | undefined,
    ctx: ProviderQueryContext,
  ): Promise<ProviderQueryResult> {
    if (this.wantsQueryContext) {
      return this.query(history, config, signal, ctx);
    }
    return signal === undefined
      ? this.query(history, config)
      : this.query(history, config, signal);
  }

  /**
   * One bounded, standalone call that condenses an oversized tool payload.
   *
   * Issued off to the side with its own single-message history: adding it to
   * `session.conversationHistory` would grow the very conversation the recycle
   * logic exists to bound.
   *
   * The trailing `session` is the observation's own session. It is optional so
   * the first four parameters — name, order and types — are exactly what they
   * were, but the lifecycle always passes it: a provider that spawns a
   * subprocess per call has to attribute that subprocess to a real session
   * (jail directory, process registry, security audit, per-session violation
   * counters), and a compression turn with no session attributed itself to
   * sessionDbId 0, i.e. to a shared directory and a process-wide counter that
   * belongs to no session at all.
   */
  private async compressField(
    text: string,
    budgetChars: number,
    config: TConfig,
    signal: AbortSignal,
    session?: ActiveSession,
  ): Promise<string | null> {
    const result = await this.invokeQuery(
      [{ role: 'user', content: buildFieldCompressionPrompt(text, budgetChars) }],
      config,
      signal,
      {
        purpose: 'field-compression',
        ...(session ? { session, sessionDbId: session.sessionDbId } : {}),
      },
    );
    return result.content || null;
  }

  /**
   * The field compressor handed to `optimizeObservationFields`, or null to skip
   * that pass entirely.
   *
   * Default: the bounded `compressField` call above, i.e. exactly what was
   * passed inline before. Null exists for a provider where a second model call
   * per oversized field is not a rounding error — a metered CLI turn, say —
   * and the observation is better off going through the existing truncation.
   *
   * `session` is the session whose observation is being compressed; the default
   * only forwards it into the query context, so a provider that ignores the
   * context is unaffected by it.
   */
  protected fieldCompressor(config: TConfig, session?: ActiveSession): FieldCompressor | null {
    return (text, budgetChars, signal) => this.compressField(text, budgetChars, config, signal, session);
  }

  /** Format a stored summary through this provider's normal summary-model query path. */
  async formatTelegramWrapup(
    input: TelegramWrapupFormatterInput,
    activeModelId?: string,
  ): Promise<string> {
    const config = this.getConfig();
    if (!this.isConfigured(config)) {
      throw this.missingApiKeyError();
    }
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // Same resolution input as before — `activeModelId ?? config.model` — but
    // handed over as a config, so a provider that overrides resolveSummaryModel
    // sees everything it resolved rather than a bare model string.
    const activeModel = activeModelId ?? config.model;
    const model = this.resolveSummaryModel(
      activeModel === config.model ? config : { ...config, model: activeModel },
      settings,
    );
    const summaryConfig = { ...config, model, plainText: true };
    const result = await this.invokeQuery(
      [{ role: 'user', content: buildTelegramWrapupPrompt(input.summaryText) }],
      summaryConfig,
      undefined,
      { purpose: 'telegram-wrapup', sessionDbId: input.sessionDbId },
    );
    if (!result.content?.trim()) {
      const error = new Error(`${this.providerName} returned no text for the Telegram wrap-up`);
      logger.error('TELEGRAM', error.message, { sessionId: input.sessionDbId, model }, error);
      throw error;
    }
    return result.content;
  }

  /** Estimate token count for a single message body. */
  protected abstract estimateTokens(text: string): number;

  /** Build the session.lastUsage value from a query result. */
  protected abstract buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'];

  /** Hook for per-session setup that runs once config is resolved (e.g. endpointClass). */
  protected prepareSessionExtras(_session: ActiveSession, _config: TConfig): void {}

  /**
   * The model a summary (and the Telegram wrap-up) is sent to.
   *
   * Default: the shared tier routing, resolved from the config's own model —
   * identical to the two `resolveSummaryTierModel(...)` calls this replaced. A
   * provider whose model ids are not the tier namespace overrides it so a
   * `$TIER:` alias meant for another backend can never leak into its request.
   */
  protected resolveSummaryModel(config: TConfig, settings: SettingsDefaults): string {
    return resolveSummaryTierModel(config.model, settings);
  }

  /**
   * Character budget for one observer generation, operator-overridable (#3800).
   *
   * The session is passed so a provider can scope the budget to it; the default
   * ignores it and reads the one operator setting, exactly as before.
   */
  protected conversationMaxChars(_session?: ActiveSession): number {
    return resolveConversationMaxChars(
      SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS
    );
  }

  /**
   * How to batch consecutive observations into one turn (M4, plan hook 10), or
   * null for one turn per observation.
   *
   * Default: null, i.e. exactly the old loop — the drain yields a message, it
   * is answered, confirmed, and the next one is yielded. With a policy, each
   * observation the drain yields is grown into a batch through
   * SessionManager.claimObservationBatch (same prompt, agent and cwd; FIFO;
   * count and character budgets; a short linger when the queue is idle), the
   * batch is sent as ONE turn built by buildObservationTurn, and the whole
   * claimed set is confirmed — or reset to pending — together.
   */
  protected observationBatchPolicy(_config: TConfig): ObservationBatchPolicy | null {
    return null;
  }

  /**
   * The user turn for the observations being sent now (one, or a batch).
   *
   * Default: a lone observation is buildObservationPrompt — byte-identical to
   * what this class always sent — and a batch (only possible with an
   * observationBatchPolicy) is buildObservationBatchPrompt, so a provider that
   * turns batching on without overriding this still sends every observation it
   * claimed.
   */
  protected buildObservationTurn(observations: readonly Observation[]): string {
    return observations.length === 1
      ? buildObservationPrompt(observations[0])
      : buildObservationBatchPrompt(observations);
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getConfig();
    const { model } = config;
    session.lastModelId = model;
    this.prepareSessionExtras(session, config);

    if (!this.isConfigured(config)) {
      const notReady = this.missingApiKeyError();
      // This gate throws BEFORE either try/catch below, so the shared error
      // policy never sees it and `session.lastProviderError` would keep
      // describing some earlier run. Stash it here so the field always
      // describes the failure that ended THIS run. No-op for a provider whose
      // readiness error is a plain Error (Gemini, OpenRouter).
      if (isClassified(notReady)) {
        session.lastProviderError = notReady;
      }
      throw notReady;
    }

    if (!session.memorySessionId) {
      const persistedMemorySessionId = this.dbManager.getSessionById(session.sessionDbId).memory_session_id;
      const syntheticIdPrefix = `${this.syntheticIdPrefix}-${session.contentSessionId}-`;

      // Foreign-id adoption is opt-in: by default only this provider's own
      // synthetic ids are reusable, and anything else is superseded — which is
      // what every provider did before this hook existed.
      const reusableMemorySessionId =
        persistedMemorySessionId
        && (persistedMemorySessionId.startsWith(syntheticIdPrefix) || this.adoptForeignMemorySessionId)
          ? persistedMemorySessionId
          : null;

      if (reusableMemorySessionId) {
        session.memorySessionId = reusableMemorySessionId;
        logger.info('SESSION', `MEMORY_ID_REUSED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      } else {
        const syntheticMemorySessionId = `${syntheticIdPrefix}${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        // The same flag that adopts a foreign id also declines to PUBLISH a
        // generated one at session start: updateMemorySessionId UPDATEs
        // sdk_sessions and requeues a prompt sync, which is wasted work for a
        // session that may never store anything (setup gate, guard kill,
        // content policy). The id is kept in memory and written by
        // ensureMemorySessionIdRegistered on the first store instead. Providers
        // that do not opt in keep writing it here, exactly as before.
        if (!this.adoptForeignMemorySessionId) {
          this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        }
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      }
    }

    const mode = ModeManager.getInstance().getActiveMode();
    // Seed the generation with what this session already observed, so a
    // conversation that starts partway through (a recycle, or a resume after a
    // quota pause) continues from the memory rather than from nothing (#3800).
    const priorContext = await loadSessionStartContext(session);
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode, priorContext)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode, priorContext);

    if (this.freshGenerationOnStart) {
      // A new generation: the turns a paused run left behind are not re-sent.
      // What they established is already in priorContext, above.
      session.conversationHistory = [];
    }
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    if (this.deferInitQuery) {
      // No standalone init call: the init turn rides along as the first turn
      // of the first real call. Its reply would never have been stored anyway.
      logger.debug('SDK', `${this.providerName} init query deferred to the first observation or summary`, {
        sessionId: session.sessionDbId, model
      });
      this.onInitQueryDeferred(session);
    } else {
      try {
        session.lastPromptSentAt = Date.now();
        session.lastGeneratorSource = 'init';
        const initResponse = await this.invokeQuery(
          session.conversationHistory, config, undefined, { purpose: 'init', session },
        );
        this.handleInitResponse(initResponse, session, model);
      } catch (error: unknown) {
        // Classified errors are logged once, at SessionRoutes' `Observer failed`
        // line; here they're debug-level so one failure isn't five error lines.
        if (isClassified(error)) {
          logger.debug('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
        } else if (error instanceof Error) {
          logger.error('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model }, error);
        } else {
          logger.error('SDK', `${this.providerName} init query failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
        }
        return this.handleSessionError(error, session, worker);
      }
    }

    try {
      await this.runMessageLoop(session, worker, config, mode);
    } catch (error: unknown) {
      if (isClassified(error)) {
        logger.debug('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
      } else if (error instanceof Error) {
        logger.error('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${this.providerName} message loop failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleSessionError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', `${this.providerName} agent completed`, {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async runMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        await this.processObservationMessage(session, message, worker, config, originalTimestamp, lastCwd);
      } else if (message.type === 'summarize') {
        await this.processSummaryMessage(session, message, worker, config, mode, originalTimestamp, lastCwd);
      }
    }
  }

  private handleInitResponse(
    initResponse: ProviderQueryResult,
    session: ActiveSession,
    model: string
  ): void {
    if (!initResponse.content && !this.forwardEmptyMessageResponse) {
      logger.error('SDK', `Empty ${this.providerName} init response - session may lack context`, {
        sessionId: session.sessionDbId, model
      });
      return;
    }

    const tokensUsed = initResponse.tokensUsed || 0;
    session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
    session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    // The init prompt carries the user's request and no tool call, so nothing in
    // its reply can be an observation of this session — an <observation> here was
    // invented from <user_request> alone and would be stored as memory for work
    // that never happened. Keep the turn so role alternation holds, but never
    // hand it to the storage path.
    session.conversationHistory.push({ role: 'assistant', content: initResponse.content || '' });
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: PendingMessageWithId,
    worker: WorkerRef | undefined,
    config: TConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }
    // Where the reply is filed (project, prompt number, agent), taken NOW —
    // from this message, which runMessageLoop just applied to the session —
    // and before any await. The batch linger and the field compression below
    // both yield, and a new user prompt arriving meanwhile re-initializes the
    // live session (SessionManager.initializeSession overwrites
    // lastPromptNumber and project); a snapshot taken after that would file
    // this prompt's observations under the next one. Every observation in a
    // batch shares this message's prompt, agent and cwd (sameObservationGroup),
    // so one context is right for all of them.
    const responseContext = snapshotResponseContext(session);

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    // Retire a full generation BEFORE sending, so the request that would cross
    // the ceiling is never paid for. The batch is preserved and drained by the
    // fresh generation the next ingest starts (#3800).
    if (shouldRecycleConversation(session.conversationHistory, this.conversationMaxChars(session))) {
      await recycleObserverConversation(
        session,
        this.sessionManager,
        worker,
        'budget',
        `conversation reached ${conversationChars(session.conversationHistory)} chars`,
      );
      return;
    }

    // Opt-in batching (M4): grow this observation into a batch of consecutive
    // ones from the same prompt/agent/cwd. Every id claimed here joins
    // session.claimedMessageIds, so the store below confirms the whole batch
    // and any failure resets the whole batch to pending. Without a policy the
    // batch is just this message, exactly as before.
    const batchPolicy = this.observationBatchPolicy(config);
    const batch = batchPolicy
      ? await this.sessionManager.claimObservationBatch(session.sessionDbId, message, batchPolicy)
      : [message];
    if (batchPolicy && session.abortController.signal.aborted) {
      // Aborted while lingering for the rest of a burst (shutdown, a pause
      // raised elsewhere): do not start a call for a generator that is ending.
      // The claimed batch stays unconfirmed and the next generator re-yields it.
      return;
    }

    // An oversized payload is condensed by a bounded model pass before the
    // prompt is built, so the observation carries a summary of the whole field
    // rather than a head/tail slice with the middle cut out (#3800).
    const compressor = this.fieldCompressor(config, session);
    const observations: Observation[] = [];
    for (const item of batch) {
      if (batchPolicy && compressor && session.abortController.signal.aborted) {
        // Aborted between two batch members' compression passes (shutdown, a
        // pause raised elsewhere): each pass can be a paid call of its own, so
        // stop here instead of compressing the rest of a batch that will not
        // be sent. As above, the claimed batch is re-yielded by the next
        // generator. Batching only: the single-observation path is unchanged.
        return;
      }
      const optimized = compressor
        ? await optimizeObservationFields(
            { toolInput: item.tool_input, toolOutput: item.tool_response },
            compressor,
            { sessionDbId: session.sessionDbId, toolName: item.tool_name },
          )
        : { toolInput: item.tool_input, toolOutput: item.tool_response };

      observations.push({
        id: 0,
        tool_name: item.tool_name!,
        tool_input: JSON.stringify(optimized.toolInput),
        tool_output: JSON.stringify(optimized.toolOutput),
        // A batched turn dates each tool use by its OWN enqueue time; the
        // single-observation path keeps the session's earliest pending time,
        // as it always has.
        created_at_epoch: batchPolicy && typeof item._originalTimestamp === 'number'
          ? item._originalTimestamp
          : originalTimestamp ?? Date.now(),
        cwd: item.cwd
      });
    }

    const obsPrompt = this.buildObservationTurn(observations);
    // The stored rows are stamped with the earliest claimed enqueue time. The
    // batch claim may have moved it; without a policy it is what the caller
    // passed in.
    const storeTimestamp = batchPolicy ? session.earliestPendingTimestamp ?? originalTimestamp : originalTimestamp;

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const obsResponse = await this.invokeQuery(
      session.conversationHistory, config, undefined, { purpose: 'observation', session },
    );

    let tokensUsed = 0;
    if (obsResponse.content) {
      // The assistant turn is appended once, by processAgentResponse below.
      // Appending it here too stored every reply twice (#3619), inflating the
      // window — and therefore every subsequent request — by ~50%.
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      // Both sides or nothing: a backend reporting only one of the two counts
      // must not produce a half-real event (input=0 → compression_ratio 0.0).
      session.lastUsage = this.buildLastUsage(obsResponse);
    }

    if (obsResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        obsResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, storeTimestamp, this.providerName, lastCwd, obsResponse.servedModel ?? config.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} observation response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);
    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'summarize';
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const summaryModel = this.resolveSummaryModel(config, settings);
    const summaryConfig = summaryModel === config.model ? config : { ...config, model: summaryModel };
    if (summaryConfig !== config) {
      logger.debug('SESSION', 'Tier routing: summary model', {
        sessionId: session.sessionDbId, model: summaryModel
      });
    }
    const summaryResponse = await this.invokeQuery(
      session.conversationHistory, summaryConfig, undefined, { purpose: 'summary', session },
    );

    let tokensUsed = 0;
    if (summaryResponse.content) {
      // Appended once, by processAgentResponse below — see processObservationMessage.
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(summaryResponse);
    }

    if (summaryResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        summaryResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, summaryResponse.servedModel ?? summaryConfig.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} summary response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  /**
   * The shared error policy, now in session/provider-error-policy.ts so a
   * provider outside this hierarchy applies the identical rules. Kept as a
   * protected method because subclasses call it from their own catch sites.
   */
  protected handleSessionError(error: unknown, session: ActiveSession, worker?: WorkerRef): never {
    return applyProviderErrorPolicy(error, session, this.providerName, worker);
  }

}
