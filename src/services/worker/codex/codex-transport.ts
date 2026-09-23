/**
 * Codex transport contract (plan 3.3).
 *
 * Every Codex model call goes through a `CodexTransport`. Phase 1 has exactly
 * one implementation, the stateless `codex exec --ephemeral --json` runner
 * (codex-exec-runner.ts), and exactly one call shape: `oneShot(prompt, ctx)`.
 * claude-mem's own `session.conversationHistory` is the single source of truth
 * for conversation state; nothing is stored on the Codex side.
 *
 * `startThread` / `resumeTurn` are RESERVED for a possible Phase 2 transport
 * (`exec resume` or `app-server`) that would keep a Codex thread alive between
 * calls. They are declared optional so the base provider never depends on
 * them. Note for that future work: `turn.completed.usage` is the THREAD
 * CUMULATIVE total (Phase 0: rollout `token_count` last 5,595 vs total 11,165),
 * so a resume transport must report the per-turn delta, not the raw value.
 *
 * Pure type module: no runtime behaviour, no logging.
 */

/** Why a Codex call is made; mirrors the base provider's query purposes. */
export type CodexCallPurpose =
  | 'init'
  | 'observation'
  | 'summary'
  | 'field_compression'
  | 'telegram_wrapup';

/** `-c model_reasoning_effort=` values accepted by the argv builder. */
export type CodexReasoningEffort = 'low' | 'medium' | 'high';

/** `-c model_verbosity=` values accepted by the argv builder. */
export type CodexVerbosity = 'low' | 'medium' | 'high';

/** Everything a transport needs to run one turn. */
export interface CodexTurnContext {
  sessionDbId: number;
  purpose: CodexCallPurpose;
  /** Absolute native codex binary (from findCodexExecutable; never the bare name). */
  binaryPath: string;
  /** Validated model id (MODEL_ID_RE). */
  model: string;
  effort: CodexReasoningEffort;
  verbosity: CodexVerbosity;
  /** Hard deadline for the whole exec (CLAUDE_MEM_CODEX_TIMEOUT_MS). */
  timeoutMs: number;
  /** Session abort signal; aborting interrupts the process group. */
  abortSignal?: AbortSignal;
  /** Audit/log context only. */
  contentSessionId?: string;
  project?: string;
  /**
   * Last word before a process exists: called after the pool slot is granted
   * and immediately before the spawn, with the slot still held. Throwing
   * refuses the turn — the slot is released and nothing is spawned.
   *
   * The provider's quota circuit also runs before the turn is handed to the
   * transport, but a turn can then wait for a slot indefinitely (#2756), and
   * a breaker armed while it waited would otherwise not be seen until after
   * the exec it exists to prevent.
   */
  beforeSpawn?: () => void | Promise<void>;
}

/**
 * Token usage from `turn.completed.usage`. For a single-turn `--ephemeral`
 * exec the cumulative thread total equals the per-call usage.
 */
export interface CodexUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

/**
 * A forbidden item (command_execution, file_change, mcp_tool_call, web_search,
 * collab_tool_call, image/view_image, unknown) seen on the JSONL stream. The
 * runner kills the process group on the first one (plan 5, L4).
 */
export interface CodexToolAttempt {
  /** The `item.*` event that carried it (item.started / item.updated / item.completed). */
  eventType: string;
  /** `item.type`, or 'unknown' when missing. */
  itemType: string;
  itemId: string | null;
  /** item.type plus command / server / tool name, for the audit `tool_name`. */
  toolName: string;
  /** Bounded JSON of the item (large output fields removed), for the audit `tool_input`. */
  toolInput: string;
}

/** A `todo_list` (update_plan) item: audited, never fatal (plan 5, L4). */
export interface CodexTodoObservation {
  eventType: string;
  itemId: string | null;
  /** Bounded JSON of the item. */
  summary: string;
}

/** Result of one turn, whether it succeeded or not. */
export interface TurnResult {
  /** `thread.started.thread_id`; logged only, never persisted. */
  threadId: string | null;
  /** `agent_message` texts from `item.completed`, joined with '\n'. */
  text: string;
  /** Null when no `turn.completed` carried usage. */
  usage: CodexUsage | null;
  /** True when `turn.completed` was seen. */
  turnCompleted: boolean;
  /** `turn.failed.error.message`, else the last non-reconnect top-level `error`. */
  failureMessage: string | null;
  /** Info-only messages: `error` items and `Reconnecting... n/m` notices. */
  nonFatalErrors: string[];
  /** First forbidden item, or null. When set, `text` must be discarded. */
  toolAttempt: CodexToolAttempt | null;
  /** Audit-only todo_list items. */
  todoObservations: CodexTodoObservation[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when our own deadline fired (transient `codex_timeout`). */
  timedOut: boolean;
  /**
   * True when stdout passed the JSONL cap. Past the cap the parser stops
   * emitting events, so the L4 runtime tool guard no longer sees the stream:
   * the turn must fail CLOSED (setup_required `codex_stream_truncated`), never
   * settle as a success or an ordinary transient.
   */
  truncated: boolean;
  /**
   * Top-level events whose `type` is neither a known lifecycle event nor an
   * `item.*` one. A tool signalled under a renamed namespace would land here
   * instead of reaching the guard, so a non-zero count is logged at SECURITY.
   */
  unknownEvents: number;
  /**
   * Last ~2 KB of stderr with the stdin notice removed; for classification
   * only, never logged raw. The runner detaches the shared registry's own
   * stderr listener (which logs chunks at DEBUG and the raw tail at WARN on a
   * non-zero close) so there is no second, unredacted sink for these bytes;
   * everything that reaches a log goes through redactCodexDiagnostic. M2
   * replaces the detach with a label/redactor seam on SpawnSdkOptions
   * (plan 3.4), which also fixes the registry's "Claude process exited" label.
   */
  stderrTail: string;
  durationMs: number;
}

/** Phase 1 transport kinds; only 'exec' is implemented. */
export type CodexTransportKind = 'exec' | 'exec-resume' | 'app-server';

export interface CodexTransport {
  readonly kind: CodexTransportKind;

  /** Run one stateless turn: prompt goes to stdin, stdin is closed, JSONL is parsed. */
  oneShot(prompt: string, ctx: CodexTurnContext): Promise<TurnResult>;

  /** RESERVED (Phase 2): open a persistent thread. Not implemented in Phase 1. */
  startThread?(prompt: string, ctx: CodexTurnContext): Promise<TurnResult>;

  /** RESERVED (Phase 2): continue a persistent thread. Not implemented in Phase 1. */
  resumeTurn?(threadId: string, prompt: string, ctx: CodexTurnContext): Promise<TurnResult>;
}
