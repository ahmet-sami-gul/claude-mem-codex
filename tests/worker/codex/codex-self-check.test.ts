/**
 * codex-self-check (plan 2.10, 5/L3, 6).
 *
 * Parser tests use the Phase 0 captures (features list and prompt-input with
 * the full pins). verifyCodexLockdown is exercised with an injected probe
 * runner and, on POSIX, with the real probe runner against a fake codex in
 * mkdtemp. No test runs the real codex binary.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { getObserverAuditLogPath } from '../../../src/utils/observer-audit.js';
import {
  CODEX_SELF_CHECK_DIRNAME,
  CODEX_SELF_CHECK_MAX_AGE_MS,
  CODEX_TESTED_VERSION_RANGE,
  createCodexProbeRunner,
  evaluateCodexFeatures,
  evaluateCodexLoginStatus,
  evaluateCodexPromptInput,
  getCodexAuthMethodDescription,
  getCodexLockdownStatus,
  getLastCodexLockdownResult,
  isCodexLockdownPassed,
  isCodexVersionTested,
  parseCodexFeaturesList,
  parseCodexVersion,
  resetCodexSelfCheckCache,
  verifyCodexLockdown,
  type CodexProbeRequest,
  type CodexProbeResponse,
  type CodexProbeRunner,
} from '../../../src/services/worker/codex/codex-self-check.js';
import {
  buildCodexProbeArgs,
  CODEX_DISABLED_FEATURES,
  CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS,
  CODEX_PROBE_CANARY,
} from '../../../src/services/worker/codex/codex-invocation.js';
import { findCodexExecutable, resetCodexExecutableCache } from '../../../src/shared/find-codex-executable.js';
import {
  createFakeCodexProbes,
  fixturePath,
  IS_WINDOWS,
  waitFor,
  waitForPidGone,
  type FakeCodex,
} from './fake-codex.js';

const posixIt = IS_WINDOWS ? it.skip : it;
const SPAWN_TEST_TIMEOUT_MS = 20_000;

const FEATURES = readFileSync(fixturePath('p0-features-list-locked.txt'), 'utf8');
const PROMPT_INPUT = readFileSync(fixturePath('p0-prompt-input-locked.json'), 'utf8');

const roots: string[] = [];
const fakes: FakeCodex[] = [];

afterEach(() => {
  resetCodexSelfCheckCache();
  resetCodexExecutableCache();
  while (fakes.length > 0) fakes.pop()!.cleanup();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A dummy executable file in mkdtemp (never executed by the injected runner). */
function dummyBinary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-selfcheck-bin-')));
  roots.push(root);
  const file = join(root, 'codex');
  writeFileSync(file, '#!/bin/sh\nexit 99\n');
  chmodSync(file, 0o755);
  expect(realpathSync(file).startsWith(root + sep)).toBe(true);
  return file;
}

function ok(stdout = '', stderr = ''): CodexProbeResponse {
  return { exitCode: 0, signal: null, stdout, stderr, timedOut: false };
}

interface ScriptedRunner extends CodexProbeRunner {
  calls: CodexProbeRequest[];
}

function scriptedRunner(overrides: Partial<Record<CodexProbeRequest['kind'], CodexProbeResponse | (() => Promise<CodexProbeResponse>)>> = {}): ScriptedRunner {
  const calls: CodexProbeRequest[] = [];
  const defaults: Record<CodexProbeRequest['kind'], CodexProbeResponse> = {
    version: ok('codex-cli 0.144.4\n'),
    login_status: ok('', 'Logged in using ChatGPT\n'),
    features_list: ok(FEATURES),
    prompt_input: ok(PROMPT_INPUT),
  };
  const runner = (async (request: CodexProbeRequest) => {
    calls.push(request);
    const override = overrides[request.kind];
    if (typeof override === 'function') return override();
    return override ?? defaults[request.kind];
  }) as ScriptedRunner;
  runner.calls = calls;
  return runner;
}

function featuresWith(mutate: (lines: string[]) => string[]): string {
  return mutate(FEATURES.split('\n')).join('\n');
}

function promptInputWith(mutate: (items: unknown[]) => unknown[]): string {
  return JSON.stringify(mutate(JSON.parse(PROMPT_INPUT) as unknown[]));
}

// ---------------------------------------------------------------------------
// Parsers / evaluators
// ---------------------------------------------------------------------------

describe('features list', () => {
  it('parses the Phase 0 capture and accepts it', () => {
    const rows = parseCodexFeaturesList(FEATURES);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(80);
    expect(rows!.find((r) => r.name === 'apply_patch_streaming_events')).toEqual({ name: 'apply_patch_streaming_events', stage: 'under development', enabled: false });
    expect(rows!.filter((r) => r.enabled && r.stage !== 'removed').map((r) => r.name).sort()).toEqual(['enable_request_compression', 'remote_compaction_v2']);
    expect(evaluateCodexFeatures(rows!)).toEqual({ ok: true });
  });

  it('rejects an extra enabled feature (multi_agent left on)', () => {
    const rows = parseCodexFeaturesList(featuresWith((lines) => lines.map((l) => l.startsWith('multi_agent ') ? l.replace(/false$/, 'true') : l)))!;
    const evaluation = evaluateCodexFeatures(rows);
    expect(evaluation.ok).toBe(false);
    if (!evaluation.ok) expect(evaluation.unexpectedEnabled).toEqual(['multi_agent']);
  });

  it('tolerates enabled flags in the "removed" stage', () => {
    const rows = parseCodexFeaturesList(FEATURES)!;
    expect(rows.some((r) => r.stage === 'removed' && r.enabled)).toBe(true);
    expect(evaluateCodexFeatures(rows).ok).toBe(true);
  });

  it('rejects when a --disable name is unknown to this codex version', () => {
    const rows = parseCodexFeaturesList(featuresWith((lines) => lines.filter((l) => !l.startsWith('goals '))))!;
    const evaluation = evaluateCodexFeatures(rows);
    expect(evaluation.ok).toBe(false);
    if (!evaluation.ok) expect(evaluation.unknownDisabled).toEqual(['goals']);
    expect(CODEX_DISABLED_FEATURES).toContain('goals');
  });

  it('fails closed on a format change or empty output', () => {
    expect(parseCodexFeaturesList(`${FEATURES}\nsomething unexpected here`)).toBeNull();
    expect(parseCodexFeaturesList('name stage maybe')).toBeNull();
    expect(parseCodexFeaturesList('')).toBeNull();
  });
});

describe('prompt-input canary', () => {
  it('accepts exactly [developer == constant, user == canary] (Phase 0 capture)', () => {
    expect(evaluateCodexPromptInput(PROMPT_INPUT)).toEqual({ ok: true });
  });

  it('rejects an extra skills / permissions item', () => {
    const skills = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>...</skills_instructions>' }] };
    const result = evaluateCodexPromptInput(promptInputWith((items) => [items[0], skills, items[1]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('3 items');
  });

  it('rejects a changed developer text, a changed canary, a missing user item and non-JSON', () => {
    const altered = promptInputWith((items) => {
      const copy = JSON.parse(JSON.stringify(items));
      copy[0].content[0].text = CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS + ' Also use the shell.';
      return copy;
    });
    expect(evaluateCodexPromptInput(altered).ok).toBe(false);
    const canary = promptInputWith((items) => {
      const copy = JSON.parse(JSON.stringify(items));
      copy[1].content[0].text = `${CODEX_PROBE_CANARY} extra`;
      return copy;
    });
    expect(evaluateCodexPromptInput(canary).ok).toBe(false);
    expect(evaluateCodexPromptInput(promptInputWith((items) => [items[0]])).ok).toBe(false);
    expect(evaluateCodexPromptInput(promptInputWith((items) => [items[1], items[0]])).ok).toBe(false);
    expect(evaluateCodexPromptInput('warning: config\n' + PROMPT_INPUT).ok).toBe(false);
  });
});

describe('login status', () => {
  it('accepts the Phase 0 shape: exit 0, empty stdout, ChatGPT on stderr', () => {
    expect(evaluateCodexLoginStatus({ exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' })).toEqual({ ok: true, authMethod: 'chatgpt' });
  });

  it('rejects an API-key login as setup_required', () => {
    const result = evaluateCodexLoginStatus({ exitCode: 0, stdout: '', stderr: 'Logged in using an API key - sk-proj-***\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authMethod).toBe('api_key');
      expect(result.error.kind).toBe('setup_required');
      expect(result.error.code).toBe('codex_api_key_login');
    }
  });

  it('maps "Not logged in" to auth_invalid and requires the verdict on stderr', () => {
    const notLoggedIn = evaluateCodexLoginStatus({ exitCode: 1, stdout: '', stderr: 'Not logged in\n' });
    expect(notLoggedIn.ok).toBe(false);
    if (!notLoggedIn.ok) {
      expect(notLoggedIn.authMethod).toBe('not_logged_in');
      expect(notLoggedIn.error.kind).toBe('auth_invalid');
    }
    expect(evaluateCodexLoginStatus({ exitCode: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }).ok).toBe(false);
    expect(evaluateCodexLoginStatus({ exitCode: 1, stdout: '', stderr: 'Logged in using ChatGPT\n' }).ok).toBe(false);
  });
});

describe('version range', () => {
  it(`accepts ${CODEX_TESTED_VERSION_RANGE.label} only`, () => {
    expect(parseCodexVersion('codex-cli 0.144.4\n')).toEqual({ major: 0, minor: 144, patch: 4, prerelease: null, raw: '0.144.4' });
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.144.4')!)).toBe(true);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.144.12')!)).toBe(true);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.144.3')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.145.0')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 1.0.0')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.144.4-alpha.2')!)).toBe(false);
    expect(parseCodexVersion('codex-cli dev build')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyCodexLockdown with an injected probe runner
// ---------------------------------------------------------------------------

describe('verifyCodexLockdown (injected probe runner)', () => {
  it('passes, runs the four probes in order with builder argv in the self-check jail', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    const result = await verifyCodexLockdown(binary, { probeRunner: runner });

    expect(result.state).toBe('passed');
    expect(result.version).toBe('0.144.4');
    expect(result.authMethod).toBe('chatgpt');
    expect(result.failure).toBeNull();
    expect(runner.calls.map((c) => c.kind)).toEqual(['version', 'login_status', 'features_list', 'prompt_input']);
    for (const call of runner.calls) {
      expect(call.args).toEqual(buildCodexProbeArgs(call.kind, { model: 'gpt-5.6-luna' }));
      expect(call.cwd).toBe(join(OBSERVER_SESSIONS_DIR, CODEX_SELF_CHECK_DIRNAME));
      expect(call.binaryPath).toBe(realpathSync(binary));
      expect(call.timeoutMs).toBeGreaterThanOrEqual(5_000);
      expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
    }
    expect(isCodexLockdownPassed(binary)).toBe(true);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (ChatGPT login)');
    // The version is recorded on the resolver fingerprint.
    expect(findCodexExecutable({ explicitPath: binary }).fingerprint.version).toBe('0.144.4');
  });

  it('"pending" and "never run" are not "passed"', async () => {
    const binary = dummyBinary();
    expect(getCodexLockdownStatus(binary)).toBeNull();
    expect(isCodexLockdownPassed(binary)).toBe(false);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (not verified yet)');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = scriptedRunner({ version: async () => { await gate; return ok('codex-cli 0.144.4'); } });
    const pending = verifyCodexLockdown(binary, { probeRunner: runner });

    expect(getCodexLockdownStatus(binary)?.state).toBe('pending');
    expect(isCodexLockdownPassed(binary)).toBe(false);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (verifying ChatGPT login)');
    expect(getLastCodexLockdownResult()?.state).toBe('pending');

    release();
    expect((await pending).state).toBe('passed');
    expect(isCodexLockdownPassed(binary)).toBe(true);
  });

  it('single-flight: concurrent calls share one probe set; results are cached', async () => {
    const binary = dummyBinary();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = scriptedRunner({ version: async () => { await gate; return ok('codex-cli 0.144.4'); } });

    const a = verifyCodexLockdown(binary, { probeRunner: runner });
    const b = verifyCodexLockdown(binary, { probeRunner: runner });
    const c = verifyCodexLockdown(binary, { probeRunner: runner, force: true }); // joins the in-flight run
    expect(b).toBe(a);
    expect(c).toBe(a);
    release();
    await Promise.all([a, b, c]);
    expect(runner.calls).toHaveLength(4);

    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(4); // cached

    await verifyCodexLockdown(binary, { probeRunner: runner, force: true });
    expect(runner.calls).toHaveLength(8); // explicit re-check
  });

  it('a replaced binary (new fingerprint) is verified again', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(4);

    writeFileSync(binary, '#!/bin/sh\n# updated build\nexit 98\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(binary, future, future);
    expect(isCodexLockdownPassed(binary)).toBe(false); // old pass does not carry over
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(8);
    expect(isCodexLockdownPassed(binary)).toBe(true);
  });

  it('a re-login (replaced auth.json) invalidates the cached pass', async () => {
    // login_status is the only proof of a ChatGPT (plan-billed) login. Keyed
    // only on the binary + settings, a `codex login --with-api-key` would leave
    // isCodexLockdownPassed() true and billing would silently move to the API.
    const binary = dummyBinary();
    const codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-home-')));
    roots.push(codexHome);
    const authFile = join(codexHome, 'auth.json');
    writeFileSync(authFile, '{"tokens":"chatgpt"}');
    const envSettings = { CLAUDE_MEM_CODEX_HOME: codexHome };

    const runner = scriptedRunner();
    await verifyCodexLockdown(binary, { probeRunner: runner, envSettings });
    expect(runner.calls).toHaveLength(4);
    expect(isCodexLockdownPassed(binary, { envSettings })).toBe(true);

    writeFileSync(authFile, '{"OPENAI_API_KEY":"redacted-in-test"}');
    const future = new Date(Date.now() + 60_000);
    utimesSync(authFile, future, future);

    expect(isCodexLockdownPassed(binary, { envSettings })).toBe(false);
    expect(getCodexLockdownStatus(binary, { envSettings })).toBeNull();
    await verifyCodexLockdown(binary, { probeRunner: runner, envSettings });
    expect(runner.calls).toHaveLength(8);
  });

  it('a finished result expires after CODEX_SELF_CHECK_MAX_AGE_MS', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    const first = await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(4);
    expect(isCodexLockdownPassed(binary)).toBe(true);

    // Age the finished result past the max age instead of waiting an hour.
    (first as { finishedAt: number | null }).finishedAt = Date.now() - CODEX_SELF_CHECK_MAX_AGE_MS - 1;
    expect(isCodexLockdownPassed(binary)).toBe(false);
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(8);
  });

  it('stops at the first failure: untested version -> setup_required, no further probes', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner({ version: ok('codex-cli 0.146.0\n') });
    const result = await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(result.state).toBe('failed');
    expect(result.failure?.step).toBe('version');
    expect(result.failure?.error.kind).toBe('setup_required');
    expect(result.failure?.error.code).toBe('codex_version_untested');
    expect(runner.calls.map((c) => c.kind)).toEqual(['version']);
    expect(isCodexLockdownPassed(binary)).toBe(false);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (self-check failed: codex_version_untested)');
  });

  it('allowUntestedVersion lets an untested version through with a warning; the other checks still run', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner({ version: ok('codex-cli 0.150.1\n') });
    const result = await verifyCodexLockdown(binary, { probeRunner: runner, allowUntestedVersion: true });
    expect(result.state).toBe('passed');
    expect(result.warnings.some((w) => w.includes('0.150.1'))).toBe(true);
    expect(runner.calls).toHaveLength(4);
    // Cached separately from the tested-only key.
    expect(isCodexLockdownPassed(binary)).toBe(false);
    expect(isCodexLockdownPassed(binary, { allowUntestedVersion: true })).toBe(true);
  });

  it('rejects an API-key login, an extra enabled feature and a canary with extra items', async () => {
    const apiKey = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ login_status: ok('', 'Logged in using an API key - sk-***\n') }),
    });
    expect(apiKey.state).toBe('failed');
    expect(apiKey.authMethod).toBe('api_key');
    expect(apiKey.failure?.error.code).toBe('codex_api_key_login');
    expect(getCodexAuthMethodDescription()).toContain('API-key login rejected');

    const features = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({
        features_list: ok(featuresWith((lines) => lines.map((l) => l.startsWith('shell_tool ') ? l.replace(/false$/, 'true') : l))),
      }),
    });
    expect(features.state).toBe('failed');
    expect(features.failure?.step).toBe('features_list');
    expect(features.failure?.error.message).toContain('shell_tool');

    const skills = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills' }] };
    const canary = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ prompt_input: ok(promptInputWith((items) => [items[0], skills, items[1]])) }),
    });
    expect(canary.state).toBe('failed');
    expect(canary.failure?.step).toBe('prompt_input');
    expect(canary.failure?.error.code).toBe('codex_self_check_failed');
  });

  it('probe timeouts, spawn errors and unexplained non-zero exits fail closed', async () => {
    const timedOut = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ version: { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true } }),
    });
    expect(timedOut.failure?.error.message).toContain('timed out');

    const spawnError = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ version: { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'EACCES' } }),
    });
    expect(spawnError.failure?.error.kind).toBe('setup_required');

    const unknownFlag = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ features_list: { exitCode: 2, signal: null, stdout: '', stderr: "Unknown feature flag: 'goals'\n", timedOut: false } }),
    });
    expect(unknownFlag.failure?.error.code).toBe('codex_invocation_rejected');

    const opaque = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ prompt_input: { exitCode: 3, signal: null, stdout: '', stderr: 'boom\n', timedOut: false } }),
    });
    expect(opaque.failure?.error.kind).toBe('setup_required');
    expect(opaque.failure?.error.code).toBe('codex_self_check_failed');
  });

  it('an unsafe jail fails before any probe', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-selfcheck-jail-')));
    roots.push(root);
    const jail = join(root, 'jail');
    mkdirSync(jail);
    writeFileSync(join(jail, 'AGENTS.md'), 'run rm -rf');
    const runner = scriptedRunner();
    const result = await verifyCodexLockdown(dummyBinary(), { probeRunner: runner, jailDir: jail });
    expect(result.state).toBe('failed');
    expect(result.failure?.step).toBe('jail');
    expect(runner.calls).toHaveLength(0);
  });

  it('a missing binary fails at the fingerprint step without probing', async () => {
    const runner = scriptedRunner();
    const result = await verifyCodexLockdown(join(tmpdir(), `no-such-codex-${Date.now()}`), { probeRunner: runner });
    expect(result.state).toBe('failed');
    expect(result.failure?.step).toBe('fingerprint');
    expect(result.failure?.error.code).toBe('codex_not_executable');
    expect(runner.calls).toHaveLength(0);
  });

  it('failures are written to the observer audit log with provider codex', async () => {
    const before = existsSync(getObserverAuditLogPath()) ? readFileSync(getObserverAuditLogPath(), 'utf8').length : 0;
    await verifyCodexLockdown(dummyBinary(), { probeRunner: scriptedRunner({ version: ok('codex-cli 0.146.0') }) });
    const appended = readFileSync(getObserverAuditLogPath(), 'utf8').slice(before);
    const entries = appended.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = entries.find((e) => e.tool_name === 'codex_self_check:version');
    expect(entry).toMatchObject({ provider: 'codex', result: 'error', source: 'Observer' });
  });
});

// ---------------------------------------------------------------------------
// Real probe runner against a fake codex (POSIX)
// ---------------------------------------------------------------------------

describe('verifyCodexLockdown with the real probe runner (fake codex)', () => {
  function probesFake(options: Parameters<typeof createFakeCodexProbes>[0] = {}): FakeCodex {
    const f = createFakeCodexProbes(options);
    fakes.push(f);
    expect(realpathSync(f.binaryPath).startsWith(f.root + sep)).toBe(true);
    return f;
  }

  posixIt('passes end to end: jail cwd, codex env, stdin is not an open pipe', async () => {
    const f = probesFake();
    const envSettings = { CLAUDE_MEM_CODEX_HOME: join(f.root, 'codex-home') };
    const saved = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = 'test-not-a-secret';
    try {
      const result = await verifyCodexLockdown(f.binaryPath, { envSettings, probeRunner: createCodexProbeRunner(envSettings) });
      expect(result.state).toBe('passed');
    } finally {
      if (saved === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = saved;
    }

    const calls = (f.read('calls.txt') ?? '').trim().split('\n');
    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe('--version');
    expect(calls[1]).toBe('login status');
    expect(calls[2].startsWith('features list -c ')).toBe(true);
    expect(calls[3].startsWith('debug prompt-input -c model="gpt-5.6-luna" ')).toBe(true);
    expect(calls[3].endsWith(CODEX_PROBE_CANARY)).toBe(true);
    expect((f.read('argv-debug.txt') ?? '').replace(/\n$/, '').split('\n')).toEqual(buildCodexProbeArgs('prompt_input', { model: 'gpt-5.6-luna' }));

    expect(f.read('cwd.txt')?.trim()).toBe(realpathSync(join(OBSERVER_SESSIONS_DIR, CODEX_SELF_CHECK_DIRNAME)));
    expect(f.read('prompt-input-stdin.txt')).toBe('');

    const env = Object.fromEntries((f.read('env.txt') ?? '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
    expect(env.CODEX_HOME).toBe(join(f.root, 'codex-home'));
    expect(env.TERM).toBe('dumb');
    expect(env.CODEX_API_KEY).toBeUndefined();
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a hanging probe is killed at its deadline (process group) and fails the check', async () => {
    const f = probesFake({ hangOn: 'features' });
    const envSettings = { CLAUDE_MEM_CODEX_HOME: join(f.root, 'codex-home') };
    const started = Date.now();
    // The deadline must outlast three fake probe start-ups on a loaded machine,
    // so the kill always lands on a probe that really has a group to kill.
    const pending = verifyCodexLockdown(f.binaryPath, {
      envSettings,
      probeRunner: createCodexProbeRunner(envSettings),
      timeouts: { features_list: 2_000 },
    });
    expect(await waitFor(() => f.grandchildPid() !== null, 6_000)).toBe(true);

    const result = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.state).toBe('failed');
    expect(result.failure?.step).toBe('features_list');
    expect(result.failure?.error.message).toContain('timed out');
    expect(await waitForPidGone(f.grandchildPid()!)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('the real runner refuses a write subcommand before spawning', async () => {
    const f = probesFake();
    const runner = createCodexProbeRunner({ CLAUDE_MEM_CODEX_HOME: join(f.root, 'codex-home') });
    const response = await runner({ kind: 'login_status', binaryPath: f.binaryPath, args: ['login'], cwd: f.root, timeoutMs: 1_000 });
    expect(response.spawnError).toContain('login status');
    expect(f.read('calls.txt')).toBeNull();
  }, SPAWN_TEST_TIMEOUT_MS);
});
