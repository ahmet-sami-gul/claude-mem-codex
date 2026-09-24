/**
 * Tolerant parser for `codex exec --json` stdout and helpers for its stderr
 * (plan 2.7, 5/L4).
 *
 * Measured success stream (Phase 0, codex-cli 0.144.4):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *     "output_tokens":N,"reasoning_output_tokens":N}}
 * codex-cli 0.156.1 (canary) adds one item.completed `error` right after
 * thread.started on code_mode_only models ("Code Mode is unavailable because
 * code-mode host is disabled. Code mode will fail closed ...") and
 * `cache_write_input_tokens` to the usage.
 *
 * Event handling:
 *   thread.started            -> thread id, logged only (never persisted)
 *   turn.started              -> ignored
 *   item.* agent_message      -> allowed; text collected from item.completed only
 *   item.* reasoning          -> allowed, ignored
 *   item.* error              -> info only, never fatal. Expected once per session
 *                                on code_mode_only models (the code-mode
 *                                fail-closed notice above)
 *   item.* todo_list          -> audit only, NOT fatal (update_plan is pinned off
 *                                on 0.156.1, so one means config drift)
 *   item.* anything else      -> TOOL ATTEMPT (command_execution, file_change,
 *                                mcp_tool_call, web_search, collab_tool_call,
 *                                unknown or missing type)
 *   turn.completed            -> success marker + usage
 *   turn.failed               -> failure message
 *   error "Reconnecting... n/m" -> info only
 *   error (other)             -> failure candidate; fatal only together with
 *                                turn.failed or exit code 1 (decided by the caller)
 *   non-JSON line / unknown event / unknown field -> counted and ignored
 *                                (cache_write_input_tokens, a subset of
 *                                input_tokens, is one such field)
 *
 * The guard only sees what exec emits: exec drops some tool item kinds from the
 * JSONL entirely (view_image, sleep, dynamic tools, some collab calls such as
 * send_message / followup_task / interrupt_agent / list_agents). Those tools
 * are removed before the call instead, by the pins and disables
 * (codex-invocation.ts) and CODEX_EXEC_SERVER_URL=none (codex-env.ts), never
 * left to this guard.
 *
 * Single-answer rule: the reply content is the LAST completed agent_message,
 * the same message exec itself treats as the turn's final one. A turn with more
 * than one (e.g. request_user_input_async text, which exec also emits as an
 * agent_message) keeps only the last; the count is exposed so the runner can
 * audit it. With one message the content is that message, unchanged.
 *
 * Usage semantics: `turn.completed.usage` is the THREAD CUMULATIVE total. For a
 * single-turn `--ephemeral` exec it equals the per-call usage. A future resume
 * transport must subtract the previous total (see codex-transport.ts).
 *
 * Every label the stream controls (item.type, the event type, item ids, the
 * thread id and each part of the audit `tool_name`) goes through
 * safeCodexLabel before it leaves this module: bounded and stripped of control
 * characters. Those values reach a SECURITY log line, and the logger formats
 * context as `k=v` by plain interpolation, so an unbounded value carrying
 * CR/LF could forge extra lines in the log an operator reads after a breach.
 *
 * Pure module: no I/O, no logging. The runner owns process control and acts on
 * the `tool_attempt` event (kill the process group on the first one).
 */

import { StringDecoder } from 'string_decoder';
import type { CodexToolAttempt, CodexTodoObservation, CodexUsage } from './codex-transport.js';

/** stdout is parsed up to this many bytes; the rest is ignored and flagged. */
export const CODEX_JSONL_MAX_BYTES = 8 * 1024 * 1024;

/** Bytes of stderr kept for classification. */
export const CODEX_STDERR_TAIL_BYTES = 2 * 1024;

/** Bound for the JSON excerpts stored on tool attempts and todo observations. */
export const CODEX_ITEM_EXCERPT_CHARS = 1024;

/** Line codex always writes to stderr when the prompt comes from stdin. */
export const CODEX_STDIN_NOTICE = 'Reading additional input from stdin...';

/** Items whose presence is expected and harmless. */
export const CODEX_ALLOWED_ITEM_TYPES: ReadonlySet<string> = new Set(['agent_message', 'reasoning']);

const RECONNECTING_RE = /^Reconnecting\.\.\. \d+\/\d+/;

/** Item fields dropped from audit excerpts: bulky and not needed to identify the attempt. */
const EXCERPT_DROPPED_FIELDS = new Set(['aggregated_output', 'output', 'result', 'content']);

export type CodexJsonlEvent =
  | { kind: 'thread_started'; threadId: string | null }
  | { kind: 'turn_started' }
  | { kind: 'agent_message'; text: string; itemId: string | null }
  | { kind: 'allowed_item'; itemType: string; eventType: string }
  | { kind: 'error_item'; message: string }
  | { kind: 'todo_list'; observation: CodexTodoObservation }
  | { kind: 'tool_attempt'; attempt: CodexToolAttempt }
  | { kind: 'turn_completed'; usage: CodexUsage | null }
  | { kind: 'turn_failed'; message: string }
  | { kind: 'reconnecting'; message: string }
  | { kind: 'error_candidate'; message: string }
  | { kind: 'unknown_event'; type: string }
  | { kind: 'malformed' }
  | { kind: 'ignored_blank' };

export interface CodexJsonlSummary {
  threadId: string | null;
  /** agent_message texts from item.completed, in order. */
  agentMessages: string[];
  /** agentMessages.length; above 1 the runner audits the turn (single-answer rule). */
  agentMessageCount: number;
  /** The last agent_message text ('' when there is none). */
  content: string;
  usage: CodexUsage | null;
  turnCompleted: boolean;
  turnFailedMessage: string | null;
  /** Last top-level `error` that was not a reconnect notice. */
  errorCandidate: string | null;
  /** turnFailedMessage ?? errorCandidate. */
  failureMessage: string | null;
  /** Info-only notices: error items and reconnect messages, in order. */
  nonFatalErrors: string[];
  toolAttempts: CodexToolAttempt[];
  todoObservations: CodexTodoObservation[];
  malformedLines: number;
  unknownEvents: number;
  /** True once stdout exceeded CODEX_JSONL_MAX_BYTES. */
  truncated: boolean;
  bytesSeen: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Max characters kept for any single stream-controlled label. */
export const CODEX_LABEL_MAX_CHARS = 120;

/**
 * Bound and de-fang one stream-controlled string before it can reach a log
 * line or an audit field. Every value classified out of the JSONL stream is
 * chosen by the child process, may be arbitrarily long and may contain CR/LF;
 * the logger formats context as `k=v` by plain interpolation, so an unbounded
 * value with newlines could forge whole extra log lines in the same SECURITY
 * entry an operator reads after a lockdown breach.
 */
export function safeCodexLabel(value: string, maxChars = CODEX_LABEL_MAX_CHARS): string {
  const flattened = value.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return flattened.length > maxChars ? flattened.slice(0, maxChars) + '...' : flattened;
}

function safeLabelOrNull(value: unknown, maxChars = CODEX_LABEL_MAX_CHARS): string | null {
  return typeof value === 'string' ? safeCodexLabel(value, maxChars) : null;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Tolerant usage reader: missing counters are 0, unknown fields are ignored. */
export function parseCodexUsage(value: unknown): CodexUsage | null {
  if (!isRecord(value)) return null;
  return {
    input: tokenCount(value.input_tokens),
    cached: tokenCount(value.cached_input_tokens),
    output: tokenCount(value.output_tokens),
    reasoning: tokenCount(value.reasoning_output_tokens),
  };
}

function boundedExcerpt(value: unknown, maxChars = CODEX_ITEM_EXCERPT_CHARS): string {
  let text: string;
  try {
    if (isRecord(value)) {
      const trimmed: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        if (!EXCERPT_DROPPED_FIELDS.has(key)) trimmed[key] = field;
      }
      text = JSON.stringify(trimmed) ?? '';
    } else {
      text = JSON.stringify(value) ?? '';
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: JSON.parse already produced this value, so it is
    // plain data; a throw here is theoretical and the placeholder is the designed
    // fallback for a pure module that must never throw on hostile input.
    text = '[unserializable]';
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '...[truncated]' : text;
}

/** Every part is bounded and control-char free: this becomes the audit `tool_name`. */
function describeToolName(itemType: string, item: Record<string, unknown>): string {
  const parts: string[] = [safeCodexLabel(itemType)];
  for (const key of ['command', 'server', 'tool', 'name', 'query']) {
    const field = item[key];
    if (typeof field === 'string' && field.length > 0) {
      parts.push(safeCodexLabel(field));
    }
  }
  const changes = item.changes;
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => (isRecord(change) && typeof change.path === 'string' ? safeCodexLabel(change.path) : null))
      .filter((path): path is string => path !== null)
      .slice(0, 3);
    if (paths.length > 0) parts.push(paths.join(','));
  }
  return parts.join(' ');
}

/**
 * Classify one stdout line. Stateless; CodexJsonlParser accumulates the
 * results. Never throws.
 */
export function classifyCodexJsonlLine(line: string): CodexJsonlEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'ignored_blank' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // [ANTI-PATTERN IGNORED]: non-JSON stdout lines are an expected, counted
    // condition in a tolerant stream parser (plan 2.7), not an error.
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return { kind: 'malformed' };
  }

  const type = parsed.type;
  switch (type) {
    case 'thread.started':
      return { kind: 'thread_started', threadId: safeLabelOrNull(parsed.thread_id) };
    case 'turn.started':
      return { kind: 'turn_started' };
    case 'turn.completed':
      return { kind: 'turn_completed', usage: parseCodexUsage(parsed.usage) };
    case 'turn.failed': {
      const error = isRecord(parsed.error) ? parsed.error : null;
      const message = stringOrNull(error?.message) ?? stringOrNull(parsed.message) ?? 'turn.failed without a message';
      return { kind: 'turn_failed', message };
    }
    case 'error': {
      const message = stringOrNull(parsed.message)
        ?? (isRecord(parsed.error) ? stringOrNull(parsed.error.message) : null)
        ?? 'error event without a message';
      if (RECONNECTING_RE.test(message)) return { kind: 'reconnecting', message };
      return { kind: 'error_candidate', message };
    }
    default:
      break;
  }

  if (type.startsWith('item.')) {
    const item = isRecord(parsed.item) ? parsed.item : null;
    // itemType / eventType / itemId are fully stream-controlled and end up in
    // SECURITY log lines and audit fields, so they are bounded and stripped of
    // control characters here, at the single classification point.
    const eventType = safeCodexLabel(type);
    const itemType = item && typeof item.type === 'string' && item.type.length > 0 ? safeCodexLabel(item.type) : 'unknown';
    const itemId = item ? safeLabelOrNull(item.id) : null;

    if (itemType === 'agent_message') {
      if (type === 'item.completed') {
        return { kind: 'agent_message', text: stringOrNull(item?.text) ?? '', itemId };
      }
      return { kind: 'allowed_item', itemType, eventType };
    }
    if (CODEX_ALLOWED_ITEM_TYPES.has(itemType)) {
      return { kind: 'allowed_item', itemType, eventType };
    }
    if (itemType === 'error') {
      const message = stringOrNull(item?.message) ?? 'error item without a message';
      return { kind: 'error_item', message };
    }
    if (itemType === 'todo_list') {
      return {
        kind: 'todo_list',
        observation: { eventType, itemId, summary: boundedExcerpt(item) },
      };
    }
    return {
      kind: 'tool_attempt',
      attempt: {
        eventType,
        itemType,
        itemId,
        toolName: item ? describeToolName(itemType, item) : itemType,
        toolInput: boundedExcerpt(item ?? parsed),
      },
    };
  }

  return { kind: 'unknown_event', type: safeCodexLabel(type) };
}

/**
 * Incremental parser. Feed stdout chunks with push(); each complete line is
 * classified and folded into the summary, and the classified events are
 * returned so the runner can react immediately (kill on `tool_attempt`).
 */
export class CodexJsonlParser {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private bytesSeen = 0;
  private truncated = false;
  private threadId: string | null = null;
  private readonly agentMessages: string[] = [];
  private usage: CodexUsage | null = null;
  private turnCompleted = false;
  private turnFailedMessage: string | null = null;
  private errorCandidate: string | null = null;
  private readonly nonFatalErrors: string[] = [];
  private readonly toolAttempts: CodexToolAttempt[] = [];
  private readonly todoObservations: CodexTodoObservation[] = [];
  private malformedLines = 0;
  private unknownEvents = 0;

  constructor(private readonly maxBytes: number = CODEX_JSONL_MAX_BYTES) {}

  /**
   * Feed a stdout chunk; returns the events for every line it completed.
   * Byte chunks may split a UTF-8 sequence; the decoder carries it over.
   */
  push(chunk: string | Uint8Array): CodexJsonlEvent[] {
    if (this.truncated) return [];
    let bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const remaining = Math.max(0, this.maxBytes - this.bytesSeen);
    if (bytes.length > remaining) {
      bytes = bytes.subarray(0, remaining);
      this.truncated = true;
    }
    this.bytesSeen += bytes.length;
    this.buffer += this.decoder.write(bytes);

    const events: CodexJsonlEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      events.push(this.pushLine(line));
      newline = this.buffer.indexOf('\n');
    }
    if (this.truncated) {
      // The partial tail line is cut mid-way; never parse it.
      this.buffer = '';
    }
    return events;
  }

  /** Classify one complete line and fold it into the summary. */
  pushLine(line: string): CodexJsonlEvent {
    const event = classifyCodexJsonlLine(line);
    switch (event.kind) {
      case 'thread_started':
        this.threadId = event.threadId;
        break;
      case 'agent_message':
        this.agentMessages.push(event.text);
        break;
      case 'error_item':
        this.nonFatalErrors.push(event.message);
        break;
      case 'todo_list':
        this.todoObservations.push(event.observation);
        break;
      case 'tool_attempt':
        this.toolAttempts.push(event.attempt);
        break;
      case 'turn_completed':
        this.turnCompleted = true;
        if (event.usage) this.usage = event.usage;
        break;
      case 'turn_failed':
        this.turnFailedMessage = event.message;
        break;
      case 'reconnecting':
        this.nonFatalErrors.push(event.message);
        break;
      case 'error_candidate':
        this.errorCandidate = event.message;
        break;
      case 'unknown_event':
        this.unknownEvents++;
        break;
      case 'malformed':
        this.malformedLines++;
        break;
      case 'turn_started':
      case 'allowed_item':
      case 'ignored_blank':
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
    return event;
  }

  /** Flush a final unterminated line (stdout closed without a trailing newline). */
  end(): CodexJsonlEvent[] {
    const rest = this.decoder.end();
    if (this.truncated) {
      this.buffer = '';
      return [];
    }
    this.buffer += rest;
    if (this.buffer.length === 0) return [];
    const line = this.buffer;
    this.buffer = '';
    return [this.pushLine(line)];
  }

  summary(): CodexJsonlSummary {
    const failureMessage = this.turnFailedMessage ?? this.errorCandidate;
    return {
      threadId: this.threadId,
      agentMessages: [...this.agentMessages],
      agentMessageCount: this.agentMessages.length,
      content: this.agentMessages.length > 0 ? this.agentMessages[this.agentMessages.length - 1] : '',
      usage: this.usage ? { ...this.usage } : null,
      turnCompleted: this.turnCompleted,
      turnFailedMessage: this.turnFailedMessage,
      errorCandidate: this.errorCandidate,
      failureMessage,
      nonFatalErrors: [...this.nonFatalErrors],
      toolAttempts: [...this.toolAttempts],
      todoObservations: [...this.todoObservations],
      malformedLines: this.malformedLines,
      unknownEvents: this.unknownEvents,
      truncated: this.truncated,
      bytesSeen: this.bytesSeen,
    };
  }
}

/** Parse a complete stdout capture in one call. */
export function parseCodexJsonl(stdout: string, maxBytes: number = CODEX_JSONL_MAX_BYTES): CodexJsonlSummary {
  const parser = new CodexJsonlParser(maxBytes);
  parser.push(stdout);
  parser.end();
  return parser.summary();
}

// ---------------------------------------------------------------------------
// stderr
// ---------------------------------------------------------------------------

/** Remove the stdin notice line(s) codex always prints; keeps everything else. */
export function stripCodexStdinNotice(text: string): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== CODEX_STDIN_NOTICE)
    .join('\n');
}

/**
 * Append a stderr chunk and keep only the last `maxBytes` bytes (UTF-8 safe:
 * a split multi-byte sequence at the cut is dropped).
 */
export function appendCodexStderrTail(
  previous: string,
  chunk: string | Uint8Array,
  maxBytes: number = CODEX_STDERR_TAIL_BYTES,
): string {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const combined = Buffer.from(previous + text, 'utf8');
  if (combined.length <= maxBytes) return previous + text;
  let start = combined.length - maxBytes;
  // Skip UTF-8 continuation bytes so the tail starts on a character boundary.
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start++;
  return combined.subarray(start).toString('utf8');
}
