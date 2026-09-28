import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * claude-mem-codex fork: telemetry must make NO network request in the default
 * configuration.
 *
 * The fork ships no PostHog project key (src/services/telemetry/common.ts) and
 * defaults consent to OFF (src/services/telemetry/consent.ts). This test proves
 * both gates end to end with the REAL posthog-node SDK: it runs
 * tests/fixtures/telemetry/network-probe.ts in a separate `bun` process (the
 * tests/preload.ts SDK mock does not apply there), with a scrubbed environment
 * and a throwaway HOME / data dir. The probe replaces the global fetch and traps
 * node:http(s) before importing the telemetry modules, drives every send path
 * (worker events, rolled-up buffer events, $exception with autocapture on, the
 * CLI direct POST and the historical backfill), shuts telemetry down so any
 * queued client would flush, and reports every request it intercepted.
 *
 * The last case is the positive control: with a key AND an explicit opt-in the
 * same probe DOES record requests, so a zero in the other cases means "nothing
 * was sent", not "the probe could not see it".
 */

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PROBE = join(REPO_ROOT, 'tests', 'fixtures', 'telemetry', 'network-probe.ts');
const TEST_KEY = 'test-telemetry-key';
// Discard port on loopback: even if interception failed, nothing leaves the machine.
const TEST_HOST = 'http://127.0.0.1:9';

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-telemetry-no-network-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

type ProbeResult = { calls: string[] };

function runProbe(caseName: string, extraEnv: Record<string, string>, telemetryJson?: object): ProbeResult {
  const home = join(sandbox, caseName, 'home');
  const dataDir = join(sandbox, caseName, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (telemetryJson) {
    writeFileSync(join(dataDir, 'telemetry.json'), JSON.stringify(telemetryJson));
  }

  // Scrubbed env: nothing from the test runner's own environment
  // (DO_NOT_TRACK, CLAUDE_MEM_TELEMETRY*, the preload's data dir) leaks in.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: join(sandbox, caseName),
    CLAUDE_MEM_DATA_DIR: dataDir,
    ...extraEnv,
  };

  const result = spawnSync(process.execPath, [PROBE], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });

  const line = (result.stdout ?? '')
    .split('\n')
    .find((l) => l.startsWith('PROBE_RESULT '));
  if (result.status !== 0 || !line) {
    throw new Error(
      `network probe failed (status ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
}

describe('telemetry network gate (claude-mem-codex fork)', () => {
  it('default configuration (no key, no opt-in): zero network requests', () => {
    const { calls } = runProbe('default', {});
    expect(calls).toEqual([]);
  });

  it('opted in (CLAUDE_MEM_TELEMETRY=1 and telemetry.json enabled) but no key: zero network requests', () => {
    const { calls } = runProbe(
      'opt-in-no-key',
      { CLAUDE_MEM_TELEMETRY: '1' },
      { enabled: true, installId: '00000000-0000-4000-8000-00000000000a', decidedAt: '2026-09-25T00:00:00.000Z' }
    );
    expect(calls).toEqual([]);
  });

  it('key set but no opt-in: zero network requests (consent defaults off)', () => {
    const { calls } = runProbe('key-no-opt-in', {
      CLAUDE_MEM_TELEMETRY_KEY: TEST_KEY,
      CLAUDE_MEM_TELEMETRY_HOST: TEST_HOST,
    });
    expect(calls).toEqual([]);
  });

  it('key set with an undecided telemetry.json (install ID only): zero network requests', () => {
    const { calls } = runProbe(
      'key-undecided',
      { CLAUDE_MEM_TELEMETRY_KEY: TEST_KEY, CLAUDE_MEM_TELEMETRY_HOST: TEST_HOST },
      { installId: '00000000-0000-4000-8000-00000000000b', decidedAt: '' }
    );
    expect(calls).toEqual([]);
  });

  it('positive control: key AND explicit opt-in do send, only to the configured host', () => {
    const { calls } = runProbe('key-and-opt-in', {
      CLAUDE_MEM_TELEMETRY: '1',
      CLAUDE_MEM_TELEMETRY_KEY: TEST_KEY,
      CLAUDE_MEM_TELEMETRY_HOST: TEST_HOST,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(url.startsWith(TEST_HOST)).toBe(true);
    }
  });
});
