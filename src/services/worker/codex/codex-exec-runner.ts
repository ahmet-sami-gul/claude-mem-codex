/**
 * Stateless `codex exec --ephemeral --json` transport (plan 2.4-2.8, 5/L1, 5/L4).
 *
 * One call = one short-lived native codex process:
 *
 *   1. Validate the context and build the closed argv (codex-invocation.ts).
 *      The argv never carries the prompt; it ends with `-` (stdin).
 *   2. accessSync(binary, X_OK) BEFORE waiting for a slot (no point queueing
 *      for a binary that is gone) and again right before the spawn.
 *   3. Jail check (L1): the forced cwd OBSERVER_SESSIONS_DIR/<sessionDbId>
 *      must be a real directory, hold none of the files Codex reads from its
 *      cwd, and have no `.git` between it and DATA_DIR. The ancestor walk is
 *      bounded at DATA_DIR on purpose (see assertCodexJailSafe).
 *   4. waitForSlot() from the shared agent pool. Its abort rejections are plain
 *      Errors; they are re-thrown as `name === 'AbortError'` so
 *      FallbackErrorHandler.isAbortError recognises them. "Hard cap exceeded"
 *      is transient.
 *   5. spawnSdkProcess() (never createSdkSpawnFactory: that one SIGTERMs the
 *      session's other 'sdk' processes). It forces the cwd, sanitizes the env
 *      again and registers the child as an 'sdk' pool member. The slot
 *      reservation is released right after it returns. `null` means the
 *      registry could not start the process: setup_required
 *      codex_spawn_failed (errno is only logged by the registry, so it is not
 *      mapped). The caller's `beforeSpawn` runs just before it (not awaited
 *      when synchronous) and `onSpawned` just after a process exists, in the
 *      same synchronous block — the local exec budget (M4) counts there.
 *   6. stdin: EPIPE is swallowed, the prompt is written, stdin is ended. codex
 *      exec blocks forever without EOF (Phase 0), so this is never skipped.
 *   7. stdout is parsed line by line (CodexJsonlParser, 8 MB cap); the last
 *      2 KB of stderr are kept without the "Reading additional input from
 *      stdin..." notice. Crossing the cap makes the parser stop emitting
 *      events, which would blind the L4 guard, so it SIGKILLs the group and
 *      the turn fails closed (setup_required `codex_stream_truncated`).
 *   8. Runtime tool guard (L4): the first forbidden item (command_execution,
 *      file_change, mcp_tool_call, web_search, collab_tool_call, image,
 *      unknown) SIGKILLs the whole process group, writes a 'denied' audit
 *      entry with provider 'codex', logs SECURITY and discards the turn text.
 *      `todo_list` (update_plan cannot be removed in exec) is audited as
 *      'observed' once per item and the process keeps running.
 *   9. Deadline / session abort: SIGINT to -pgid (exec turns it into a turn
 *      interrupt), SIGKILL to -pgid after the grace period (5 s). A timeout is
 *      transient `codex_timeout`; an abort is re-thrown as AbortError. Any
 *      straggler left in the group is SIGKILLed before the call returns.
 *
 * oneShot() returns the raw TurnResult (the CodexTransport contract).
 * run() = oneShot() + settleCodexTurn(): the plan 2.8 exit table, returning
 * content or throwing a ClassifiedProviderError. There are NO provider-level
 * retries: every attempt is a paid plan message and codex already retries its
 * stream internally.
 *
 * Messages produced here never contain "code 143" or "signal SIGTERM":
 * SessionRoutes treats those substrings as an external kill and drops the
 * batch without recording a failure (plan 2.6).
 */

import { accessSync, constants, existsSync, lstatSync, readdirSync } from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { logger } from '../../../utils/logger.js';
import { recordObserverToolAttempt } from '../../../utils/observer-audit.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import {
  normalizeSpawnSdkCwd,
  spawnSdkProcess,
  waitForSlot,
  type SlotReservation,
  type SpawnedSdkProcess,
} from '../../../supervisor/process-registry.js';
import { DATA_DIR, ensureDir, USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { ClassifiedProviderError } from '../provider-errors.js';
import { buildCodexExecArgs } from './codex-invocation.js';
import { buildCodexObserverEnv, resolveCodexHome, type CodexEnvSettings } from './codex-env.js';
import {
  appendCodexStderrTail,
  CodexJsonlParser,
  stripCodexStdinNotice,
  type CodexJsonlEvent,
} from './codex-jsonl.js';
import {
  classifyCodexFailure,
  interpretCodexTurn,
  neutralizeKillMarkers,
  redactCodexDiagnostic,
  type CodexRunnerCondition,
} from './codex-errors.js';
import type {
  CodexToolAttempt,
  CodexTransport,
  CodexTurnContext,
  TurnResult,
} from './codex-transport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SIGINT -> SIGKILL grace on timeout / abort (plan 2.6). */
export const CODEX_KILL_GRACE_MS = 5_000;

/**
 * After the leader exits, how long to wait for stdout/stderr to close. A
 * descendant still holding the pipes is SIGKILLed with the group when this
 * expires, so a stray process can never keep a call open.
 */
export const CODEX_EXIT_DRAIN_MS = 2_000;

/** Default for CLAUDE_MEM_CODEX_TIMEOUT_MS (plan 4); the provider passes the clamped value. */
export const CODEX_DEFAULT_TIMEOUT_MS = 180_000;

/** Upper bound accepted for ctx.timeoutMs (the setting's maximum). */
export const CODEX_MAX_TIMEOUT_MS = 600_000;

/** A second guard kill in the same session escalates to setup_required codex_lockdown_breach. */
export const CODEX_LOCKDOWN_BREACH_THRESHOLD = 2;

/** Entries in a jail directory that Codex would read from its cwd (plan 2.4). */
export const CODEX_JAIL_FORBIDDEN_ENTRIES: ReadonlySet<string> = new Set([
  '.git',
  '.codex',
  '.agents',
  '.mcp.json',
  'plugin',
]);

const AGENTS_DOC_RE = /^agents.*\.md$/i;

const SETUP_ACTIONS = Object.freeze({
  codex_invalid_config: 'Fix the CLAUDE_MEM_CODEX_* settings (model id, reasoning effort, verbosity, timeout).',
  codex_home_invalid: 'Set CLAUDE_MEM_CODEX_HOME (or CODEX_HOME) to an absolute path, or unset it to use ~/.codex.',
  codex_jail_unsafe: 'Remove the reported entry from the observer session directory; it must hold no Codex config, and neither it nor claude-mem\'s data directory may be a git work tree (move CLAUDE_MEM_DATA_DIR out of the checkout if it is).',
} as const);

// ---------------------------------------------------------------------------
// Seams and helpers
// ---------------------------------------------------------------------------

/**
 * Seam for unit tests (pattern: src/shared/find-claude-executable.ts). Tests
 * reassign members instead of mocking child_process, which is process-wide.
 */
export const _internals = {
  spawnSdkProcess,
  waitForSlot,
  accessSync: accessSync as (file: string, mode?: number) => void,
  killProcessGroup: (pgid: number, signal: NodeJS.Signals): void => {
    process.kill(-pgid, signal);
  },
};

/** Error whose name FallbackErrorHandler.isAbortError recognises. */
export function createCodexAbortError(message = 'Codex exec aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

/**
 * Tell the caller a process now exists (CodexTurnContext.onSpawned). The exec
 * is already running and will be supervised whatever the callback does, so a
 * throw is logged, never propagated — propagating it would abandon a live
 * process group with no one reading its output.
 */
function notifySpawned(ctx: CodexTurnContext, pid: number): void {
  if (!ctx.onSpawned) return;
  try {
    ctx.onSpawned();
  } catch (error: unknown) {
    logger.warn('SDK', 'Codex onSpawned callback threw; the exec continues', {
      sessionId: ctx.sessionDbId,
      purpose: ctx.purpose,
      pid,
      error: errorMessage(error),
    });
  }
}

function conditionError(condition: CodexRunnerCondition, detail?: string): ClassifiedProviderError {
  const outcome = classifyCodexFailure({ condition, detail: detail ?? null });
  if (outcome.type !== 'error') {
    // classifyCodexFailure always returns an error for a runner condition.
    throw new Error(`codex condition ${condition} did not classify as an error`);
  }
  return outcome.error;
}

function setupError(code: keyof typeof SETUP_ACTIONS, message: string, cause: unknown): ClassifiedProviderError {
  return new ClassifiedProviderError(neutralizeKillMarkers(message), {
    kind: 'setup_required',
    code,
    cause: cause instanceof Error ? cause : new Error(String(cause)),
    action: SETUP_ACTIONS[code],
  });
}

/**
 * Deliver `signal` to the child's whole process group (spawnSdkProcess starts
 * it detached, so pgid === pid). ESRCH (group already gone) is expected.
 * Windows has no process groups; the direct child is signalled instead.
 */
export function killCodexProcessGroup(
  pgid: number,
  child: Pick<SpawnedSdkProcess, 'kill'>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && Number.isInteger(pgid) && pgid > 0) {
    try {
      _internals.killProcessGroup(pgid, signal);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') return;
      logger.debug('SDK', 'Codex process-group signal failed; signalling the child directly', {
        pgid,
        signal,
        code,
      });
    }
  }
  try {
    child.kill(signal);
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: the child is already gone; nothing is left to signal.
    logger.debug('SDK', 'Codex child signal failed (already exited)', { signal, error: errorMessage(error) });
  }
}

export class CodexJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexJailError';
  }
}

/**
 * Jail check (plan 2.4, 5/L1). Throws CodexJailError when `dir` is not an
 * absolute real directory (a symlink could point anywhere), holds an entry
 * Codex reads from its cwd (AGENTS*.md, .codex, .agents, .git, .mcp.json,
 * plugin/), or has a `.git` between it and claude-mem's own data root. Other
 * entries are tolerated: the Claude observer shares the per-session directory.
 *
 * The ancestor walk STOPS at DATA_DIR and never leaves it. Walking all the way
 * to `/` would pass through $HOME, so a dotfiles repo at `~/.git` (or a
 * CLAUDE_MEM_DATA_DIR inside any checkout) would fail every exec and the
 * self-check with an unactionable setup_required, permanently disabling the
 * provider. An ancestor `.git` is harmless to Codex anyway: the argv pins
 * `--skip-git-repo-check`, `-c project_root_markers=[]` and
 * `-c project_doc_max_bytes=0`.
 */
export function assertCodexJailSafe(dir: string, boundaryDir: string = DATA_DIR): void {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new CodexJailError(`Codex jail directory must be absolute (got ${String(dir)})`);
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new CodexJailError(`Codex jail directory ${dir} is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new CodexJailError(`Codex jail ${dir} is not a directory`);
  }
  for (const entry of readdirSync(dir)) {
    if (CODEX_JAIL_FORBIDDEN_ENTRIES.has(entry) || AGENTS_DOC_RE.test(entry)) {
      throw new CodexJailError(`Codex jail directory ${dir} contains ${entry}`);
    }
  }
  const boundary = path.resolve(boundaryDir);
  const inBoundary = (candidate: string): boolean =>
    candidate === boundary || candidate.startsWith(boundary + path.sep);
  let current = path.dirname(dir);
  while (inBoundary(current)) {
    if (existsSync(path.join(current, '.git'))) {
      throw new CodexJailError(`Codex jail directory ${dir} is inside a git work tree (${current})`);
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Per-session count of guard kills (plan 5, L4 "repeated violation"). */
export class CodexViolationTracker {
  private readonly counts = new Map<number, number>();

  record(sessionDbId: number): number {
    const next = (this.counts.get(sessionDbId) ?? 0) + 1;
    this.counts.set(sessionDbId, next);
    return next;
  }

  count(sessionDbId: number): number {
    return this.counts.get(sessionDbId) ?? 0;
  }

  /** Forget one session (generator exit) or all sessions. */
  clear(sessionDbId?: number): void {
    if (sessionDbId === undefined) this.counts.clear();
    else this.counts.delete(sessionDbId);
  }
}

/** Shared by every ExecTransport that does not bring its own tracker. */
export const codexViolationTracker = new CodexViolationTracker();

// ---------------------------------------------------------------------------
// Outcome (plan 2.8)
// ---------------------------------------------------------------------------

export type CodexExecOutcome =
  | { kind: 'success'; content: string; result: TurnResult }
  /** Returned as content so ResponseProcessor's recycle branch runs. */
  | { kind: 'context_overflow'; content: string; result: TurnResult }
  /** Content policy refusal: only this batch is dropped. */
  | { kind: 'content_policy'; content: ''; result: TurnResult }
  /** Guard kill: the batch is confirmed and dropped, never retried. */
  | { kind: 'tool_attempt'; content: ''; result: TurnResult; violationCount: number };

export interface SettleCodexTurnOptions {
  now?: number | Date;
  timeZone?: string;
  violations?: CodexViolationTracker;
}

/**
 * Apply the plan 2.8 exit table to a finished turn: returns content, or throws
 * a ClassifiedProviderError (quota_exhausted, rate_limit, auth_invalid,
 * setup_required, transient). A second guard kill in the same session throws
 * setup_required codex_lockdown_breach.
 */
export function settleCodexTurn(
  result: TurnResult,
  ctx: Pick<CodexTurnContext, 'sessionDbId' | 'purpose'>,
  options: SettleCodexTurnOptions = {},
): CodexExecOutcome {
  const outcome = interpretCodexTurn(result, { now: options.now, timeZone: options.timeZone });
  switch (outcome.type) {
    case 'success':
      return { kind: 'success', content: outcome.content, result };
    case 'tool_attempt': {
      const violations = options.violations ?? codexViolationTracker;
      const count = Math.max(1, violations.count(ctx.sessionDbId));
      if (count >= CODEX_LOCKDOWN_BREACH_THRESHOLD) {
        throw conditionError(
          'lockdown_breach',
          `${count} forbidden tool attempts in session ${ctx.sessionDbId}; last was ${outcome.attempt.itemType}`,
        );
      }
      return { kind: 'tool_attempt', content: '', result, violationCount: count };
    }
    case 'context_overflow':
      logger.info('SDK', 'Codex reported a context overflow; returning it as content for recycle', {
        sessionId: ctx.sessionDbId,
        purpose: ctx.purpose,
      });
      return { kind: 'context_overflow', content: outcome.content, result };
    case 'content_policy':
      logger.warn('SDK', 'Codex refused the request under its content policy; dropping this batch', {
        sessionId: ctx.sessionDbId,
        purpose: ctx.purpose,
      });
      return { kind: 'content_policy', content: '', result };
    case 'error':
      logger.warn('SDK', 'Codex exec failed', {
        sessionId: ctx.sessionDbId,
        purpose: ctx.purpose,
        kind: outcome.error.kind,
        code: outcome.error.code,
        rule: outcome.rule,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        resumeAtMs: outcome.resumeAtMs,
      });
      throw outcome.error;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled codex outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface ExecTransportOptions {
  /** Pool size, re-read on every slot recheck; defaults to CLAUDE_MEM_MAX_CONCURRENT_AGENTS. */
  maxConcurrent?: () => number;
  /** File/env-only settings for the child env (CLAUDE_MEM_CODEX_HOME). */
  envSettings?: () => CodexEnvSettings;
  /** SIGINT -> SIGKILL grace; default CODEX_KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Wait for stdio to close after the leader exits; default CODEX_EXIT_DRAIN_MS. */
  exitDrainMs?: number;
  violations?: CodexViolationTracker;
}

function defaultMaxConcurrent(): number {
  return parseInt(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || 2;
}

interface SpawnHandle {
  process: SpawnedSdkProcess;
  pid: number;
  pgid: number;
}

export class ExecTransport implements CodexTransport {
  readonly kind = 'exec' as const;

  private readonly maxConcurrent: () => number;
  private readonly envSettings: () => CodexEnvSettings;
  /** Public (like `violations`) so the production defaults and their ordering are testable. */
  readonly killGraceMs: number;
  readonly exitDrainMs: number;
  readonly violations: CodexViolationTracker;

  constructor(options: ExecTransportOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent;
    this.envSettings = options.envSettings ?? (() => ({}));
    this.killGraceMs = options.killGraceMs ?? CODEX_KILL_GRACE_MS;
    this.exitDrainMs = options.exitDrainMs ?? CODEX_EXIT_DRAIN_MS;
    this.violations = options.violations ?? codexViolationTracker;
  }

  /** oneShot() + settleCodexTurn(): content, or a thrown classified error / AbortError. */
  async run(
    prompt: string,
    ctx: CodexTurnContext,
    options: Omit<SettleCodexTurnOptions, 'violations'> = {},
  ): Promise<CodexExecOutcome> {
    const result = await this.oneShot(prompt, ctx);
    return settleCodexTurn(result, ctx, { ...options, violations: this.violations });
  }

  async oneShot(prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
    const signal = ctx.abortSignal;
    if (signal?.aborted) {
      throw createCodexAbortError('Codex exec aborted before start');
    }
    if (typeof prompt !== 'string') {
      throw setupError('codex_invalid_config', 'Codex prompt must be a string', new TypeError(typeof prompt));
    }
    if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0 || ctx.timeoutMs > CODEX_MAX_TIMEOUT_MS) {
      throw setupError('codex_invalid_config', `Codex timeout must be between 1 and ${CODEX_MAX_TIMEOUT_MS} ms (got ${String(ctx.timeoutMs)})`, new RangeError('timeoutMs'));
    }
    if (!Number.isSafeInteger(ctx.sessionDbId) || ctx.sessionDbId < 0) {
      throw setupError('codex_invalid_config', `Codex sessionDbId must be a non-negative integer (got ${String(ctx.sessionDbId)})`, new RangeError('sessionDbId'));
    }

    const jailDir = normalizeSpawnSdkCwd(ctx.sessionDbId);
    const args = this.buildArgs(ctx, jailDir);
    this.assertExecutable(ctx.binaryPath);
    this.assertCodexHome();
    this.prepareJail(jailDir);

    const reservation = await this.acquireSlot(ctx);
    let handle: SpawnHandle | null;
    try {
      if (signal?.aborted) {
        throw createCodexAbortError('Codex exec aborted before spawn');
      }
      // Inside the try on purpose: a refusal here still releases the slot.
      // A synchronous check is deliberately not awaited, so the check, the
      // spawn below and onSpawned run in one synchronous block and no other
      // turn can spawn between this turn's check and its own count.
      if (ctx.beforeSpawn) {
        const gate = ctx.beforeSpawn();
        if (isPromiseLike(gate)) await gate;
        if (signal?.aborted) {
          throw createCodexAbortError('Codex exec aborted before spawn');
        }
      }
      this.assertExecutable(ctx.binaryPath);
      try {
        handle = _internals.spawnSdkProcess(ctx.sessionDbId, {
          command: ctx.binaryPath,
          args,
          env: buildCodexObserverEnv(sanitizeEnv(process.env), this.envSettings()),
          // Plan 3.4's process-registration decision, option (a). The Telegram
          // wrap-up runs under a live session's id but is NOT that session's
          // generator; registered as an ordinary 'sdk' record it would be the
          // record handleGeneratorExit reaps (matches[0]), so a wrap-up that
          // overlaps a generator exit would be SIGKILLed after 5 s — or reaped
          // in place of the generator's own exec, leaving that one running.
          // 'aux' keeps it out of that lookup; it still holds a slot.
          ...(ctx.purpose === 'telegram_wrapup' ? { role: 'aux' as const } : {}),
        });
      } catch (error: unknown) {
        // spawn() throws synchronously on invalid arguments; treat like a null return.
        throw conditionError('spawn_failed', `spawn threw: ${errorMessage(error)}`);
      }
    } finally {
      // The registry 'sdk' record (registered inside spawnSdkProcess) now
      // carries the slot accounting; on failure the slot goes back to the pool.
      reservation.release();
    }

    if (!handle) {
      throw conditionError('spawn_failed', 'the process registry could not start the Codex process');
    }
    notifySpawned(ctx, handle.pid);
    return this.supervise(handle, prompt, ctx);
  }

  private buildArgs(ctx: CodexTurnContext, jailDir: string): string[] {
    if (typeof ctx.binaryPath !== 'string' || !path.isAbsolute(ctx.binaryPath)) {
      throw conditionError('resolution_failed', 'the Codex binary path must be absolute');
    }
    try {
      return buildCodexExecArgs({ model: ctx.model, effort: ctx.effort, verbosity: ctx.verbosity, jailDir });
    } catch (error: unknown) {
      throw setupError('codex_invalid_config', `Codex observer settings are not valid: ${errorMessage(error)}`, error);
    }
  }

  private assertExecutable(binaryPath: string): void {
    try {
      _internals.accessSync(binaryPath, constants.X_OK);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
      throw conditionError('not_executable', `accessSync(X_OK) failed (${code})`);
    }
  }

  /** CODEX_HOME resolution fails closed on a relative / NUL value (codex-env.ts). */
  private assertCodexHome(): void {
    try {
      resolveCodexHome(this.envSettings(), sanitizeEnv(process.env));
    } catch (error: unknown) {
      throw setupError('codex_home_invalid', `Codex home is not usable: ${errorMessage(error)}`, error);
    }
  }

  private prepareJail(jailDir: string): void {
    try {
      ensureDir(jailDir);
      assertCodexJailSafe(jailDir);
    } catch (error: unknown) {
      logger.warn('SECURITY', 'Codex jail directory failed the safety check; not spawning', {
        jailDir,
        error: errorMessage(error),
      });
      throw setupError('codex_jail_unsafe', `Codex jail directory is not safe: ${errorMessage(error)}`, error);
    }
  }

  private async acquireSlot(ctx: CodexTurnContext): Promise<SlotReservation> {
    const signal = ctx.abortSignal;
    let reservation: SlotReservation;
    try {
      reservation = await _internals.waitForSlot(this.maxConcurrent, signal, ctx.sessionDbId);
    } catch (error: unknown) {
      const message = errorMessage(error);
      // waitForSlot rejects with a plain Error on abort; isAbortError only
      // looks at the name, so convert (plan 2.6).
      if (signal?.aborted || /waitForSlot aborted/i.test(message)) {
        throw createCodexAbortError('Codex exec aborted while waiting for an agent slot');
      }
      if (/hard cap exceeded/i.test(message)) {
        throw conditionError('hard_cap_exceeded', message);
      }
      throw new ClassifiedProviderError(neutralizeKillMarkers(`Waiting for an agent slot failed: ${redactCodexDiagnostic(message)}`), {
        kind: 'transient',
        code: 'codex_slot_wait_failed',
        cause: error instanceof Error ? error : new Error(message),
      });
    }
    if (signal?.aborted) {
      reservation.release();
      throw createCodexAbortError('Codex exec aborted after an agent slot was granted');
    }
    return reservation;
  }

  private supervise(handle: SpawnHandle, prompt: string, ctx: CodexTurnContext): Promise<TurnResult> {
    const child = handle.process;
    const signal = ctx.abortSignal;
    const startedAt = Date.now();

    logger.info('SDK', 'Codex exec started', {
      sessionId: ctx.sessionDbId,
      purpose: ctx.purpose,
      model: ctx.model,
      effort: ctx.effort,
      verbosity: ctx.verbosity,
      pid: handle.pid,
      promptChars: prompt.length,
      timeoutMs: ctx.timeoutMs,
    });

    return new Promise<TurnResult>((resolve, reject) => {
      const parser = new CodexJsonlParser();
      const stderrDecoder = new StringDecoder('utf8');
      const auditedTodos = new Set<string>();
      let stderrTail = '';
      let toolAttempt: CodexToolAttempt | null = null;
      let timedOut = false;
      let aborted = false;
      let sigintSent = false;
      let sigkillSent = false;
      let exited = false;
      let settled = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let truncationLogged = false;
      let stdoutBytes = 0;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      const sigkill = (): void => {
        sigkillSent = true;
        killCodexProcessGroup(handle.pgid, child, 'SIGKILL');
      };

      const interrupt = (): void => {
        if (!sigintSent) {
          sigintSent = true;
          killCodexProcessGroup(handle.pgid, child, 'SIGINT');
        }
        if (!killTimer) {
          killTimer = setTimeout(sigkill, this.killGraceMs);
        }
      };

      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        logger.info('SDK', 'Codex exec interrupted by session abort', { sessionId: ctx.sessionDbId, pid: handle.pid });
        interrupt();
      };

      const auditTodo = (event: Extract<CodexJsonlEvent, { kind: 'todo_list' }>): void => {
        const key = event.observation.itemId ?? `${event.observation.eventType}:${auditedTodos.size}`;
        if (auditedTodos.has(key)) return;
        auditedTodos.add(key);
        recordObserverToolAttempt({
          source: 'Observer',
          provider: 'codex',
          sessionDbId: ctx.sessionDbId,
          contentSessionId: ctx.contentSessionId,
          project: ctx.project,
          tool_name: 'todo_list',
          tool_input: event.observation.summary,
          result: 'observed',
        });
        logger.info('SDK', 'Codex emitted a todo_list item (audit only, not fatal)', {
          sessionId: ctx.sessionDbId,
          itemId: event.observation.itemId,
        });
      };

      const onToolAttempt = (attempt: CodexToolAttempt): void => {
        if (toolAttempt) return;
        toolAttempt = attempt;
        sigkill();
        const count = this.violations.record(ctx.sessionDbId);
        recordObserverToolAttempt({
          source: 'Observer',
          provider: 'codex',
          sessionDbId: ctx.sessionDbId,
          contentSessionId: ctx.contentSessionId,
          project: ctx.project,
          tool_name: attempt.toolName,
          tool_input: attempt.toolInput,
          result: 'denied',
          error_message: 'codex observer lockdown: forbidden item, process group killed',
        });
        logger.warn('SECURITY', 'Codex observer emitted a forbidden tool item; process group killed and turn discarded', {
          sessionId: ctx.sessionDbId,
          purpose: ctx.purpose,
          itemType: attempt.itemType,
          eventType: attempt.eventType,
          violationsInSession: count,
        });
      };

      const handleEvent = (event: CodexJsonlEvent): void => {
        switch (event.kind) {
          case 'tool_attempt':
            onToolAttempt(event.attempt);
            break;
          case 'todo_list':
            auditTodo(event);
            break;
          case 'error_item':
            logger.debug('SDK', 'Codex error item (info only)', { sessionId: ctx.sessionDbId });
            break;
          case 'reconnecting':
            logger.debug('SDK', 'Codex stream reconnecting (info only)', { sessionId: ctx.sessionDbId });
            break;
          case 'thread_started':
            logger.debug('SDK', 'Codex thread started', { sessionId: ctx.sessionDbId, threadId: event.threadId });
            break;
          default:
            break;
        }
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        signal?.removeEventListener('abort', onAbort);
        // We started a termination: reap anything still in the group now
        // instead of leaving it to outlive the call.
        if ((timedOut || aborted) && !sigkillSent) sigkill();

        if (!toolAttempt) {
          for (const event of parser.end()) handleEvent(event);
        }
        const summary = parser.summary();
        const result: TurnResult = {
          threadId: summary.threadId,
          text: toolAttempt ? '' : summary.content,
          usage: summary.usage,
          turnCompleted: summary.turnCompleted,
          failureMessage: summary.failureMessage,
          nonFatalErrors: summary.nonFatalErrors,
          toolAttempt,
          todoObservations: summary.todoObservations,
          exitCode,
          signal: exitSignal,
          timedOut,
          truncated: summary.truncated,
          unknownEvents: summary.unknownEvents,
          stderrTail: stripCodexStdinNotice(stderrTail + stderrDecoder.end()).trim(),
          durationMs: Date.now() - startedAt,
        };

        if (summary.unknownEvents > 0) {
          // A renamed upstream event namespace would carry tool items past the
          // guard as `unknown_event`; surface it instead of tolerating it.
          logger.warn('SECURITY', 'Codex emitted events outside the known namespaces; the tool guard could not inspect them', {
            sessionId: ctx.sessionDbId,
            purpose: ctx.purpose,
            unknownEvents: summary.unknownEvents,
          });
        }

        logger.info('SDK', 'Codex exec finished', {
          sessionId: ctx.sessionDbId,
          purpose: ctx.purpose,
          pid: handle.pid,
          exitCode,
          signal: exitSignal,
          timedOut,
          aborted,
          toolAttempt: toolAttempt ? (toolAttempt as CodexToolAttempt).itemType : null,
          durationMs: result.durationMs,
          inputTokens: summary.usage?.input,
          cachedInputTokens: summary.usage?.cached,
          outputTokens: summary.usage?.output,
          reasoningTokens: summary.usage?.reasoning,
          agentMessages: summary.agentMessages.length,
          nonFatalErrors: summary.nonFatalErrors.length,
          malformedLines: summary.malformedLines,
          unknownEvents: summary.unknownEvents,
          stdoutTruncated: summary.truncated,
        });

        if (aborted) {
          reject(createCodexAbortError('Codex exec aborted'));
          return;
        }
        resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (toolAttempt) return; // killed: the rest of the stream is discarded
        for (const event of parser.push(chunk)) {
          handleEvent(event);
          if (toolAttempt) break;
        }
        stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (!truncationLogged && parser.summary().truncated) {
          truncationLogged = true;
          // Past the cap the parser stops emitting events, so the L4 tool
          // guard is blind from here on. Kill the group now rather than let a
          // forbidden item slip through unseen; interpretCodexTurn fails the
          // turn closed on `truncated`.
          logger.warn('SECURITY', 'Codex stdout passed the JSONL cap; the tool guard is blind, killing the process group', {
            sessionId: ctx.sessionDbId,
            purpose: ctx.purpose,
            stdoutBytes,
          });
          sigkill();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      });

      // The shared registry attaches its OWN stderr listener that logs every
      // chunk at DEBUG and the raw 2 KB tail at WARN on a non-zero close
      // (process-registry.ts). For a codex child that is an unredacted second
      // sink for bytes this module promises never to log raw (absolute home
      // paths with the username, any URL codex prints), so the runner takes
      // stderr over completely and classification goes through
      // redactCodexDiagnostic instead. M2 replaces this with a label/redactor
      // seam on SpawnSdkOptions (plan 3.4); until then the registry's WARN
      // still fires for codex, just without a tail.
      child.stderr.removeAllListeners('data');
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
        stderrTail = appendCodexStderrTail(stderrTail, text);
      });

      child.on('error', (error: Error) => {
        // The registry already logs the errno; this only records it.
        logger.debug('SDK', 'Codex child emitted an error event', {
          sessionId: ctx.sessionDbId,
          error: error.message,
        });
      });

      child.on('exit', (code: number | null, exitSig: NodeJS.Signals | null) => {
        exited = true;
        exitCode = code;
        exitSignal = exitSig;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        drainTimer = setTimeout(() => {
          // Leader is gone but something still holds stdout/stderr.
          sigkill();
          child.stdout.destroy();
          child.stderr.destroy();
          finish();
        }, this.exitDrainMs);
      });

      child.on('close', (code: number | null, closeSig: NodeJS.Signals | null) => {
        if (!exited) {
          exitCode = code;
          exitSignal = closeSig;
        }
        finish();
      });

      deadlineTimer = setTimeout(() => {
        if (settled || exited) return;
        timedOut = true;
        logger.warn('SDK', 'Codex exec exceeded its deadline; interrupting the process group', {
          sessionId: ctx.sessionDbId,
          purpose: ctx.purpose,
          timeoutMs: ctx.timeoutMs,
          pid: handle.pid,
        });
        interrupt();
      }, ctx.timeoutMs);

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // stdin rule (plan 2.5): swallow EPIPE, write, then ALWAYS end.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          logger.debug('SDK', 'Codex stdin error', { sessionId: ctx.sessionDbId, code: error.code });
        }
      });
      try {
        child.stdin.write(prompt);
      } catch (error: unknown) {
        // [ANTI-PATTERN IGNORED]: a write to an already-dead child fails like EPIPE; end() below still runs.
        logger.debug('SDK', 'Codex stdin write failed', { sessionId: ctx.sessionDbId, error: errorMessage(error) });
      } finally {
        try {
          child.stdin.end();
        } catch (error: unknown) {
          // [ANTI-PATTERN IGNORED]: stdin already destroyed means the child already has EOF.
          logger.debug('SDK', 'Codex stdin end failed', { sessionId: ctx.sessionDbId, error: errorMessage(error) });
        }
      }
    });
  }
}
