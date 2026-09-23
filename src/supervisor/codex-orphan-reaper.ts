/**
 * Boot-time cleanup of Codex execs a dead worker left running (M4, plan 2.6
 * "Yetim süreçler").
 *
 * WHY. Every `codex exec` is started detached in its own process group. When
 * a worker dies without its shutdown cascade (SIGKILL from a version-mismatch
 * recycle, OOM, `kill -9`), its in-flight execs keep running: they finish
 * their turn, spend a plan message each, and the answer goes nowhere. Their
 * registry records also survive (the registry is on disk), and the successor
 * counts every live 'sdk' record against the agent pool, so the orphans hold
 * its slots until they exit on their own — up to the Codex timeout each.
 *
 * WHAT IS KILLED — ONLY what is POSITIVELY identified as one of our codex
 * execs. A registry record qualifies when ALL of these hold:
 *
 *   1. type 'sdk', and not spawned by this process (no runtime handle);
 *   2. its recorded `command` is exactly the resolved native codex binary
 *      (records written before the command was recorded never match);
 *   3. its pid is alive and the LIVE process table row for it shows that
 *      binary running `exec --json` with `--cd=` the record's own session jail
 *      (OBSERVER_SESSIONS_DIR/<sessionId>) — the argv only our runner builds;
 *   4. the live process group is the recorded one, and the process is not a
 *      child of this worker.
 *
 * Anything that cannot be read or does not match is left alone and counted
 * as skipped: a PID the OS reissued to the user's own `codex`, a record from
 * another binary, an unreadable process table. Refusing is always the safe
 * side here.
 *
 * HOW. SIGINT to the process group (exec turns it into a turn interrupt, the
 * same first step the runner uses), then SIGKILL to the group after a grace
 * period for whatever is still alive. The SIGKILL is re-verified from scratch
 * and fails CLOSED: the start token captured at match time must exist and be
 * read back unchanged, and a fresh process-table read must still show the
 * same process group running our exec argv for that session. A PID that
 * exited and was reissued during the grace, or one whose identity cannot be
 * re-read, is never force-killed. Dead records are then unregistered, which
 * frees their pool slots.
 *
 * The codex binary is resolved only when some leftover could be a codex exec
 * at all (its recorded command's file name starts with `codex`), so a worker
 * whose leftovers are other observers' processes (the Claude SDK's, say) never
 * walks PATH for a Codex install or logs about one.
 *
 * The registry snapshot is taken synchronously at call time, before anything
 * this worker spawns can be registered; the kills run in the background and
 * never gate boot. POSIX only: Windows has no process groups or `ps`.
 */

import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { sanitizeEnv } from './env-sanitizer.js';
import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';
import {
  captureProcessStartToken,
  getProcessRegistry,
  isPidAlive,
  type ManagedProcessRecord,
  type ProcessRegistry,
} from './process-registry.js';

const execFileAsync = promisify(execFile);

/** SIGINT -> SIGKILL grace; the runner's own CODEX_KILL_GRACE_MS. */
export const CODEX_ORPHAN_KILL_GRACE_MS = 5_000;

const POLL_INTERVAL_MS = 100;
const SIGKILL_SETTLE_MS = 1_000;

/** One live process-table row. */
export interface CodexOrphanProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export interface CodexOrphanReapOptions {
  /**
   * The resolved native codex binary (absolute), or a resolver for it. Only
   * consulted when a live 'sdk' record from an earlier worker exists. Null,
   * or anything relative, means nothing can be positively matched.
   */
  executablePath: string | null | (() => string | null);
  registry?: Pick<ProcessRegistry, 'getAll' | 'getRuntimeProcess' | 'unregister'>;
  /** Defaults to OBSERVER_SESSIONS_DIR. */
  jailRoot?: string;
  /** Live rows for these pids (missing pids are simply absent). */
  readProcesses?: (pids: number[]) => Promise<CodexOrphanProcessRow[]>;
  isAlive?: (pid: number) => boolean;
  captureStartToken?: (pid: number) => string | null;
  /**
   * Whether `pid` is still the process whose start token was captured. Only
   * consulted with a non-null token. The default is STRICT — the live token
   * must be readable and equal — unlike the shared isSameProcess, which treats
   * an unreadable token as "same".
   */
  isSameProcess?: (pid: number, token: string) => boolean;
  /** Signal a whole process group. */
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the grace and settle deadlines (tests pair it with a fake sleep). */
  now?: () => number;
  graceMs?: number;
  selfPid?: number;
  platform?: NodeJS.Platform;
}

export type CodexOrphanSkipReason =
  | 'other_command'
  | 'no_session'
  | 'not_in_process_table'
  | 'own_child'
  | 'pgid_mismatch'
  | 'argv_mismatch';

export interface CodexOrphanReapResult {
  /** Live 'sdk' records from an earlier worker whose recorded command is the codex binary. */
  candidates: number;
  /** Candidates positively identified in the live process table. */
  matched: number;
  interrupted: number;
  killed: number;
  /** Matched processes gone by the end. */
  exited: number;
  unregistered: number;
  skipped: Partial<Record<CodexOrphanSkipReason, number>>;
  /** Why nothing was attempted at all, if so. */
  skippedAll: 'windows' | 'no_binary' | 'unreadable' | null;
}

/**
 * Parse `ps -o pid=,ppid=,pgid=,command=` output. Exported for tests.
 */
export function parseCodexOrphanProcessTable(stdout: string): CodexOrphanProcessRow[] {
  const rows: CodexOrphanProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      pgid: Number.parseInt(match[3]!, 10),
      command: match[4]!.trim(),
    });
  }
  return rows;
}

/**
 * The live rows for `pids`, one `ps` call. `ps` exits 1 when none of them
 * exists; that is an empty answer, not an unreadable table.
 */
async function readProcessRowsPosix(pids: number[]): Promise<CodexOrphanProcessRow[]> {
  const args = ['-ww', '-o', 'pid=,ppid=,pgid=,command=', '-p', pids.join(',')];
  try {
    const result = await execFileAsync('ps', args, {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' },
    });
    return parseCodexOrphanProcessTable(result.stdout);
  } catch (error: unknown) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (failed.code === 1 && typeof failed.stdout === 'string') {
      return parseCodexOrphanProcessTable(failed.stdout);
    }
    throw error;
  }
}

/**
 * Whether a live command line is our runner's exec for this session: the
 * binary, then `exec --json` (the argv's first two tokens,
 * codex-invocation.ts buildCodexExecArgs), and the session's own jail as
 * `--cd=`. `ps` joins argv with spaces, so the checks are on that string.
 */
export function isCodexObserverExecCommand(command: string, executablePath: string, jailDir: string): boolean {
  if (!command.startsWith(`${executablePath} exec --json `)) return false;
  return command.includes(` --cd=${jailDir} `);
}

/**
 * Whether a recorded command could be a codex binary at all: its file name
 * starts with `codex` (`codex`, `codex.exe`, a Homebrew `codex-<triple>`).
 * Only a PRE-filter that decides whether the binary is worth resolving; the
 * exact `record.command === executablePath` comparison remains the match.
 */
export function mayBeCodexCommand(command: string): boolean {
  return /^codex/i.test(path.basename(command));
}

function defaultSignalGroup(pgid: number, signal: NodeJS.Signals): void {
  // -0 and -1 would signal our own group or every process we may signal.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`refusing to signal process group ${String(pgid)}`);
  }
  process.kill(-pgid, signal);
}

function bump(result: CodexOrphanReapResult, reason: CodexOrphanSkipReason): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

/**
 * Reap leftover codex execs from a dead worker. See the header for exactly
 * what qualifies. Never rejects: every failure is logged and counted.
 */
export async function reapOrphanedCodexExecs(options: CodexOrphanReapOptions): Promise<CodexOrphanReapResult> {
  const result: CodexOrphanReapResult = {
    candidates: 0, matched: 0, interrupted: 0, killed: 0, exited: 0, unregistered: 0, skipped: {}, skippedAll: null,
  };
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    result.skippedAll = 'windows';
    return result;
  }

  // --- Synchronous snapshot (before the first await) ------------------------
  // Taken now, so nothing this worker spawns later can be in it; the runtime
  // handle check below is the second guard against reaping our own.
  const registry = options.registry ?? getProcessRegistry();
  const isAlive = options.isAlive ?? isPidAlive;
  const leftovers = registry.getAll().filter(record =>
    record.type === 'sdk'
    && typeof record.command === 'string'
    && !registry.getRuntimeProcess(record.id)
    && isAlive(record.pid),
  );
  if (leftovers.length === 0) return result;

  // Resolving the binary walks PATH and the app bundles and logs what it
  // finds (or a warning when there is none), so it is only worth doing when a
  // leftover could be a codex exec. Everything else is another executable.
  const codexNamed = leftovers.filter(record => mayBeCodexCommand(record.command!));
  for (let index = codexNamed.length; index < leftovers.length; index += 1) bump(result, 'other_command');
  if (codexNamed.length === 0) return result;

  let executablePath: string | null = null;
  try {
    executablePath = typeof options.executablePath === 'function' ? options.executablePath() : options.executablePath;
  } catch (error: unknown) {
    logger.debug('PROCESS', 'Codex orphan cleanup could not resolve the codex binary', {
      error: error instanceof Error ? error.message : String(error),
    });
    executablePath = null;
  }
  if (!executablePath || !path.isAbsolute(executablePath)) {
    result.skippedAll = 'no_binary';
    logger.debug('PROCESS', 'Codex orphan cleanup skipped: no resolved codex binary to match against', {
      leftovers: leftovers.length,
    });
    return result;
  }

  const candidates: ManagedProcessRecord[] = [];
  for (const record of codexNamed) {
    if (record.command !== executablePath) {
      bump(result, 'other_command');
    } else if (record.sessionId === undefined || record.sessionId === null || String(record.sessionId) === '') {
      bump(result, 'no_session');
    } else {
      candidates.push(record);
    }
  }
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  // --- Positive identification against the live process table -------------
  const readProcesses = options.readProcesses ?? readProcessRowsPosix;
  const selfPid = options.selfPid ?? process.pid;
  const jailRoot = options.jailRoot ?? OBSERVER_SESSIONS_DIR;
  let rows: CodexOrphanProcessRow[];
  try {
    rows = await readProcesses(candidates.map(record => record.pid));
  } catch (error: unknown) {
    result.skippedAll = 'unreadable';
    logger.warn('PROCESS', 'Codex orphan cleanup skipped: the process table could not be read', {
      candidates: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  const rowByPid = new Map(rows.map(row => [row.pid, row]));

  // The positive match for one candidate against a live row; null when it
  // matches. Used for the initial match and again right before a SIGKILL.
  const mismatch = (record: ManagedProcessRecord, row: CodexOrphanProcessRow | undefined): CodexOrphanSkipReason | null => {
    const expectedPgid = typeof record.pgid === 'number' ? record.pgid : record.pid;
    if (!row) return 'not_in_process_table';
    if (row.ppid === selfPid || registry.getRuntimeProcess(record.id)) return 'own_child';
    if (row.pgid !== expectedPgid || !(expectedPgid > 1)) return 'pgid_mismatch';
    if (!isCodexObserverExecCommand(row.command, executablePath!, path.join(jailRoot, String(record.sessionId)))) {
      return 'argv_mismatch';
    }
    return null;
  };

  const matched: Array<{ record: ManagedProcessRecord; pgid: number; token: string | null }> = [];
  const captureToken = options.captureStartToken ?? captureProcessStartToken;
  for (const record of candidates) {
    const reason = mismatch(record, rowByPid.get(record.pid));
    if (reason) {
      bump(result, reason);
    } else {
      const expectedPgid = typeof record.pgid === 'number' ? record.pgid : record.pid;
      matched.push({ record, pgid: expectedPgid, token: captureToken(record.pid) });
    }
  }
  result.matched = matched.length;
  if (matched.length === 0) {
    logger.debug('PROCESS', 'No orphaned codex execs to reap', { candidates: result.candidates, skipped: result.skipped });
    return result;
  }

  // --- SIGINT, grace, SIGKILL -------------------------------------------------
  const signalGroup = options.signalGroup ?? defaultSignalGroup;
  // Strict by default: an unreadable live token is NOT the same process.
  const sameProcess = options.isSameProcess ?? ((pid: number, token: string) => captureToken(pid) === token);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? CODEX_ORPHAN_KILL_GRACE_MS;

  logger.warn('PROCESS', 'Interrupting codex execs a previous worker left running', {
    count: matched.length,
    pids: matched.map(entry => entry.record.pid),
  });

  const send = (entry: (typeof matched)[number], signal: NodeJS.Signals): boolean => {
    try {
      signalGroup(entry.pgid, signal);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ESRCH') {
        logger.warn('PROCESS', `Could not ${signal} an orphaned codex exec`, {
          pid: entry.record.pid,
          pgid: entry.pgid,
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  };

  for (const entry of matched) {
    if (send(entry, 'SIGINT')) result.interrupted += 1;
  }

  const deadline = now() + graceMs;
  while (now() < deadline && matched.some(entry => isAlive(entry.record.pid))) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
  }

  // --- SIGKILL, re-verified from scratch and failing closed --------------------
  const survivors = matched.filter(entry => isAlive(entry.record.pid));
  let liveRows: Map<number, CodexOrphanProcessRow> | null = null;
  if (survivors.length > 0) {
    try {
      liveRows = new Map((await readProcesses(survivors.map(entry => entry.record.pid))).map(row => [row.pid, row]));
    } catch (error: unknown) {
      logger.warn('PROCESS', 'Not force-killing orphaned codex execs: the process table could not be re-read', {
        pids: survivors.map(entry => entry.record.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const killed: typeof survivors = [];
  for (const entry of survivors) {
    if (liveRows === null) break;
    if (entry.token === null || !sameProcess(entry.record.pid, entry.token)) {
      logger.warn('PROCESS', 'Not force-killing: the orphaned codex exec PID could not be re-identified (reused, or its start token is unreadable)', {
        pid: entry.record.pid,
      });
      continue;
    }
    const reason = mismatch(entry.record, liveRows.get(entry.record.pid));
    if (reason) {
      logger.warn('PROCESS', 'Not force-killing: the orphaned codex exec no longer matches in the process table', {
        pid: entry.record.pid,
        reason,
      });
      continue;
    }
    if (send(entry, 'SIGKILL')) {
      result.killed += 1;
      killed.push(entry);
    }
  }
  if (killed.length > 0) {
    const settleUntil = now() + SIGKILL_SETTLE_MS;
    while (now() < settleUntil && killed.some(entry => isAlive(entry.record.pid))) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  for (const entry of matched) {
    if (isAlive(entry.record.pid)) continue;
    result.exited += 1;
    try {
      registry.unregister(entry.record.id);
      result.unregistered += 1;
    } catch (error: unknown) {
      logger.debug('PROCESS', 'Could not unregister a reaped codex exec', {
        id: entry.record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('PROCESS', 'Codex orphan cleanup finished', {
    candidates: result.candidates,
    matched: result.matched,
    interrupted: result.interrupted,
    killed: result.killed,
    exited: result.exited,
    skipped: result.skipped,
  });
  return result;
}
