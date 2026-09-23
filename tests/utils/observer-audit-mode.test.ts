/**
 * The observer audit log is owner-only (M4, plan 3.10): it records what an
 * observer tried to run — commands, file paths and tool payloads lifted from
 * the user's sessions — so it is created 0600, and a log an earlier version
 * created with the umask (typically 0644) is tightened on the first write.
 *
 * The log is shared with other test files in this process (it lives in the
 * preload's temp DATA_DIR), so whatever was there is moved aside and put back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import {
  getObserverAuditLogPath,
  recordObserverToolAttempt,
  resetObserverAuditModeCheckForTesting,
} from '../../src/utils/observer-audit.js';

const posixIt = process.platform === 'win32' ? it.skip : it;
const logPath = getObserverAuditLogPath();
const backupPath = `${logPath}.mode-test-backup`;

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
    if (existsSync(logPath)) renameSync(logPath, backupPath);
    resetObserverAuditModeCheckForTesting();
  });

  afterEach(() => {
    rmSync(logPath, { force: true });
    if (existsSync(backupPath)) renameSync(backupPath, logPath);
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
});
