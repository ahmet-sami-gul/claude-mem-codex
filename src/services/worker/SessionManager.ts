import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import { SessionMessageBuffer } from './SessionMessageBuffer.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../supervisor/process-registry.js';
import { getSupervisor } from '../../supervisor/index.js';
import { telemetryBuffer } from '../telemetry/buffer.js';
import { deliverSessionWrapup, type TelegramWrapupFormatter } from '../integrations/TelegramWrapupNotifier.js';
import { renderObservationEnvelope } from '../../sdk/prompts.js';
import { codexMetrics, type CodexMetrics } from './codex/codex-metrics.js';

export const SESSION_END_WRAPUP_GRACE_MS = 5_000;

/** After the first drop, a session's queue-cap warning repeats once per this many drops. */
export const QUEUE_CAP_WARN_EVERY = 100;

/**
 * How a provider that opts into observation batching (M4) wants its turns
 * sized. See OpenAICompatibleProvider.observationBatchPolicy.
 */
export interface ObservationBatchPolicy {
  /** Most observations one turn may carry, the first one included. 1 disables batching. */
  maxMessages: number;
  /**
   * Character budget for the batch, measured as the rendered observation
   * envelopes (observationBatchChars). The first observation always goes,
   * whatever its size; later ones join only while the total stays within it.
   */
  maxChars: number;
  /**
   * How long to wait for more work when nothing else is queued, so a burst of
   * tool calls a moment apart shares one turn. 0 never waits. Never applied
   * when work is already queued: a backlog is claimed at once.
   */
  lingerMs: number;
}

/**
 * The size an observation adds to a batched turn: its rendered
 * `<observed_from_primary_session>` envelope, i.e. after the prompt's own
 * image stripping and per-field truncation — the characters the provider will
 * actually be sent, not the raw payload. The timestamp is a fixed-width ISO
 * string, so any value measures the same.
 */
export function observationBatchChars(message: PendingMessage): number {
  return renderObservationEnvelope({
    id: 0,
    tool_name: message.tool_name ?? '',
    tool_input: JSON.stringify(message.tool_input),
    tool_output: JSON.stringify(message.tool_response),
    created_at_epoch: 0,
    cwd: message.cwd,
  }).length;
}

/** Empty and absent mean the same thing for every grouping field. */
function groupKey(value: string | undefined | null): string | null {
  return value ? value : null;
}

/**
 * Whether `candidate` may share a turn with `first`: another observation from
 * the same prompt, the same (sub)agent and the same working directory. The
 * turn's reply is stored under ONE response context (prompt number, agent id
 * and type — ResponseProcessor.snapshotResponseContext) and one project root,
 * so mixing any of these would file some observations under the wrong one.
 */
function sameObservationGroup(first: PendingMessage, candidate: PendingMessage): boolean {
  return candidate.type === 'observation'
    && candidate.prompt_number === first.prompt_number
    && groupKey(candidate.agentId) === groupKey(first.agentId)
    && groupKey(candidate.agentType) === groupKey(first.agentType)
    && groupKey(candidate.cwd) === groupKey(first.cwd);
}

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private onPendingMutate?: () => void;
  private telegramWrapupFormatter: TelegramWrapupFormatter | null = null;
  private readonly buffer = new SessionMessageBuffer(() => this.onPendingMutate?.());
  /** The observation queue cap in force right now; 0 = no cap. See setObservationQueueCap. */
  private observationQueueCap: () => number = () => 0;
  private queueCapMetrics: CodexMetrics = codexMetrics;
  /** Observations each live session has lost to the queue cap, for the throttled warning. */
  private readonly queueCapDrops = new Map<number, number>();

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  setOnPendingMutate(cb: () => void): void {
    this.onPendingMutate = cb;
  }

  /**
   * Bound each session's queue of waiting observations
   * (CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS). The buffer is RAM-only by
   * design and would otherwise grow without limit while the observer is
   * paused; left to drain, such a pile-up spends hundreds of plan messages at
   * once. `cap` answers the cap in force right now — 0 while codex is not the
   * provider or the cap is off — and is asked after every enqueued
   * observation, so it must be cheap (the worker passes a briefly cached
   * settings read). Drops are counted in `metrics`. Until this is called there
   * is no cap.
   */
  setObservationQueueCap(cap: () => number, metrics: CodexMetrics = codexMetrics): void {
    this.observationQueueCap = cap;
    this.queueCapMetrics = metrics;
  }

  setTelegramWrapupFormatter(formatter: TelegramWrapupFormatter): void {
    this.telegramWrapupFormatter = formatter;
  }

  initializeSession(
    sessionDbId: number,
    currentUserPrompt?: string,
    promptNumber?: number,
    currentProject?: string,
  ): ActiveSession {
    const suppliedProject = currentProject && currentProject !== 'unknown' ? currentProject : undefined;

    logger.debug('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt
    });

    let session = this.sessions.get(sessionDbId);
    if (session) {
      logger.debug('SESSION', 'Returning cached session', {
        sessionDbId,
        contentSessionId: session.contentSessionId,
        lastPromptNumber: session.lastPromptNumber
      });

      const dbSession = this.dbManager.getSessionById(sessionDbId);
      if (dbSession.project && dbSession.project !== session.project && !suppliedProject) {
        logger.debug('SESSION', 'Updating project from database', {
          sessionDbId,
          oldProject: session.project,
          newProject: dbSession.project
        });
        session.project = dbSession.project;
      }
      if (suppliedProject) {
        session.project = suppliedProject;
      }
      if (dbSession.platform_source && dbSession.platform_source !== session.platformSource) {
        session.platformSource = dbSession.platform_source;
      }
      if (dbSession.observed_model && dbSession.observed_model !== session.observedModel) {
        session.observedModel = dbSession.observed_model;
      }
      if (dbSession.observed_billing && dbSession.observed_billing !== session.observedBilling) {
        session.observedBilling = dbSession.observed_billing;
      }

      if (currentUserPrompt) {
        logger.debug('SESSION', 'Updating userPrompt for continuation', {
          sessionDbId,
          promptNumber,
          oldPrompt: session.userPrompt?.substring(0, 80) ?? '',
          newPrompt: currentUserPrompt.substring(0, 80)
        });
        session.userPrompt = currentUserPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
      } else {
        logger.debug('SESSION', 'No currentUserPrompt provided for existing session', {
          sessionDbId,
          promptNumber,
          usingCachedPrompt: session.userPrompt?.substring(0, 80) ?? ''
        });
      }
      return session;
    }

    const dbSession = this.dbManager.getSessionById(sessionDbId);

    logger.debug('SESSION', 'Fetched session from database', {
      sessionDbId,
      content_session_id: dbSession.content_session_id,
      memory_session_id: dbSession.memory_session_id
    });

    if (dbSession.memory_session_id) {
      logger.warn('SESSION', `Discarding stale memory_session_id from previous worker instance (Issue #817)`, {
        sessionDbId,
        staleMemorySessionId: dbSession.memory_session_id,
        reason: 'SDK context lost on worker restart - will capture new ID'
      });
    }

    const latestPromptText = currentUserPrompt
      ? null
      : this.dbManager.getSessionStore().getLatestPromptTextFromUserPrompts(
          dbSession.content_session_id,
          sessionDbId,
        );
    const userPrompt = currentUserPrompt || latestPromptText || dbSession.user_prompt;

    if (!currentUserPrompt) {
      logger.debug('SESSION', latestPromptText
        ? 'No currentUserPrompt provided for new session, using latest user_prompts'
        : 'No currentUserPrompt provided for new session, using database', {
        sessionDbId,
        promptNumber,
        latestPrompt: latestPromptText?.substring(0, 80) ?? '',
        dbPrompt: dbSession.user_prompt?.substring(0, 80) ?? ''
      });
    } else {
      logger.debug('SESSION', 'Initializing session with fresh userPrompt', {
        sessionDbId,
        promptNumber,
        userPrompt: currentUserPrompt.substring(0, 80)
      });
    }

    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: null,  // Always start fresh - SDK will capture new ID
      project: suppliedProject || dbSession.project,
      platformSource: dbSession.platform_source,
      observedModel: dbSession.observed_model ?? undefined,
      observedBilling: dbSession.observed_billing ?? undefined,
      userPrompt,
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id, sessionDbId),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      claimedMessageIds: [],
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null,  // Will be set when generator starts
      consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      lastGeneratorActivity: Date.now(),  // Initialize for stale detection (Issue #1099)
      pendingAgentId: null,   // Subagent identity carried from the most recent claimed message
      pendingAgentType: null
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id, sessionDbId)
    });

    this.sessions.set(sessionDbId, session);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
      queueDepth: 0,
      hasGenerator: false
    });

    return session;
  }

  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  private deliverSessionWrapupInBackground(sessionDbId: number): void {
    const formatSummary = this.telegramWrapupFormatter;
    if (!formatSummary) {
      logger.warn('TELEGRAM', 'Telegram session wrap-up formatter is unavailable', {
        sessionId: sessionDbId,
      });
      return;
    }

    void deliverSessionWrapup({
      sessionStore: this.dbManager.getSessionStore(),
      sessionDbId,
      formatSummary,
    }).catch((error: unknown) => {
      logger.warn('TELEGRAM', 'Failed to deliver Telegram session wrap-up from SessionManager', {
        sessionId: sessionDbId,
      }, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private takeRequestedSessionWrapup(session: ActiveSession): boolean {
    if (session.telegramWrapupTimer != null) {
      clearTimeout(session.telegramWrapupTimer);
      session.telegramWrapupTimer = null;
    }

    return session.telegramWrapupRequestedAt != null;
  }

  /** SessionEnd is the sole producer of this marker; Stop only queues a summary. */
  async requestSessionWrapup(sessionDbId: number): Promise<void> {
    const session = this.getSession(sessionDbId);
    if (!session) {
      this.deliverSessionWrapupInBackground(sessionDbId);
      return;
    }

    session.telegramWrapupRequestedAt = Date.now();
    if (session.telegramWrapupTimer != null) {
      clearTimeout(session.telegramWrapupTimer);
    }
    session.telegramWrapupTimer = setTimeout(() => {
      session.telegramWrapupTimer = null;
      this.deliverSessionWrapupInBackground(sessionDbId);
    }, SESSION_END_WRAPUP_GRACE_MS);
    session.telegramWrapupTimer.unref?.();
  }

  /** Called after a summary write; the SessionEnd marker preserves Stop-only silence. */
  deliverRequestedSessionWrapup(sessionDbId: number): void {
    const session = this.getSession(sessionDbId);
    if (session?.telegramWrapupRequestedAt == null) {
      return;
    }
    this.deliverSessionWrapupInBackground(sessionDbId);
  }

  async queueObservation(sessionDbId: number, data: ObservationData): Promise<void> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd,
      agentId: data.agentId,
      agentType: data.agentType,
      toolUseId: data.toolUseId,
    };

    const messageId = this.buffer.enqueue(sessionDbId, message);
    const queueDepth = this.buffer.getPendingCount(sessionDbId);
    const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
    if (messageId === 0) {
      logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=observation | tool=${toolSummary} | toolUseId=${data.toolUseId ?? 'null'} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } else {
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
      this.enforceObservationQueueCap(sessionDbId);
    }
  }

  /**
   * Drop the oldest unclaimed observations of a session past the queue cap
   * (see setObservationQueueCap). Claimed (in-flight) work and summarize
   * requests are never dropped. Warns the first time a session drops and then
   * at most once per QUEUE_CAP_WARN_EVERY drops.
   */
  private enforceObservationQueueCap(sessionDbId: number): void {
    const cap = this.observationQueueCap();
    if (!(cap > 0)) return;
    const dropped = this.buffer.dropOldestUnclaimedObservations(sessionDbId, cap);
    if (dropped === 0) return;

    this.queueCapMetrics.recordQueuedObservationsDropped(dropped);
    const before = this.queueCapDrops.get(sessionDbId) ?? 0;
    const total = before + dropped;
    this.queueCapDrops.set(sessionDbId, total);
    if (before === 0 || Math.floor(total / QUEUE_CAP_WARN_EVERY) > Math.floor(before / QUEUE_CAP_WARN_EVERY)) {
      logger.warn('QUEUE', `CAP_DROPPED | sessionDbId=${sessionDbId} | droppedTotal=${total} | cap=${cap} | oldest waiting observations dropped (CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS)`, {
        sessionId: sessionDbId,
        droppedTotal: total,
        cap,
      });
    }
  }

  async queueSummarize(sessionDbId: number, lastAssistantMessage?: string): Promise<void> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'summarize',
      last_assistant_message: lastAssistantMessage
    };

    const messageId = this.buffer.enqueue(sessionDbId, message);
    const queueDepth = this.buffer.getPendingCount(sessionDbId);
    if (messageId === 0) {
      logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } else {
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    }
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    return this.buffer.clear(sessionDbId);
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    if (session) {
      session.claimedMessageIds = [];
    }
    return this.buffer.resetClaimed(sessionDbId);
  }

  async confirmClaimedMessages(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    const claimedIds = session?.claimedMessageIds ?? [];
    let confirmed = 0;
    for (const messageId of claimedIds) {
      confirmed += this.buffer.confirm(messageId);
    }
    if (session) {
      session.claimedMessageIds = [];
      session.earliestPendingTimestamp = null;
    }
    return confirmed;
  }

  /**
   * Grow the observation the drain just yielded (`first`, already claimed by
   * getMessageIterator) into a batch for one provider turn (M4, opt-in —
   * only providers with an observationBatchPolicy call this; the Claude path
   * and the default OpenAI-compatible path never do).
   *
   * - Lingers only when nothing else was queued when the call began and the
   *   session is not aborted: a backlog is claimed at once and the batch
   *   returns as soon as it runs dry, while an idle queue gets up to
   *   `lingerMs` (in total, not per message) for the rest of a burst to
   *   arrive.
   * - Claims with buffer.claimMatching: oldest first, taking only
   *   observations of the same prompt, agent and cwd as `first`. Observations
   *   of other groups (the interleaved events of parallel subagents) are
   *   skipped and stay queued, in their order, for later turns. Anything that
   *   is not an observation — a summarize request — is a barrier: nothing at
   *   or past it is claimed. The first same-group observation that would take
   *   the batch past `maxChars` closes the group, so no later one is claimed
   *   ahead of it. A batch therefore never reaches past a barrier and is never
   *   out of order within its group.
   * - Records every claimed id in `session.claimedMessageIds`, exactly like
   *   the drain does for `first`, so confirmClaimedMessages and
   *   resetProcessingToPending act on the whole batch together, and keeps
   *   `earliestPendingTimestamp` / `lastGeneratorActivity` current.
   *
   * Returns the batch in queue order, `first` included.
   */
  async claimObservationBatch(
    sessionDbId: number,
    first: PendingMessageWithId,
    policy: ObservationBatchPolicy,
  ): Promise<PendingMessageWithId[]> {
    const batch: PendingMessageWithId[] = [first];
    const session = this.sessions.get(sessionDbId);
    const maxMessages = Math.floor(policy.maxMessages);
    if (!session || first.type !== 'observation' || !(maxMessages > 1)) {
      return batch;
    }

    const signal = session.abortController.signal;
    let chars = observationBatchChars(first);
    if (!(chars < policy.maxChars)) {
      return batch;
    }
    // Decided ONCE, before anything else is claimed: a call that finds work
    // already queued is draining a backlog and returns as soon as that runs
    // dry; only a call that found the queue idle waits for the rest of a burst.
    // Re-deciding per pass would claim a short backlog and then sit out the
    // whole linger on the now-empty queue, delaying every backlog batch.
    const mayLinger = this.buffer.getUnclaimedCount(sessionDbId) === 0;
    const lingerUntil = Date.now() + Math.max(0, policy.lingerMs);
    const inBatch = new Set<number>([first._persistentId]);
    // Set once a same-group observation does not fit the budget: taking a
    // later, smaller one of the group would answer it out of order.
    let groupClosed = false;
    const isBarrier = (candidate: PendingMessageWithId): boolean => candidate.type !== 'observation';
    const accept = (candidate: PendingMessageWithId): boolean => {
      if (groupClosed) return false;
      // A message already in this batch can only be offered again if its
      // claim was reset underneath us; sending it twice would store it twice.
      // It is waiting again, so it also closes the group: a later one of the
      // group claimed now would be answered before it.
      if (inBatch.has(candidate._persistentId)) {
        groupClosed = true;
        return false;
      }
      if (!sameObservationGroup(first, candidate)) return false;
      const size = observationBatchChars(candidate);
      if (chars + size > policy.maxChars) {
        groupClosed = true;
        return false;
      }
      chars += size;
      return true;
    };

    while (batch.length < maxMessages && !signal.aborted && !groupClosed) {
      if (this.buffer.getUnclaimedCount(sessionDbId) === 0) {
        if (!mayLinger) break;
        const remainingMs = lingerUntil - Date.now();
        if (remainingMs <= 0) break;
        const arrived = await this.buffer.waitForNewMessage(sessionDbId, signal, remainingMs);
        if (!arrived || signal.aborted) break;
        continue;
      }

      const claimed = this.buffer.claimMatching(sessionDbId, {
        isBarrier,
        accept,
        max: maxMessages - batch.length,
      });
      if (claimed.length === 0) {
        // Nothing waiting can join (a summarize ahead of it, only other
        // prompts/agents/cwds, or over budget): the batch ends here.
        break;
      }
      for (const message of claimed) {
        inBatch.add(message._persistentId);
        session.claimedMessageIds.push(message._persistentId);
        session.earliestPendingTimestamp = session.earliestPendingTimestamp === null
          ? message._originalTimestamp
          : Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
        batch.push(message);
      }
      session.lastGeneratorActivity = Date.now();
    }

    if (batch.length > 1) {
      logger.debug('QUEUE', `BATCH_CLAIMED | sessionDbId=${sessionDbId} | size=${batch.length} | chars=${chars} | ids=[${batch.map(message => message._persistentId).join(',')}]`, {
        sessionId: sessionDbId
      });
    }
    return batch;
  }

  getClaimedMessages(sessionDbId: number): PendingMessageWithId[] {
    const session = this.sessions.get(sessionDbId);
    const claimedIds = session?.claimedMessageIds ?? [];
    return this.buffer.getMessagesByIds(sessionDbId, claimedIds);
  }

  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return;
    }

    // Phase 2: emit this session's single observer_turn_rollup at session end,
    // while the session still exists. flushSession removes the bucket, so the
    // matching call in removeSessionImmediate (or a re-entry here) is a safe
    // no-op. Never throws — telemetry is fire-and-forget.
    telemetryBuffer.flushSession(sessionDbId, 'session_end');

    const sessionDuration = Date.now() - session.startTime;

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }

    session.abortReason = 'shutdown';
    session.abortController.abort();

    if (session.generatorPromise) {
      const generatorDone = session.generatorPromise.catch(() => {
        logger.debug('SYSTEM', 'Generator already failed, cleaning up', { sessionId: session.sessionDbId });
      });
      const timeoutDone = new Promise<void>(resolve => {
        AbortSignal.timeout(30_000).addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([generatorDone, timeoutDone]).then(() => {}, () => {
        logger.warn('SESSION', 'Generator did not exit within 30s after abort, forcing cleanup (#1099)', { sessionDbId });
      });
    }

    const tracked = getSdkProcessForSession(sessionDbId);
    if (tracked && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} (pgid ${tracked.pgid}) to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid,
        pgid: tracked.pgid
      });
      await ensureSdkProcessExit(tracked, 5000);
    }

    try {
      await getSupervisor().getRegistry().reapSession(sessionDbId);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('SESSION', 'Supervisor reapSession failed (non-blocking)', {
          sessionId: sessionDbId
        }, error);
      } else {
        logger.warn('SESSION', 'Supervisor reapSession failed (non-blocking) with non-Error', {
          sessionId: sessionDbId
        }, new Error(String(error)));
      }
    }

    if (this.takeRequestedSessionWrapup(session)) {
      this.deliverSessionWrapupInBackground(sessionDbId);
    }
    this.buffer.dispose(sessionDbId);
    this.queueCapDrops.delete(sessionDbId);
    this.sessions.delete(sessionDbId);
    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });
  }

  removeSessionImmediate(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) return;

    // Phase 2: same session-end rollup as deleteSession. Whichever teardown
    // path runs first flushes; flushSession removes the bucket so the second is
    // a no-op (guards against the deleteSession/removeSessionImmediate pair).
    telemetryBuffer.flushSession(sessionDbId, 'session_end');

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }

    if (this.takeRequestedSessionWrapup(session)) {
      this.deliverSessionWrapupInBackground(sessionDbId);
    }

    this.buffer.dispose(sessionDbId);
    this.queueCapDrops.delete(sessionDbId);
    this.sessions.delete(sessionDbId);
    logger.info('SESSION', 'Session removed from active sessions', {
      sessionId: sessionDbId,
      project: session.project
    });
  }

  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getTotalQueueDepth(): number {
    return this.buffer.getTotalDepth();
  }

  /**
   * Ids of live sessions that hold buffered work with no generator draining
   * it — the sessions a paused observer left behind (M3, plan 3.5).
   *
   * The resume scheduler asks this when a pause ends: a quota window elapses
   * (probe ONE of them), a breaker clears or Codex becomes ready (start ALL of
   * them), a transport backoff runs out (this one, if it is still listed).
   * Without it, a paused session's buffer only ever drained on that session's
   * next captured tool call, so the last observations of a session that ended
   * during a pause were never written.
   *
   * A session whose generator is still running is left out on purpose: that
   * generator is already draining the buffer, and "starting" it again would
   * only claim and release a gateway re-probe for nothing. Insertion order
   * (oldest session first) is preserved, so a single probe goes to the work
   * that has waited longest.
   */
  listSessionIdsWithPendingWork(): number[] {
    const ids: number[] = [];
    for (const [sessionDbId, session] of this.sessions) {
      if (session.generatorPromise) continue;
      if (this.buffer.getPendingCount(sessionDbId) > 0) ids.push(sessionDbId);
    }
    return ids;
  }

  async getTotalActiveWork(): Promise<number> {
    return this.getTotalQueueDepth();
  }

  async isAnySessionProcessing(): Promise<boolean> {
    return this.getTotalQueueDepth() > 0;
  }

  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    // Re-yield anything a prior generator pass claimed but did not confirm.
    await this.resetProcessingToPending(sessionDbId);

    for await (const message of this.buffer.drain({
      sessionDbId,
      signal: session.abortController.signal,
      onIdleTimeout: () => {
        logger.info('SESSION', 'Triggering abort due to idle timeout to kill subprocess', { sessionDbId });
        session.idleTimedOut = true;
        session.abortReason = 'idle';
        session.abortController.abort();
      }
    })) {
      session.claimedMessageIds.push(message._persistentId);
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = message._originalTimestamp;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
      }

      session.lastGeneratorActivity = Date.now();

      yield message;
    }
  }

  /** Read-only access to the in-RAM buffer for diagnostics. */
  getMessageBuffer(): SessionMessageBuffer {
    return this.buffer;
  }
}
