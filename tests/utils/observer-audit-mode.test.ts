/**
 * The observer audit log is owner-only (M4, plan 3.10): it records what an
 * observer tried to run — commands, file paths and tool payloads lifted from
 * the user's sessions — so it is created 0600, and a log an earlier version
 * created with the umask (typically 0644) is tightened on the first write,
 * together with any generation (`.1`-`.3`) that version rotated out.
 *
 * The log is shared with other test files in this process (it lives in the
 * preload's temp DATA_DIR), so whatever was there is moved aside and put back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  getObserverAuditLogPath,
  hardenObserverAuditLogFiles,
  recordObserverToolAttempt,
  resetObserverAuditModeCheckForTesting,
} from '../../src/utils/observer-audit.js';

const posixIt = process.platform === 'win32' ? it.skip : it;
const logPath = getObserverAuditLogPath();
const generationPaths = [1, 2, 3].map(i => `${logPath}.${i}`);
const managedPaths = [logPath, ...generationPaths];
const backupOf = (path: string) => `${path}.mode-test-backup`;
/** The rotation threshold in observer-audit.ts. */
const ROTATE_AT_BYTES = 50 * 1024 * 1024;

function attempt(result: 'denied' | 'observed' = 'denied') {
  recordObserverToolAttempt({
    source: 'Observer',
    provider: 'codex',
    sessionDbId: 990001,
    tool_name: 'command_execution',
    tool_input: '{"command":"cat ~/.ssh/id_rsa"}',
    result,
  });
}

describe('observer audit log file mode', () => {
  beforeEach(() => {
    for (const path of managedPaths) {
      if (existsSync(path)) renameSync(path, backupOf(path));
    }
    resetObserverAuditModeCheckForTesting();
  });

  afterEach(() => {
    for (const path of managedPaths) {
      rmSync(path, { force: true });
      if (existsSync(backupOf(path))) renameSync(backupOf(path), path);
    }
    resetObserverAuditModeCheckForTesting();
  });

  posixIt('creates a new log with mode 0600', () => {
    expect(existsSync(logPath)).toBe(false);

    attempt();

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim()) as Record<string, unknown>;
    expect(entry).toMatchObject({ provider: 'codex', tool_name: 'command_execution', result: 'denied' });
  });

  posixIt('creates the next log 0600 by its creation mode alone, once the one-time tightening has already run', () => {
    // A typical umask, so a file created without an explicit mode would be 0644.
    const previousUmask = process.umask(0o022);
    try {
      attempt();
      // The log is recreated later in the same process — after a rotation, or
      // because it was deleted. The one-time check has run and does not run
      // again, so only the mode passed at creation can make this 0600.
      rmSync(logPath);

      attempt();

      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  posixIt('tightens a log an earlier version left world-readable, keeping its entries', () => {
    writeFileSync(logPath, '{"old":"entry"}\n');
    chmodSync(logPath, 0o644);

    attempt('observed');

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ old: 'entry' });
  });

  posixIt('tightens the rotated generations an earlier version left world-readable, keeping their contents', () => {
    for (const [i, path] of generationPaths.entries()) {
      writeFileSync(path, `{"generation":${i + 1}}\n`);
      chmodSync(path, 0o644);
    }

    attempt();

    for (const [i, path] of generationPaths.entries()) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generation: i + 1 });
    }
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  posixIt('tightens a world-readable legacy log that the first write rotates out to .1', () => {
    // A legacy 0644 log already at the rotation threshold is renamed to `.1`
    // before the first write, and a rename keeps its mode. Sparse, so the file
    // costs no disk space.
    writeFileSync(logPath, '');
    truncateSync(logPath, ROTATE_AT_BYTES);
    chmodSync(logPath, 0o644);

    attempt();

    expect(statSync(generationPaths[0]).size).toBe(ROTATE_AT_BYTES);
    expect(statSync(generationPaths[0]).mode & 0o777).toBe(0o600);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  posixIt('leaves generations that do not exist uncreated', () => {
    attempt();

    for (const path of generationPaths) expect(existsSync(path)).toBe(false);
  });

  posixIt('hardens old files at startup without writing an entry', () => {
    writeFileSync(logPath, '{"old":"entry"}\n');
    chmodSync(logPath, 0o644);
    writeFileSync(generationPaths[1], '{"generation":2}\n');
    chmodSync(generationPaths[1], 0o644);

    hardenObserverAuditLogFiles();

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, 'utf8')).toBe('{"old":"entry"}\n');
    expect(statSync(generationPaths[1]).mode & 0o777).toBe(0o600);
    expect(existsSync(generationPaths[0])).toBe(false);
    expect(existsSync(generationPaths[2])).toBe(false);
  });

  posixIt('startup hardening creates nothing and does not throw when no log exists', () => {
    expect(() => hardenObserverAuditLogFiles()).not.toThrow();

    for (const path of managedPaths) expect(existsSync(path)).toBe(false);
  });
});

describe('observer audit log startup hardening wiring', () => {
  it('worker start() hardens the audit log files before any observer can run', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts'), 'utf8');
    const start = source.indexOf('async start(): Promise<void> {');
    expect(start).toBeGreaterThan(-1);
    const harden = source.indexOf('hardenObserverAuditLogFiles();', start);
    const housekeeping = source.indexOf('this.startCodexHousekeeping();', start);
    const listen = source.indexOf('await this.server.listen(', start);
    expect(harden).toBeGreaterThan(start);
    expect(harden).toBeLessThan(housekeeping);
    expect(harden).toBeLessThan(listen);
  });
});
