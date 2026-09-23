/**
 * Observer / KnowledgeAgent tool-attempt audit log.
 *
 * SECURITY-SENSITIVE. The Observer and KnowledgeAgent SDK sessions are
 * configured to forbid all tool use (see src/sdk/hardened-options.ts). This
 * module records every attempted tool invocation to an append-only NDJSON log
 * so that prompt-injection attempts (the model emitting a tool_use the SDK then
 * denies) leave an authoritative, persistent trail for post-incident review.
 *
 * DEPENDENCY-FREE BY DESIGN: this util intentionally does NOT import the
 * application logger. The logger writes through its own code path; if it ever
 * routed through the audit recorder we would risk infinite recursion. Mirrors
 * the best-effort appendFileSync pattern in src/utils/logger.ts (try/catch,
 * never throw, fall back to stderr).
 */

import { appendFileSync, chmodSync, statSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../shared/paths.js';

const AUDIT_LOG_PATH = join(DATA_DIR, 'observer-audit.log');
const ROTATE_AT_BYTES = 50 * 1024 * 1024; // 50MB
const KEEP_GENERATIONS = 3;
const MAX_INPUT_BYTES = 4096;
/**
 * The log records what an observer tried to run — commands, file paths, tool
 * payloads lifted from the user's sessions — so it is owner-only, like the
 * rest of claude-mem's private state (M4, plan 3.10).
 */
const AUDIT_LOG_MODE = 0o600;

/**
 * A log created by an earlier version (0644), and any rotated generation it
 * left behind, is tightened once per process.
 */
let modeVerified = false;

export interface ObserverToolAttempt {
  source: 'Observer' | 'KnowledgeAgent';
  /**
   * Which observer backend produced the attempt. Omitted by the Claude SDK
   * path (entries stay byte-identical to before); the codex runner sets
   * 'codex' so its lockdown trail is distinguishable in the shared log.
   */
  provider?: 'claude' | 'codex';
  sessionDbId?: number;
  contentSessionId?: string;
  project?: string;
  tool_name: string;
  tool_input: unknown;
  /**
   * 'observed' is audit-only: the codex runner records `todo_list`
   * (update_plan) items this way because exec cannot remove that tool and the
   * process is deliberately NOT killed for it (plan 5, L4).
   */
  result: 'allowed' | 'denied' | 'error' | 'observed';
  error_message?: string;
}

/** Exposed for tests; never mutate at runtime. */
export function getObserverAuditLogPath(): string {
  return AUDIT_LOG_PATH;
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(AUDIT_LOG_PATH)) return;
    const { size } = statSync(AUDIT_LOG_PATH);
    if (size < ROTATE_AT_BYTES) return;
    for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
      const from = `${AUDIT_LOG_PATH}.${i}`;
      const to = `${AUDIT_LOG_PATH}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`);
  } catch {
    // best-effort rotation; never fail the recording call
  }
}

function truncateInput(input: unknown, maxBytes = MAX_INPUT_BYTES): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    if (s === undefined) return '[UNSERIALIZABLE]';
    if (s.length <= maxBytes) return s;
    return s.slice(0, maxBytes) + '…[TRUNCATED]';
  } catch {
    // [ANTI-PATTERN IGNORED]: JSON.stringify of arbitrary tool input is expected
    // to fail on circular/unserializable values; the '[UNSERIALIZABLE]' placeholder
    // below is the designed recovery, and this util is dependency-free by design
    // (see header) so it must not route through the application logger.
    return '[UNSERIALIZABLE]';
  }
}

function writeAuditEntry(attempt: ObserverToolAttempt): void {
  rotateIfNeeded();
  const entry = {
    ts: new Date().toISOString(),
    source: attempt.source,
    ...(attempt.provider ? { provider: attempt.provider } : {}),
    sessionDbId: attempt.sessionDbId ?? null,
    contentSessionId: attempt.contentSessionId ?? null,
    project: attempt.project ?? null,
    tool_name: attempt.tool_name,
    tool_input: truncateInput(attempt.tool_input),
    result: attempt.result,
    error_message: attempt.error_message ?? null,
  };
  // `mode` only applies when this call creates the file (a fresh log, or the
  // first write after a rotation); the umask can only remove bits from 0600.
  appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: AUDIT_LOG_MODE });
  tightenExistingLogMode();
}

/**
 * An audit log that already existed before this version was created with the
 * process umask (typically 0644), and so were the generations an earlier
 * version rotated out (`.1`-`.3`) — they hold the same tool payloads, and a
 * rename keeps the old mode. Bring them all down to 0600 on the first write of
 * each process; generations rotated from then on inherit 0600 from the live
 * log. Best-effort, and never on Windows, where POSIX modes do not apply.
 */
function tightenExistingLogMode(): void {
  if (modeVerified) return;
  modeVerified = true;
  if (process.platform === 'win32') return;
  tightenFileMode(AUDIT_LOG_PATH);
  for (let i = 1; i <= KEEP_GENERATIONS; i++) {
    tightenFileMode(`${AUDIT_LOG_PATH}.${i}`);
  }
}

function tightenFileMode(path: string): void {
  try {
    if (!existsSync(path)) return;
    if ((statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, AUDIT_LOG_MODE);
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: best-effort hardening of an existing log file;
    // this util is dependency-free by design (see header), and a failed chmod
    // must never fail the audit write that already succeeded, nor stop the
    // remaining generations from being tightened.
  }
}

/**
 * Run the one-time tightening now instead of at the first write. The worker
 * calls this at startup: a process can go its whole life without an audit
 * entry (on the Claude path the SDK has no tools to deny), and old files
 * would otherwise stay readable until then. Creates nothing and never throws.
 */
export function hardenObserverAuditLogFiles(): void {
  try {
    tightenExistingLogMode();
  } catch {
    // [ANTI-PATTERN IGNORED]: tightenFileMode already swallows per-file
    // errors; this guard only keeps worker startup safe from the unexpected.
  }
}

/** Test hook: re-run the one-time mode check on the next write. */
export function resetObserverAuditModeCheckForTesting(): void {
  modeVerified = false;
}

/**
 * Record a single attempted tool invocation. Best-effort: a failed write is
 * logged to stderr and swallowed so the SDK message loop is never broken by an
 * audit failure.
 */
export function recordObserverToolAttempt(attempt: ObserverToolAttempt): void {
  try {
    writeAuditEntry(attempt);
  } catch (err) {
    process.stderr.write(
      `[OBSERVER-AUDIT] failed to write: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
