/**
 * Boot-time cleanup of codex execs a dead worker left running (M4, plan 2.6).
 *
 * The rule under test is "positive match only": a registry record is signalled
 * only when its recorded command IS the resolved codex binary AND the live
 * process is that binary running our runner's `exec --json --cd=<its own
 * session jail>` argv, in the recorded process group, not as our own child.
 * Everything else is left alone.
 *
 * The unit tests inject the process table and the signal sink. The POSIX
 * tests run real, detached processes whose argv[0] carries the codex argv
 * (bash `exec -a`), register them in a TEMP registry as a dead worker would
 * have left them, and check that exactly the matching ones die.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createProcessRegistry,
  isPidAlive,
  type ManagedProcessInfo,
  type ManagedProcessRecord,
} from '../../src/supervisor/process-registry.js';
import {
  isCodexObserverExecCommand,
  parseCodexOrphanProcessTable,
  reapOrphanedCodexExecs,
  type CodexOrphanProcessRow,
} from '../../src/supervisor/codex-orphan-reaper.js';

const CODEX = '/opt/codex/bin/codex';
const JAIL_ROOT = '/data/observer-sessions';
const SELF = 4242;

function argvFor(sessionId: number, binary = CODEX, jailRoot = JAIL_ROOT): string {
  return `${binary} exec --json --skip-git-repo-check --ignore-user-config --ignore-rules --color=never `
    + `--cd=${jailRoot}/${sessionId} --sandbox=read-only --model=gpt-5.6-luna --ephemeral -c approval_policy="never" -`;
}

interface FakeWorld {
  records: ManagedProcessRecord[];
  rows: CodexOrphanProcessRow[];
  alive: Set<number>;
  runtime: Set<string>;
  signals: Array<{ pgid: number; signal: NodeJS.Signals }>;
  unregistered: string[];
  /** pids that exit when their group gets SIGINT */
  exitOnSigint: Set<number>;
  /** pids whose identity changes (PID reuse) during the grace */
  reused: Set<number>;
  /** The fake clock the fake sleep advances (no real waiting in unit tests). */
  clockMs: number;
  /** How many times the process table was read. */
  tableReads: number;
}

function world(): FakeWorld {
  return {
    records: [],
    rows: [],
    alive: new Set(),
    runtime: new Set(),
    signals: [],
    unregistered: [],
    exitOnSigint: new Set(),
    reused: new Set(),
    clockMs: 0,
    tableReads: 0,
  };
}

function leftover(w: FakeWorld, pid: number, overrides: Partial<ManagedProcessRecord> = {}, row: Partial<CodexOrphanProcessRow> | null = {}): void {
  const sessionId = overrides.sessionId ?? pid - 9000;
  const record: ManagedProcessRecord = {
    id: `sdk:${sessionId}:${pid}`,
    pid,
    type: 'sdk',
    sessionId,
    startedAt: '2026-09-23T07:00:00.000Z',
    pgid: pid,
    command: CODEX,
    ...overrides,
  };
  w.records.push(record);
  w.alive.add(pid);
  if (row !== null) {
    w.rows.push({ pid, ppid: 1, pgid: record.pgid ?? pid, command: argvFor(Number(sessionId)), ...row });
  }
}

function reap(w: FakeWorld, overrides: Partial<Parameters<typeof reapOrphanedCodexExecs>[0]> = {}) {
  return reapOrphanedCodexExecs({
    executablePath: CODEX,
    jailRoot: JAIL_ROOT,
    selfPid: SELF,
    platform: 'darwin',
    graceMs: 50,
    registry: {
      getAll: () => w.records.filter(record => !w.unregistered.includes(record.id)),
      getRuntimeProcess: (id: string) => (w.runtime.has(id) ? ({} as ChildProcess) : undefined),
      unregister: (id: string) => { w.unregistered.push(id); },
    },
    readProcesses: async (pids) => {
      w.tableReads += 1;
      return w.rows.filter(row => pids.includes(row.pid));
    },
    isAlive: (pid) => w.alive.has(pid),
    captureStartToken: (pid) => `token-${pid}`,
    isSameProcess: (pid) => !w.reused.has(pid),
    signalGroup: (pgid, signal) => {
      w.signals.push({ pgid, signal });
      if (signal === 'SIGKILL' || w.exitOnSigint.has(pgid)) w.alive.delete(pgid);
    },
    // Time passes only on the fake clock: the grace and settle loops finish
    // without waiting (or spinning) in real time.
    now: () => w.clockMs,
    sleep: async (ms) => { w.clockMs += ms; },
    ...overrides,
  });
}

describe('codex orphan cleanup — matching', () => {
  it('interrupts a positively identified leftover exec and unregisters it once it is gone', async () => {
    const w = world();
    leftover(w, 9101);
    w.exitOnSigint.add(9101);

    const result = await reap(w);

    expect(w.signals).toEqual([{ pgid: 9101, signal: 'SIGINT' }]);
    expect(result).toMatchObject({ candidates: 1, matched: 1, interrupted: 1, killed: 0, exited: 1, unregistered: 1, skippedAll: null });
    expect(w.unregistered).toEqual(['sdk:101:9101']);
  });

  it('SIGKILLs the group of one that ignores SIGINT past the grace period', async () => {
    const w = world();
    leftover(w, 9102);

    const result = await reap(w);

    expect(w.signals).toEqual([
      { pgid: 9102, signal: 'SIGINT' },
      { pgid: 9102, signal: 'SIGKILL' },
    ]);
    expect(result).toMatchObject({ interrupted: 1, killed: 1, exited: 1, unregistered: 1 });
  });

  it('waits out the grace on its own clock, not in real time', async () => {
    const w = world();
    leftover(w, 9104);
    const started = performance.now();

    const result = await reap(w, { graceMs: 5_000 });

    expect(result.killed).toBe(1);
    // The full 5 s grace plus the settle poll elapsed on the fake clock...
    expect(w.clockMs).toBeGreaterThanOrEqual(5_000);
    // ...and next to nothing in real time.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('fails closed on SIGKILL when the start token could not be captured at match time', async () => {
    const w = world();
    leftover(w, 9105);

    // The default (strict) identity check, with no token to compare against.
    const result = await reap(w, { captureStartToken: () => null, isSameProcess: undefined });

    expect(w.signals).toEqual([{ pgid: 9105, signal: 'SIGINT' }]);
    expect(result.killed).toBe(0);
    expect(w.unregistered).toEqual([]);
  });

  it('fails closed on SIGKILL when the live start token cannot be re-read (the default check is strict)', async () => {
    const w = world();
    leftover(w, 9106);
    let reads = 0;

    const result = await reap(w, {
      // Readable at match time, unreadable when the SIGKILL is re-verified.
      captureStartToken: (pid) => (reads++ === 0 ? `token-${pid}` : null),
      isSameProcess: undefined,
    });

    expect(w.signals).toEqual([{ pgid: 9106, signal: 'SIGINT' }]);
    expect(result.killed).toBe(0);
  });

  it('re-reads the process table before SIGKILL and spares anything that no longer matches', async () => {
    for (const change of [
      (row: CodexOrphanProcessRow) => { row.pgid = 4444; },
      (row: CodexOrphanProcessRow) => { row.command = `${CODEX} --help`; },
      (row: CodexOrphanProcessRow) => { row.ppid = SELF; },
    ]) {
      const w = world();
      leftover(w, 9107);
      // The live row changes during the grace (the group or argv is not ours
      // any more), while the PID stays alive.
      const result = await reap(w, {
        sleep: async (ms) => {
          w.clockMs += ms;
          change(w.rows[0]!);
        },
      });

      expect(w.tableReads).toBe(2);
      expect(w.signals).toEqual([{ pgid: 9107, signal: 'SIGINT' }]);
      expect(result.killed).toBe(0);
    }

    const gone = world();
    leftover(gone, 9108);
    const result = await reap(gone, { sleep: async (ms) => { gone.clockMs += ms; gone.rows = []; } });
    expect(gone.signals).toEqual([{ pgid: 9108, signal: 'SIGINT' }]);
    expect(result.killed).toBe(0);
  });

  it('sends no SIGKILL when the process table cannot be re-read', async () => {
    const w = world();
    leftover(w, 9109);
    let reads = 0;

    const result = await reap(w, {
      readProcesses: async (pids) => {
        reads += 1;
        if (reads > 1) throw new Error('ps timed out');
        return w.rows.filter(row => pids.includes(row.pid));
      },
    });

    expect(w.signals).toEqual([{ pgid: 9109, signal: 'SIGINT' }]);
    expect(result).toMatchObject({ matched: 1, interrupted: 1, killed: 0 });
  });

  it('never force-kills a PID that was reused during the grace period', async () => {
    const w = world();
    leftover(w, 9103);
    w.reused.add(9103);

    const result = await reap(w);

    expect(w.signals).toEqual([{ pgid: 9103, signal: 'SIGINT' }]);
    expect(result.killed).toBe(0);
    // Still alive: the record stays for the registry's own pruning.
    expect(w.unregistered).toEqual([]);
  });

  it('leaves alone everything it cannot positively match', async () => {
    const w = world();
    // Recorded with another executable (the Claude SDK, or an older codex path).
    leftover(w, 9201, { command: '/usr/local/bin/claude' });
    // Written before the command was recorded.
    leftover(w, 9202, { command: undefined });
    // Spawned by THIS worker.
    leftover(w, 9203);
    w.runtime.add('sdk:203:9203');
    // A child of this worker according to the live table.
    leftover(w, 9204, {}, { ppid: SELF });
    // The PID now runs something else entirely (reused by the user's own codex TUI).
    leftover(w, 9205, {}, { command: `${CODEX}` });
    // The user's own `codex exec` run by hand — not our jail.
    leftover(w, 9206, {}, { command: argvFor(206, CODEX, '/Users/someone/project') });
    // Our argv, but for ANOTHER session's jail than the record says.
    leftover(w, 9207, {}, { command: argvFor(999) });
    // A different binary running exec with our jail.
    leftover(w, 9208, {}, { command: argvFor(208, '/other/codex') });
    // Live process group is not the recorded one.
    leftover(w, 9209, {}, { pgid: 1 });
    // Recorded pgid that must never be signalled as a group.
    leftover(w, 9210, { pgid: 1 }, { pgid: 1 });
    // Gone from the live table.
    leftover(w, 9211, {}, null);
    // Not an sdk record at all.
    leftover(w, 9212, { type: 'chroma' });
    // Dead already.
    leftover(w, 9213);
    w.alive.delete(9213);
    // No session to derive the jail from.
    leftover(w, 9214, { sessionId: undefined });

    const result = await reap(w);

    expect(w.signals).toEqual([]);
    expect(w.unregistered).toEqual([]);
    expect(result.matched).toBe(0);
    // Not even looked at: this worker's own runtime process, a non-sdk
    // record, a dead pid and a record with no command. Not candidates: the
    // other executable and the record with no session.
    expect(result.candidates).toBe(8);
    expect(result.skipped).toEqual({
      other_command: 1,
      own_child: 1,
      argv_mismatch: 4,
      pgid_mismatch: 2,
      not_in_process_table: 1,
      no_session: 1,
    });
  });

  it('attempts nothing without a resolved binary, on Windows, or when the process table is unreadable', async () => {
    for (const executablePath of [null, 'codex', () => null, () => { throw new Error('boom'); }]) {
      const w = world();
      leftover(w, 9301);
      const result = await reap(w, { executablePath: executablePath as never });
      expect(result.skippedAll).toBe('no_binary');
      expect(w.signals).toEqual([]);
    }

    const windows = world();
    leftover(windows, 9302);
    expect((await reap(windows, { platform: 'win32' })).skippedAll).toBe('windows');
    expect(windows.signals).toEqual([]);

    const unreadable = world();
    leftover(unreadable, 9303);
    const result = await reap(unreadable, { readProcesses: async () => { throw new Error('ps failed'); } });
    expect(result.skippedAll).toBe('unreadable');
    expect(unreadable.signals).toEqual([]);
  });

  it('never resolves the codex binary for leftovers that cannot be codex execs (another observer\'s processes)', async () => {
    const w = world();
    leftover(w, 9501, { command: '/usr/local/bin/claude' });
    leftover(w, 9502, { command: '/opt/homebrew/bin/node' });
    let resolved = 0;

    const result = await reap(w, { executablePath: () => { resolved += 1; return CODEX; } });

    expect(resolved).toBe(0);
    expect(w.signals).toEqual([]);
    expect(result).toMatchObject({ candidates: 0, matched: 0, skippedAll: null, skipped: { other_command: 2 } });
  });

  it('resolves it once a leftover could be one, whatever else is left over (a Homebrew codex-<triple> name included)', async () => {
    const homebrew = '/opt/homebrew/Caskroom/codex/0.144.4/codex-aarch64-apple-darwin';
    const w = world();
    leftover(w, 9503, { command: '/usr/local/bin/claude' });
    leftover(w, 9504, { command: homebrew }, { command: argvFor(504, homebrew) });
    w.exitOnSigint.add(9504);
    let resolved = 0;

    const result = await reap(w, { executablePath: () => { resolved += 1; return homebrew; } });

    expect(resolved).toBe(1);
    expect(w.signals).toEqual([{ pgid: 9504, signal: 'SIGINT' }]);
    expect(result).toMatchObject({ candidates: 1, matched: 1, skipped: { other_command: 1 } });
  });

  it('does not even resolve the binary when there is no live leftover', async () => {
    const w = world();
    let resolved = 0;
    const result = await reap(w, { executablePath: () => { resolved += 1; return CODEX; } });
    expect(resolved).toBe(0);
    expect(result).toMatchObject({ candidates: 0, matched: 0, skippedAll: null });
  });

  it('snapshots the registry synchronously: a record registered after the call is never considered', async () => {
    const w = world();
    const pending = reap(w);
    leftover(w, 9401); // "spawned by this worker" after boot, too late to be in the snapshot
    await pending;
    expect(w.signals).toEqual([]);
  });

  it('parses the ps rows it reads', () => {
    expect(parseCodexOrphanProcessTable([
      '  9101     1  9101 /opt/codex/bin/codex exec --json --cd=/x/1 -',
      'garbage',
      '',
      '9102 1 9102 /opt/codex/bin/codex exec --json',
    ].join('\n'))).toEqual([
      { pid: 9101, ppid: 1, pgid: 9101, command: '/opt/codex/bin/codex exec --json --cd=/x/1 -' },
      { pid: 9102, ppid: 1, pgid: 9102, command: '/opt/codex/bin/codex exec --json' },
    ]);
  });

  it('matches the argv only our runner builds', () => {
    expect(isCodexObserverExecCommand(argvFor(7), CODEX, `${JAIL_ROOT}/7`)).toBe(true);
    expect(isCodexObserverExecCommand(argvFor(7), CODEX, `${JAIL_ROOT}/70`)).toBe(false);
    expect(isCodexObserverExecCommand(argvFor(70), CODEX, `${JAIL_ROOT}/7`)).toBe(false);
    expect(isCodexObserverExecCommand(`${CODEX} --json exec --cd=${JAIL_ROOT}/7 -`, CODEX, `${JAIL_ROOT}/7`)).toBe(false);
    expect(isCodexObserverExecCommand(`${CODEX}-wrapper exec --json --cd=${JAIL_ROOT}/7 -`, CODEX, `${JAIL_ROOT}/7`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real processes (POSIX)
// ---------------------------------------------------------------------------

const posixIt = process.platform === 'win32' || !existsSync('/bin/bash') ? it.skip : it;
const children: ChildProcess[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A detached process (own group) whose argv[0] is `argv0` and that sleeps. */
function startProcess(argv0: string, options: { ignoreSigint?: boolean } = {}): ChildProcess {
  const trap = options.ignoreSigint ? `trap '' INT; ` : '';
  const child = spawn('/bin/bash', ['-c', `${trap}exec -a "$0" sleep 30`, argv0], {
    detached: true,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

describe('codex orphan cleanup — real processes', () => {
  posixIt('kills exactly the leftover codex execs, escalating to SIGKILL, and leaves a look-alike running', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-orphans-')));
    tempRoots.push(root);
    const binary = join(root, 'bin', 'codex');
    const jailRoot = join(root, 'observer-sessions');
    const registry = createProcessRegistry(join(root, 'supervisor.json'));

    const polite = startProcess(argvFor(11, binary, jailRoot));
    const stubborn = startProcess(argvFor(12, binary, jailRoot), { ignoreSigint: true });
    // Same recorded command, but the live process is not our exec for session 13.
    const lookalike = startProcess(`${binary} exec --json --cd=/somewhere/else -`);
    for (const child of [polite, stubborn, lookalike]) {
      expect(await waitUntil(() => typeof child.pid === 'number' && isPidAlive(child.pid))).toBe(true);
    }
    // Let bash exec into sleep so the live argv is the overridden one.
    await Bun.sleep(200);

    const record = (sessionId: number, pid: number): ManagedProcessInfo => ({
      pid, type: 'sdk', sessionId, startedAt: new Date().toISOString(), pgid: pid, command: binary,
    });
    // As a dead predecessor left them: on disk, with no runtime handle here.
    registry.register(`sdk:11:${polite.pid}`, record(11, polite.pid!));
    registry.register(`sdk:12:${stubborn.pid}`, record(12, stubborn.pid!));
    registry.register(`sdk:13:${lookalike.pid}`, record(13, lookalike.pid!));

    const result = await reapOrphanedCodexExecs({
      executablePath: binary,
      jailRoot,
      registry,
      // These are our children in the test; a successor worker's would not be.
      selfPid: -1,
      graceMs: 500,
    });

    expect(result).toMatchObject({ candidates: 3, matched: 2, interrupted: 2, killed: 1, exited: 2, unregistered: 2 });
    expect(result.skipped).toEqual({ argv_mismatch: 1 });
    expect(await waitUntil(() => !isPidAlive(polite.pid!))).toBe(true);
    expect(await waitUntil(() => !isPidAlive(stubborn.pid!))).toBe(true);
    expect(isPidAlive(lookalike.pid!)).toBe(true);
    expect(registry.getAll().map(entry => entry.id)).toEqual([`sdk:13:${lookalike.pid}`]);
  }, 20_000);
});
