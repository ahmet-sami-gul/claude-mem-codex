/**
 * Local 5-hour Codex exec budget (M4, plan 3.3 / 4: CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H).
 *
 * WHY. On a ChatGPT Plus plan the observer model's allowance is shared with
 * the user's own Codex work and is small (roughly 250-2,000 local messages per
 * five hours for gpt-5.6-luna), while a busy day produced ~2,500 observer
 * requests per five hours. Every `codex exec` is one plan message whatever it
 * carries. This is the hard local ceiling that keeps the observer from
 * starving the user: once CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H execs have been
 * spawned inside the sliding five-hour window, the next call is refused
 * BEFORE it waits for a pool slot or spawns anything.
 *
 * WHAT COUNTS. Every exec that was actually spawned, whatever its outcome — a
 * success, a refusal, a timeout, an abort, a guard kill all reached the plan.
 * The provider records one entry per exec from the transport's `onSpawned`
 * callback, never from the pre-flight check: the check runs twice per call
 * (before the slot wait and again just before the spawn), so counting there
 * would double-count and would count calls that never ran.
 *
 * THE REFUSAL. A quota_exhausted ClassifiedProviderError with code
 * `local_budget` and a `retryAfterMs` that is exact: the moment enough of the
 * oldest counted execs have left the window for the count to drop below the
 * limit (for a count equal to the limit: when the oldest one leaves). That
 * error takes the ordinary M3 quota path — the shared error policy pauses the
 * generator with `quota:quota_exhausted` (buffer kept), the route arms the
 * breaker with that resume time, and the resume scheduler probes once the
 * window has slid — so a budget pause is paused and resumed exactly like a
 * real usage limit, and no observation is dropped. The breaker remembers that
 * the budget armed it (code `local_budget`), so a limit the user raises or
 * turns off mid-pause lifts it at the next admission or call
 * (CodexProvider.releaseStaleLocalBudgetHold) instead of at the resume time
 * the old limit implied. The limit itself is read at every check, never frozen
 * per generator.
 *
 * WHAT IS STORED. DATA_DIR/codex-usage.json holds ONLY exec timestamps and
 * token counts — never a prompt, a reply, a session id or a project name —
 * so the budget survives a worker restart without the file ever holding
 * anything captured from a session. Writes are atomic (temp file + rename, mode
 * 0600). A missing, truncated, hand-edited or otherwise corrupt file is
 * tolerated: whatever cannot be read is dropped with one warning and the
 * budget carries on from what could be.
 *
 * 0 means unlimited: nothing is refused, but execs are still recorded, so the
 * window is already correct the moment a limit is configured.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs';
import path from 'path';
import { logger } from '../../../utils/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';
import { ClassifiedProviderError } from '../provider-errors.js';
import type { CodexUsage } from './codex-transport.js';

/** The sliding window CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H is counted over. */
export const CODEX_BUDGET_WINDOW_MS = 5 * 60 * 60 * 1000;

/** `code` of the refusal this module raises (plan 3.3). */
export const CODEX_LOCAL_BUDGET_CODE = 'local_budget';

/** File name under DATA_DIR. */
export const CODEX_USAGE_FILENAME = 'codex-usage.json';

/** On-disk format version. */
export const CODEX_USAGE_FILE_VERSION = 1;

/**
 * Upper bound on entries kept (newest first wins). Far above any real window
 * (the heaviest measured workload is ~2,500 per five hours); it only bounds a
 * crafted or runaway file.
 */
export const CODEX_USAGE_MAX_ENTRIES = 50_000;

/**
 * How far in the future a stored timestamp may be before it is treated as
 * clock skew and clamped to "now". Without the clamp a clock that jumped back
 * a day would keep every entry in the window for a day and five hours.
 */
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

/** Token counts are persisted with a trailing debounce; the exec itself is written at once. */
export const CODEX_USAGE_FLUSH_DELAY_MS = 1_000;

/** One counted exec. Only a timestamp and token counts, by design. */
interface CodexExecEntry {
  atMs: number;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
}

/** Opaque handle for the exec `recordExec` just counted; pass it back to `recordUsage`. */
export interface CodexExecTicket {
  readonly atMs: number;
}

export interface CodexBudgetSnapshot {
  /** CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H as applied; 0 = unlimited. */
  limit: number;
  windowMs: number;
  /** Execs spawned inside the window. */
  used: number;
  /** Execs left before a refusal; null when unlimited. */
  remaining: number | null;
  /** When the oldest counted exec leaves the window; null when none is counted. */
  oldestExpiresAtMs: number | null;
  /** When the next exec will be allowed, if the budget is spent now; else null. */
  resumeAtMs: number | null;
  /** Token totals of the execs inside the window (those that reported usage). */
  tokens: { input: number; cached: number; output: number; reasoning: number };
}

export interface CodexExecBudgetOptions {
  /** Defaults to DATA_DIR/codex-usage.json. */
  filePath?: string;
  now?: () => number;
  windowMs?: number;
  /** False keeps everything in memory (tests); default true. */
  persist?: boolean;
  /** Token-count flush debounce; default CODEX_USAGE_FLUSH_DELAY_MS. */
  flushDelayMs?: number;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** "5 hours" rather than "18000000 ms" in the one sentence a user reads. */
function describeWindow(windowMs: number): string {
  const hours = windowMs / (60 * 60 * 1000);
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.round(windowMs / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class CodexExecBudget {
  readonly filePath: string;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly persist: boolean;
  private readonly flushDelayMs: number;
  /** Ascending by atMs. Loaded lazily, so constructing a budget touches no disk. */
  private entries: CodexExecEntry[] | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeFailureLogged = false;

  constructor(options: CodexExecBudgetOptions = {}) {
    this.filePath = options.filePath ?? path.join(DATA_DIR, CODEX_USAGE_FILENAME);
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? CODEX_BUDGET_WINDOW_MS;
    this.persist = options.persist ?? true;
    this.flushDelayMs = options.flushDelayMs ?? CODEX_USAGE_FLUSH_DELAY_MS;
  }

  /**
   * Refuse when `limit` execs (> 0) are already counted inside the window.
   * Read-only: it never counts anything (see the header), so calling it twice
   * for one call — before the slot wait and again just before the spawn — is
   * correct.
   */
  assertWithinBudget(limit: number): void {
    if (!(Number.isFinite(limit) && limit > 0)) return;
    const now = this.now();
    const live = this.liveEntries(now);
    if (live.length < limit) return;

    const resumeAtMs = this.resumeAtFor(live, limit)!;
    const retryAfterMs = Math.max(1, resumeAtMs - now);
    throw new ClassifiedProviderError(
      `Local Codex exec budget reached: ${live.length} of ${limit} execs used in the last ${describeWindow(this.windowMs)} `
        + `(CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H). The next exec is allowed at ${new Date(resumeAtMs).toISOString()}.`,
      {
        kind: 'quota_exhausted',
        code: CODEX_LOCAL_BUDGET_CODE,
        retryAfterMs,
        cause: new Error('codex local exec budget'),
        action: 'The observer pauses until the oldest counted Codex exec leaves the 5-hour window, then resumes on its own. '
          + 'Raise CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H in settings.json to allow more.',
      },
    );
  }

  /**
   * Count one spawned exec, now. Persisted at once, so a worker restart right
   * after a burst still knows about it. Never throws: the exec is already
   * running, and a disk problem must not take the observer down (it is logged
   * once and the budget keeps counting in memory).
   */
  recordExec(): CodexExecTicket {
    const entries = this.load();
    const entry: CodexExecEntry = { atMs: this.now() };
    // Appended, so the array stays ascending unless the clock went backwards;
    // then a single insertion keeps the invariant.
    const last = entries[entries.length - 1];
    if (last && last.atMs > entry.atMs) {
      const index = entries.findIndex(existing => existing.atMs > entry.atMs);
      entries.splice(index, 0, entry);
    } else {
      entries.push(entry);
    }
    this.prune(this.now());
    this.writeNow();
    return entry;
  }

  /**
   * Attach the token counts `turn.completed` reported to the exec `ticket`
   * counted. Written on a short trailing debounce (or with the next exec,
   * whichever comes first): the counts are observability, the timestamp is
   * what the budget enforces.
   */
  recordUsage(ticket: CodexExecTicket, usage: CodexUsage | null | undefined): void {
    if (!usage) return;
    const entry = ticket as CodexExecEntry;
    const input = finiteNonNegative(usage.input);
    const cached = finiteNonNegative(usage.cached);
    const output = finiteNonNegative(usage.output);
    const reasoning = finiteNonNegative(usage.reasoning);
    if (input !== undefined) entry.input = input;
    if (cached !== undefined) entry.cached = cached;
    if (output !== undefined) entry.output = output;
    if (reasoning !== undefined) entry.reasoning = reasoning;
    // A ticket whose exec has already slid out of the window is not written
    // back: it is no longer part of the file.
    if (this.entries?.includes(entry)) this.scheduleFlush();
  }

  /** Execs counted inside the window right now. */
  usedInWindow(): number {
    return this.liveEntries(this.now()).length;
  }

  snapshot(limit: number): CodexBudgetSnapshot {
    const now = this.now();
    const live = this.liveEntries(now);
    const applied = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
    for (const entry of live) {
      tokens.input += entry.input ?? 0;
      tokens.cached += entry.cached ?? 0;
      tokens.output += entry.output ?? 0;
      tokens.reasoning += entry.reasoning ?? 0;
    }
    return {
      limit: applied,
      windowMs: this.windowMs,
      used: live.length,
      remaining: applied > 0 ? Math.max(0, applied - live.length) : null,
      oldestExpiresAtMs: live.length > 0 ? live[0].atMs + this.windowMs : null,
      resumeAtMs: applied > 0 && live.length >= applied ? this.resumeAtFor(live, applied) : null,
      tokens,
    };
  }

  /** Write any pending token counts now (shutdown, tests). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.writeNow();
    }
  }

  /** Stop the debounce timer without writing (tests). */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // -------------------------------------------------------------------------

  /**
   * The instant the count drops below `limit` again: when the exec at index
   * `live.length - limit` (0-based, ascending) leaves the window. For a count
   * equal to the limit that is the oldest exec; a count above it (the limit
   * was lowered) has to shed the surplus first.
   */
  private resumeAtFor(live: readonly CodexExecEntry[], limit: number): number | null {
    if (live.length < limit || limit <= 0) return null;
    return live[live.length - limit].atMs + this.windowMs;
  }

  /** Entries still inside the window at `now`: atMs > now - windowMs. */
  private liveEntries(now: number): CodexExecEntry[] {
    const entries = this.load();
    const cutoff = now - this.windowMs;
    let first = 0;
    while (first < entries.length && entries[first].atMs <= cutoff) first += 1;
    return first === 0 ? entries : entries.slice(first);
  }

  private prune(now: number): void {
    const entries = this.load();
    const cutoff = now - this.windowMs;
    let first = 0;
    while (first < entries.length && entries[first].atMs <= cutoff) first += 1;
    if (first > 0) entries.splice(0, first);
    if (entries.length > CODEX_USAGE_MAX_ENTRIES) entries.splice(0, entries.length - CODEX_USAGE_MAX_ENTRIES);
  }

  private load(): CodexExecEntry[] {
    if (this.entries) return this.entries;
    this.entries = this.persist ? this.readFile() : [];
    this.prune(this.now());
    return this.entries;
  }

  /** Tolerant read: anything that is not a well-formed entry is dropped. */
  private readFile(): CodexExecEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        logger.warn('SDK', 'Codex usage file could not be read; starting the exec budget empty', {
          path: this.filePath,
          code,
        });
      }
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('SDK', 'Codex usage file is not valid JSON; starting the exec budget empty', {
        path: this.filePath,
        bytes: raw.length,
      });
      return [];
    }

    const execs = (parsed as { execs?: unknown } | null)?.execs;
    if (!Array.isArray(execs)) {
      logger.warn('SDK', 'Codex usage file has no exec list; starting the exec budget empty', { path: this.filePath });
      return [];
    }

    const now = this.now();
    const entries: CodexExecEntry[] = [];
    let dropped = 0;
    let clamped = 0;
    for (const item of execs) {
      const atMs = (item as { atMs?: unknown } | null)?.atMs;
      if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) {
        dropped += 1;
        continue;
      }
      const entry: CodexExecEntry = { atMs: Math.floor(atMs) };
      if (entry.atMs > now + FUTURE_SKEW_TOLERANCE_MS) {
        entry.atMs = now;
        clamped += 1;
      }
      for (const key of ['input', 'cached', 'output', 'reasoning'] as const) {
        const value = finiteNonNegative((item as Record<string, unknown>)[key]);
        if (value !== undefined) entry[key] = value;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.atMs - b.atMs);
    if (dropped > 0 || clamped > 0) {
      logger.warn('SDK', 'Codex usage file had unusable entries; they were dropped or clamped', {
        path: this.filePath,
        dropped,
        clampedFromTheFuture: clamped,
      });
    }
    return entries;
  }

  private scheduleFlush(): void {
    if (!this.persist || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeNow();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  /** Atomic replace: write a 0600 temp file next to the target, then rename it over. */
  private writeNow(): void {
    if (!this.persist) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const payload = JSON.stringify({
      version: CODEX_USAGE_FILE_VERSION,
      windowMs: this.windowMs,
      execs: this.load().map(entry => ({
        atMs: entry.atMs,
        ...(entry.input !== undefined ? { input: entry.input } : {}),
        ...(entry.cached !== undefined ? { cached: entry.cached } : {}),
        ...(entry.output !== undefined ? { output: entry.output } : {}),
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
      })),
    }) + '\n';
    const dir = path.dirname(this.filePath);
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    let fd: number | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      fd = openSync(tmpPath, 'w', 0o600);
      const buffer = Buffer.from(payload, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        const n = writeSync(fd, buffer, written, buffer.length - written);
        if (n === 0) throw new Error(`write stalled at ${written}/${buffer.length} bytes`);
        written += n;
      }
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, this.filePath);
      this.writeFailureLogged = false;
    } catch (error: unknown) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      try { unlinkSync(tmpPath); } catch { /* the temp file may not exist */ }
      if (!this.writeFailureLogged) {
        this.writeFailureLogged = true;
        logger.warn('SDK', 'Codex usage file could not be written; the exec budget keeps counting in memory', {
          path: this.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

let defaultBudget: CodexExecBudget | null = null;

/** The process-wide budget over DATA_DIR/codex-usage.json. */
export function getCodexExecBudget(): CodexExecBudget {
  if (!defaultBudget) defaultBudget = new CodexExecBudget();
  return defaultBudget;
}
