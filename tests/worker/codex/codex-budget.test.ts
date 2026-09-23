/**
 * The local 5-hour Codex exec budget (M4, plan 3.3 / 4:
 * CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H).
 *
 * The clock is injected everywhere, so every window edge is exact. Files live
 * in mkdtemp; nothing here touches the real DATA_DIR/codex-usage.json.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CODEX_BUDGET_WINDOW_MS,
  CODEX_LOCAL_BUDGET_CODE,
  CODEX_USAGE_FILENAME,
  CodexExecBudget,
} from '../../../src/services/worker/codex/codex-budget.js';
import { ClassifiedProviderError, isClassified } from '../../../src/services/worker/provider-errors.js';

const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-09-23T08:00:00.000Z');
const IS_WINDOWS = process.platform === 'win32';

const roots: string[] = [];
const budgets: CodexExecBudget[] = [];

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-budget-'));
  roots.push(root);
  return join(root, CODEX_USAGE_FILENAME);
}

function clock(start = T0): { now: () => number; set: (ms: number) => void; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, set: (ms) => { current = ms; }, advance: (ms) => { current += ms; } };
}

function budget(options: ConstructorParameters<typeof CodexExecBudget>[0] = {}): CodexExecBudget {
  const created = new CodexExecBudget({ persist: false, ...options });
  budgets.push(created);
  return created;
}

function refusal(check: () => void): ClassifiedProviderError {
  try {
    check();
  } catch (error) {
    if (isClassified(error)) return error;
    throw error;
  }
  throw new Error('expected the budget to refuse');
}

afterEach(() => {
  while (budgets.length > 0) budgets.pop()!.dispose();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('CodexExecBudget — the sliding 5-hour window', () => {
  it('allows execs up to the limit and refuses the next one', () => {
    const time = clock();
    const b = budget({ now: time.now });

    for (let i = 0; i < 3; i++) {
      b.assertWithinBudget(3);
      b.recordExec();
      time.advance(HOUR);
    }

    const error = refusal(() => b.assertWithinBudget(3));
    expect(error.kind).toBe('quota_exhausted');
    expect(error.code).toBe(CODEX_LOCAL_BUDGET_CODE);
    expect(error.action).toContain('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H');
    expect(error.message).toContain('3 of 3 execs used in the last 5 hours');
  });

  it('computes retryAfterMs as the moment the oldest counted exec leaves the window', () => {
    const time = clock();
    const b = budget({ now: time.now });
    b.recordExec();                 // T0
    time.set(T0 + 1 * HOUR);
    b.recordExec();                 // T0 + 1h
    time.set(T0 + 2 * HOUR);
    b.recordExec();                 // T0 + 2h

    time.set(T0 + 3 * HOUR + 17_000);
    const error = refusal(() => b.assertWithinBudget(3));
    // The T0 exec leaves at T0 + 5h, exactly.
    expect(error.retryAfterMs).toBe(T0 + CODEX_BUDGET_WINDOW_MS - (T0 + 3 * HOUR + 17_000));
    expect(error.message).toContain(new Date(T0 + CODEX_BUDGET_WINDOW_MS).toISOString());

    // One millisecond before that instant it is still full...
    time.set(T0 + CODEX_BUDGET_WINDOW_MS - 1);
    expect(refusal(() => b.assertWithinBudget(3)).retryAfterMs).toBe(1);
    // ...and at that instant the oldest exec is out and the next one is allowed.
    time.set(T0 + CODEX_BUDGET_WINDOW_MS);
    expect(() => b.assertWithinBudget(3)).not.toThrow();
    expect(b.usedInWindow()).toBe(2);
  });

  it('when the count is above the limit (it was lowered), waits for enough execs to leave', () => {
    const time = clock();
    const b = budget({ now: time.now });
    for (let i = 0; i < 5; i++) {
      time.set(T0 + i * 10 * 60_000);
      b.recordExec();
    }
    time.set(T0 + HOUR);

    // 5 counted, limit 2: the count first drops below 2 when the 4th oldest
    // (index 3, T0 + 30 min) leaves.
    const error = refusal(() => b.assertWithinBudget(2));
    expect(error.retryAfterMs).toBe(T0 + 30 * 60_000 + CODEX_BUDGET_WINDOW_MS - (T0 + HOUR));
    expect(b.snapshot(2).resumeAtMs).toBe(T0 + 30 * 60_000 + CODEX_BUDGET_WINDOW_MS);
  });

  it('0 is unlimited: never refuses, but still counts, so a later limit starts from the truth', () => {
    const time = clock();
    const b = budget({ now: time.now });
    for (let i = 0; i < 50; i++) {
      b.assertWithinBudget(0);
      b.recordExec();
    }
    expect(b.usedInWindow()).toBe(50);
    expect(b.snapshot(0)).toMatchObject({ limit: 0, used: 50, remaining: null, resumeAtMs: null });
    expect(() => b.assertWithinBudget(50)).toThrow(ClassifiedProviderError);
  });

  it('the check is read-only: asking twice for one call counts nothing', () => {
    const b = budget({ now: clock().now });
    b.recordExec();
    b.assertWithinBudget(2);
    b.assertWithinBudget(2);
    expect(b.usedInWindow()).toBe(1);
  });

  it('reports the window in its snapshot, tokens included', () => {
    const time = clock();
    const b = budget({ now: time.now });
    const first = b.recordExec();
    b.recordUsage(first, { input: 1200, cached: 900, output: 60, reasoning: 20 });
    time.advance(HOUR);
    b.recordExec(); // a failed exec: counted, no usage

    expect(b.snapshot(10)).toEqual({
      limit: 10,
      windowMs: CODEX_BUDGET_WINDOW_MS,
      used: 2,
      remaining: 8,
      oldestExpiresAtMs: T0 + CODEX_BUDGET_WINDOW_MS,
      resumeAtMs: null,
      tokens: { input: 1200, cached: 900, output: 60, reasoning: 20 },
    });
  });
});

describe('CodexExecBudget — persistence', () => {
  it('round-trips through the file: a restarted worker keeps the window', () => {
    const file = tempFile();
    const time = clock();
    const first = budget({ filePath: file, now: time.now, persist: true });
    const ticket = first.recordExec();
    first.recordUsage(ticket, { input: 5570, cached: 4864, output: 7, reasoning: 0 });
    time.advance(HOUR);
    first.recordExec();
    first.flush();

    const second = budget({ filePath: file, now: time.now, persist: true });
    expect(second.usedInWindow()).toBe(2);
    expect(second.snapshot(2).resumeAtMs).toBe(T0 + CODEX_BUDGET_WINDOW_MS);
    expect(second.snapshot(2).tokens).toEqual({ input: 5570, cached: 4864, output: 7, reasoning: 0 });
    expect(() => second.assertWithinBudget(2)).toThrow(ClassifiedProviderError);
  });

  it('persists the exec at once — the budget must survive a crash right after a burst', () => {
    const file = tempFile();
    const b = budget({ filePath: file, now: clock().now, persist: true });
    b.recordExec();
    // No flush(): the timestamp is written synchronously by recordExec.
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { execs: unknown[] };
    expect(onDisk.execs).toHaveLength(1);
  });

  it('stores only timestamps and token counts — no prompt, session or project', () => {
    const file = tempFile();
    const b = budget({ filePath: file, now: clock().now, persist: true });
    b.recordUsage(b.recordExec(), { input: 1, cached: 2, output: 3, reasoning: 4 });
    b.flush();

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['execs', 'version', 'windowMs']);
    expect(onDisk.execs).toEqual([{ atMs: T0, input: 1, cached: 2, output: 3, reasoning: 4 }]);
  });

  it('writes atomically with mode 0600 and leaves no temp file behind', () => {
    const file = tempFile();
    const b = budget({ filePath: file, now: clock().now, persist: true });
    b.recordExec();
    b.recordExec();

    const dir = join(file, '..');
    expect(readdirSync(dir)).toEqual([CODEX_USAGE_FILENAME]);
    if (!IS_WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing file by rename: a 0644 file becomes 0600 with the new exec in it', () => {
    if (IS_WINDOWS) return;
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1, windowMs: CODEX_BUDGET_WINDOW_MS, execs: [{ atMs: T0 - HOUR }] }) + '\n');
    chmodSync(file, 0o644);
    const b = budget({ filePath: file, now: clock().now, persist: true });

    b.recordExec();

    // Writing the file in place would keep its old 0644; only the 0600 temp
    // file renamed over it gives this.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { execs: Array<{ atMs: number }> };
    expect(onDisk.execs.map(entry => entry.atMs)).toEqual([T0 - HOUR, T0]);
    expect(readdirSync(join(file, '..'))).toEqual([CODEX_USAGE_FILENAME]);
  });

  it('never leaves a half-written file: when the temp file cannot be written, the old file stays whole and counting goes on in memory', () => {
    const file = tempFile();
    const b = budget({ filePath: file, now: clock().now, persist: true });
    b.recordExec();
    const before = readFileSync(file, 'utf8');
    // The temp path is taken by a directory: the write fails before the target
    // is touched.
    mkdirSync(join(file, '..', `.${CODEX_USAGE_FILENAME}.${process.pid}.tmp`));

    expect(() => b.recordExec()).not.toThrow();

    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((JSON.parse(before) as { execs: unknown[] }).execs).toHaveLength(1);
    expect(b.usedInWindow()).toBe(2);
  });

  it('drops execs that left the window from the file on the next write', () => {
    const file = tempFile();
    const time = clock();
    const b = budget({ filePath: file, now: time.now, persist: true });
    b.recordExec();
    time.set(T0 + CODEX_BUDGET_WINDOW_MS + 1);
    b.recordExec();

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { execs: Array<{ atMs: number }> };
    expect(onDisk.execs.map(entry => entry.atMs)).toEqual([T0 + CODEX_BUDGET_WINDOW_MS + 1]);
  });

  it('writes token counts on a short debounce, or with the next exec', async () => {
    const file = tempFile();
    const time = clock();
    const b = budget({ filePath: file, now: time.now, persist: true, flushDelayMs: 20 });
    const ticket = b.recordExec();
    b.recordUsage(ticket, { input: 10, cached: 0, output: 1, reasoning: 0 });
    expect((JSON.parse(readFileSync(file, 'utf8')) as { execs: Array<Record<string, number>> }).execs[0].input).toBeUndefined();

    await Bun.sleep(60);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { execs: Array<Record<string, number>> }).execs[0].input).toBe(10);
  });
});

describe('CodexExecBudget — corruption tolerance', () => {
  function seeded(contents: string, now = T0 + HOUR): CodexExecBudget {
    const file = tempFile();
    writeFileSync(file, contents);
    return budget({ filePath: file, now: () => now, persist: true });
  }

  it('starts empty on invalid JSON, a truncated file or a wrong shape — and never throws', () => {
    for (const contents of ['{not json', '', '{"version":1,"execs":', 'null', '[]', '{"execs":{"atMs":1}}', '"x"']) {
      const b = seeded(contents);
      expect(() => b.assertWithinBudget(1)).not.toThrow();
      expect(b.usedInWindow()).toBe(0);
    }
  });

  it('keeps the readable entries and drops the rest, field by field', () => {
    const b = seeded(JSON.stringify({
      version: 1,
      execs: [
        { atMs: T0, input: 100, cached: -5, output: 'many', reasoning: 3 },
        { atMs: 'yesterday' },
        null,
        42,
        { atMs: Number.NaN },
        { atMs: -1 },
        { input: 7 },
        { atMs: T0 + 10 * 60_000 },
      ],
    }));

    expect(b.usedInWindow()).toBe(2);
    expect(b.snapshot(5).tokens).toEqual({ input: 100, cached: 0, output: 0, reasoning: 3 });
  });

  it('clamps a timestamp from the future (clock skew) instead of blocking for longer than a window', () => {
    const now = T0 + HOUR;
    const b = seeded(JSON.stringify({ version: 1, execs: [{ atMs: now + 24 * HOUR }] }), now);
    const error = refusal(() => b.assertWithinBudget(1));
    // Treated as "now": the wait is one window at most, not a day and five hours.
    expect(error.retryAfterMs).toBe(CODEX_BUDGET_WINDOW_MS);
  });

  it('rewrites a corrupt file with a valid one on the next exec', () => {
    const file = tempFile();
    writeFileSync(file, '\u0000\u0000garbage');
    const b = budget({ filePath: file, now: () => T0, persist: true });
    b.recordExec();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      windowMs: CODEX_BUDGET_WINDOW_MS,
      execs: [{ atMs: T0 }],
    });
  });

  it('an unwritable location never fails the exec: the budget keeps counting in memory', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-budget-'));
    roots.push(root);
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const b = budget({ filePath: join(blocker, CODEX_USAGE_FILENAME), now: () => T0, persist: true });

    expect(() => { b.recordExec(); b.recordExec(); }).not.toThrow();
    expect(b.usedInWindow()).toBe(2);
    expect(() => b.assertWithinBudget(2)).toThrow(ClassifiedProviderError);
    expect(existsSync(join(blocker, CODEX_USAGE_FILENAME))).toBe(false);
  });

  it('constructing a budget touches no disk until it is used', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-budget-'));
    roots.push(root);
    const dir = join(root, 'data');
    mkdirSync(dir);
    budget({ filePath: join(dir, CODEX_USAGE_FILENAME), persist: true });
    expect(readdirSync(dir)).toEqual([]);
  });
});
