/**
 * codex-self-check (plan 2.10, 5/L3, 6).
 *
 * Parser tests use the codex-cli 0.167.0, 0.160.0 and 0.156.1 captures (features list and
 * prompt-input with the full pins, taken model-free with an empty CODEX_HOME)
 * and a catalog fixture trimmed from the bundled 0.156.1 models.json; the
 * Phase 0 (0.144.4) captures prove an old binary is refused.
 * verifyCodexLockdown is exercised with an injected probe runner and, on
 * POSIX, with the real probe runner against a fake codex in mkdtemp. No test
 * runs the real codex binary.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { getObserverAuditLogPath } from '../../../src/utils/observer-audit.js';
import {
  CODEX_ACCEPTED_EXPERIMENTAL_TOOLS,
  CODEX_PROBE_ORDER,
  CODEX_PROBE_TIMEOUTS_MS,
  CODEX_SELF_CHECK_DIRNAME,
  CODEX_SELF_CHECK_MAX_AGE_MS,
  CODEX_TESTED_VERSION_RANGE,
  createCodexProbeRunner,
  evaluateCodexFeatures,
  evaluateCodexLoginStatus,
  evaluateCodexModelCatalog,
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

const FEATURES = readFileSync(fixturePath('v0167-features-list-locked.txt'), 'utf8');
const FEATURES_0160 = readFileSync(fixturePath('v0160-features-list-locked.txt'), 'utf8');
const FEATURES_0156 = readFileSync(fixturePath('v0156-features-list-locked.txt'), 'utf8');
const PROMPT_INPUT = readFileSync(fixturePath('v0167-prompt-input-locked.json'), 'utf8');
const PROMPT_INPUT_0160 = readFileSync(fixturePath('v0160-prompt-input-locked.json'), 'utf8');
const PROMPT_INPUT_0156 = readFileSync(fixturePath('v0156-prompt-input-locked.json'), 'utf8');
const MODELS = readFileSync(fixturePath('v0156-models-catalog.json'), 'utf8');
const P0_FEATURES = readFileSync(fixturePath('p0-features-list-locked.txt'), 'utf8');
const P0_PROMPT_INPUT = readFileSync(fixturePath('p0-prompt-input-locked.json'), 'utf8');
const PROBE_KINDS = ['version', 'login_status', 'models_catalog', 'features_list', 'prompt_input'];

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
    version: ok('codex-cli 0.167.0\n'),
    login_status: ok('', 'Logged in using ChatGPT\n'),
    models_catalog: ok(MODELS),
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

/** Set the enabled column of the named feature's row. */
function setFeature(lines: string[], name: string, enabled: boolean): string[] {
  return lines.map((l) => (l.startsWith(`${name} `) ? l.replace(/(true|false)$/, String(enabled)) : l));
}

function catalogWith(entries: unknown[]): string {
  return JSON.stringify({ models: entries });
}

function promptInputWith(mutate: (items: unknown[]) => unknown[]): string {
  return JSON.stringify(mutate(JSON.parse(PROMPT_INPUT) as unknown[]));
}

// ---------------------------------------------------------------------------
// Parsers / evaluators
// ---------------------------------------------------------------------------

describe('features list', () => {
  it('parses the 0.167.0 capture and accepts it: code_mode_interrupt may stay on, the 0.167.0 defaults are off', () => {
    const rows = parseCodexFeaturesList(FEATURES);
    expect(rows).not.toBeNull();
    expect(rows!.filter((r) => r.enabled && r.stage !== 'removed').map((r) => r.name).sort()).toEqual(['code_mode_interrupt', 'enable_request_compression', 'unified_exec', 'write_stdin_approval']);
    expect(rows!.find((r) => r.name === 'daemon_auto_start')).toEqual({ name: 'daemon_auto_start', stage: 'stable', enabled: false });
    expect(rows!.find((r) => r.name === 'plugin_discovery_prefetch')).toEqual({ name: 'plugin_discovery_prefetch', stage: 'stable', enabled: false });
    expect(rows!.find((r) => r.name === 'instant_interrupt')).toEqual({ name: 'instant_interrupt', stage: 'under development', enabled: false });
    for (const name of CODEX_DISABLED_FEATURES) {
      expect(rows!.some((r) => r.name === name)).toBe(true);
    }
    expect(evaluateCodexFeatures(rows!)).toEqual({ ok: true });
  });

  it.each([
    ['0.160.0', () => FEATURES_0160, ['api_key_cyber_access_programs', 'browser_annotation_api', 'cli_daybreak', 'in_app_voice', 'incremental_tools', 'plugin_discovery_prefetch', 'prediction_preserve_parent_tools', 'ultrafast_mode']],
    ['0.156.1', () => FEATURES_0156, ['api_key_cyber_access_programs', 'browser_annotation_api', 'cli_daybreak', 'in_app_voice', 'incremental_tools', 'instant_interrupt', 'plugin_discovery_prefetch', 'prediction_preserve_parent_tools', 'ultrafast_mode']],
  ])('parses the %s capture but refuses it: the 0.167.0 --disable names are unknown there', (_version, features, unknown) => {
    const rows = parseCodexFeaturesList(features());
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(140);
    const evaluation = evaluateCodexFeatures(rows!);
    expect(evaluation.ok).toBe(false);
    if (!evaluation.ok) {
      expect([...evaluation.unknownDisabled].sort()).toEqual(unknown);
      // Nothing it does know is left on: the locked capture has no other enabled feature.
      expect(evaluation.unexpectedEnabled).toEqual([]);
    }
  });

  it('parses the dotted names of the 0.156.1 capture', () => {
    const rows = parseCodexFeaturesList(FEATURES_0156);
    expect(rows!.find((r) => r.name === 'apply_patch_streaming_events')).toEqual({ name: 'apply_patch_streaming_events', stage: 'under development', enabled: false });
    expect(rows!.find((r) => r.name === 'guardianv2.thread_context')).toEqual({ name: 'guardianv2.thread_context', stage: 'under development', enabled: false });
  });

  it('refuses the 0.144.4 capture: the 0.156 --disable names are unknown there', () => {
    const rows = parseCodexFeaturesList(P0_FEATURES)!;
    const evaluation = evaluateCodexFeatures(rows);
    expect(evaluation.ok).toBe(false);
    if (!evaluation.ok) {
      expect(evaluation.unknownDisabled).toContain('sleep_tool');
      expect(evaluation.unknownDisabled).toContain('view_image');
      // remote_compaction_v2 was still a live stage there and is no longer tolerated.
      expect(evaluation.unexpectedEnabled).toEqual(['remote_compaction_v2']);
    }
  });

  it('accepts dotted feature names but not other name shapes', () => {
    expect(parseCodexFeaturesList('guardianv2.thread_context under development false\na.b.c stable true')).toEqual([
      { name: 'guardianv2.thread_context', stage: 'under development', enabled: false },
      { name: 'a.b.c', stage: 'stable', enabled: true },
    ]);
    for (const bad of ['.leading stable false', 'trailing. stable false', 'double..dot stable false', 'Upper stable false', 'dash-name stable false']) {
      expect(parseCodexFeaturesList(bad)).toBeNull();
    }
  });

  it('fails closed on a stage outside the known set', () => {
    for (const stage of ['under development', 'experimental', 'stable', 'deprecated', 'removed']) {
      expect(parseCodexFeaturesList(`some_feature ${stage} false`)).not.toBeNull();
    }
    expect(parseCodexFeaturesList(`${FEATURES}\nbrand_new_flag beta true`)).toBeNull();
    expect(parseCodexFeaturesList('shell_tool under review false')).toBeNull();
    expect(parseCodexFeaturesList('shell_tool Stable false')).toBeNull();
  });

  it('tolerates the forced-on unified_exec only while shell_tool is listed and disabled', () => {
    expect(evaluateCodexFeatures(parseCodexFeaturesList(FEATURES)!)).toEqual({ ok: true });

    const shellOn = evaluateCodexFeatures(parseCodexFeaturesList(featuresWith((lines) => setFeature(lines, 'shell_tool', true)))!);
    expect(shellOn.ok).toBe(false);
    if (!shellOn.ok) {
      expect(shellOn.unexpectedEnabled).toEqual(['shell_tool', 'unified_exec']);
      expect(shellOn.reason).toContain('unified_exec cannot be turned off and is tolerated only while shell_tool is disabled, but shell_tool is enabled');
    }

    const shellMissing = evaluateCodexFeatures(parseCodexFeaturesList(featuresWith((lines) => lines.filter((l) => !l.startsWith('shell_tool '))))!);
    expect(shellMissing.ok).toBe(false);
    if (!shellMissing.ok) {
      expect(shellMissing.unexpectedEnabled).toEqual(['unified_exec']);
      expect(shellMissing.unknownDisabled).toEqual(['shell_tool']);
      expect(shellMissing.reason).toContain('shell_tool is not listed');
    }

    // Off is fine too (an older-style list), and other forced-looking names get no pass.
    expect(evaluateCodexFeatures(parseCodexFeaturesList(featuresWith((lines) => setFeature(lines, 'unified_exec', false)))!)).toEqual({ ok: true });
    const tty = evaluateCodexFeatures(parseCodexFeaturesList(featuresWith((lines) => setFeature(lines, 'unified_exec_tty', true)))!);
    expect(tty.ok).toBe(false);
    if (!tty.ok) expect(tty.unexpectedEnabled).toEqual(['unified_exec_tty']);
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
  it('accepts exactly [developer == constant, user == canary] (0.167.0, 0.160.0, 0.156.1 and Phase 0 captures)', () => {
    // Since 0.156.1 each item carries an id and metadata; the evaluator ignores extra fields.
    const items = JSON.parse(PROMPT_INPUT_0156) as Array<Record<string, unknown>>;
    expect(items.every((item) => typeof item.id === 'string' && 'internal_chat_message_metadata_passthrough' in item)).toBe(true);
    expect(evaluateCodexPromptInput(PROMPT_INPUT)).toEqual({ ok: true });
    expect(evaluateCodexPromptInput(PROMPT_INPUT_0160)).toEqual({ ok: true });
    expect(evaluateCodexPromptInput(PROMPT_INPUT_0156)).toEqual({ ok: true });
    expect(evaluateCodexPromptInput(P0_PROMPT_INPUT)).toEqual({ ok: true });
  });

  it('rejects the multi-agent hint messages a GPT-6 model injects without agents.enabled=false', () => {
    const role = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<multi_agent_role>...</multi_agent_role>' }] };
    const mode = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<multi_agent_mode>...</multi_agent_mode>' }] };
    const result = evaluateCodexPromptInput(promptInputWith((items) => [items[0], role, mode, items[1]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('4 items');
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
    expect(CODEX_TESTED_VERSION_RANGE).toEqual({ minInclusive: [0, 167, 0], maxExclusive: [0, 168, 0], label: '>=0.167.0 <0.168' });
    expect(parseCodexVersion('codex-cli 0.167.0\n')).toEqual({ major: 0, minor: 167, patch: 0, prerelease: null, raw: '0.167.0' });
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.167.0')!)).toBe(true);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.167.12')!)).toBe(true);
    // 0.160.x and 0.156.x were earlier tested ranges; 0.161-0.166 were never tested.
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.160.0')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.156.1')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.166.9')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.144.4')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.168.0')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 1.0.0')!)).toBe(false);
    expect(isCodexVersionTested(parseCodexVersion('codex-cli 0.167.0-alpha.2')!)).toBe(false);
    expect(parseCodexVersion('codex-cli dev build')).toBeNull();
  });
});

describe('model catalog', () => {
  it('accepts the catalog entries of the allowlisted models (bundled 0.156.1 values)', () => {
    expect(evaluateCodexModelCatalog(MODELS, 'gpt-5.6-luna')).toEqual({ ok: true });
    expect(evaluateCodexModelCatalog(MODELS, 'gpt-6-luna')).toEqual({ ok: true }); // send_user_message_async + clock
    expect(evaluateCodexModelCatalog(MODELS, 'gpt-5.5')).toEqual({ ok: true }); // tool_mode null
    expect(evaluateCodexModelCatalog(MODELS, 'test-no-tool-fields')).toEqual({ ok: true }); // both fields absent
    expect([...CODEX_ACCEPTED_EXPERIMENTAL_TOOLS]).toEqual(['send_user_message_async', 'clock']);
  });

  it('fails closed on an unaccepted experimental tool, another tool_mode or a non-list tool field', () => {
    const extra = evaluateCodexModelCatalog(MODELS, 'test-unaccepted-experimental-tool');
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.reason).toContain('"exec_command"');
      expect(extra.reason).not.toContain('"clock"');
    }
    const direct = evaluateCodexModelCatalog(MODELS, 'test-direct-tool-mode');
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toContain('tool_mode "direct"');
    expect(evaluateCodexModelCatalog(MODELS, 'test-tools-not-a-list').ok).toBe(false);
    expect(evaluateCodexModelCatalog(catalogWith([{ slug: 'm', experimental_supported_tools: [42] }]), 'm').ok).toBe(false);
    expect(evaluateCodexModelCatalog(catalogWith([{ slug: 'm', tool_mode: 7 }]), 'm').ok).toBe(false);
  });

  it('fails closed on a missing model, a bad entry among duplicates and output that is not the catalog', () => {
    const missing = evaluateCodexModelCatalog(MODELS, 'gpt-6-sol');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('gpt-6-sol is not in the Codex model catalog');
    expect(evaluateCodexModelCatalog(catalogWith([
      { slug: 'gpt-6-luna', tool_mode: 'code_mode_only', experimental_supported_tools: ['clock'] },
      { slug: 'gpt-6-luna', tool_mode: 'direct' },
    ]), 'gpt-6-luna').ok).toBe(false);
    for (const output of ['', 'not json', '[]', '{"data":[]}', '{"models":{}}', `warning: refresh failed\n${MODELS}`]) {
      expect(evaluateCodexModelCatalog(output, 'gpt-5.6-luna').ok).toBe(false);
    }
    expect(evaluateCodexModelCatalog(catalogWith(['gpt-5.6-luna', null]), 'gpt-5.6-luna').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyCodexLockdown with an injected probe runner
// ---------------------------------------------------------------------------

describe('verifyCodexLockdown (injected probe runner)', () => {
  it('passes, runs the five probes in order with builder argv in the self-check jail', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    const result = await verifyCodexLockdown(binary, { probeRunner: runner });

    expect(result.state).toBe('passed');
    expect(result.version).toBe('0.167.0');
    expect(result.authMethod).toBe('chatgpt');
    expect(result.failure).toBeNull();
    expect([...CODEX_PROBE_ORDER]).toEqual(PROBE_KINDS);
    expect(runner.calls.map((c) => c.kind)).toEqual([...CODEX_PROBE_ORDER]);
    for (const call of runner.calls) {
      expect(call.args).toEqual(buildCodexProbeArgs(call.kind, { model: 'gpt-5.6-luna' }));
      expect(call.cwd).toBe(join(OBSERVER_SESSIONS_DIR, CODEX_SELF_CHECK_DIRNAME));
      expect(call.binaryPath).toBe(realpathSync(binary));
      expect(call.timeoutMs).toBe(CODEX_PROBE_TIMEOUTS_MS[call.kind]);
      expect(call.timeoutMs).toBeGreaterThanOrEqual(5_000);
      expect(call.timeoutMs).toBeLessThanOrEqual(call.kind === 'models_catalog' ? 15_000 : 10_000);
    }
    expect(runner.calls.find((c) => c.kind === 'models_catalog')?.args).toEqual(['debug', 'models']);
    expect(isCodexLockdownPassed(binary)).toBe(true);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (ChatGPT login)');
    // The version is recorded on the resolver fingerprint.
    expect(findCodexExecutable({ explicitPath: binary }).fingerprint.version).toBe('0.167.0');
  });

  it('"pending" and "never run" are not "passed"', async () => {
    const binary = dummyBinary();
    expect(getCodexLockdownStatus(binary)).toBeNull();
    expect(isCodexLockdownPassed(binary)).toBe(false);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (not verified yet)');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = scriptedRunner({ version: async () => { await gate; return ok('codex-cli 0.167.0'); } });
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
    const runner = scriptedRunner({ version: async () => { await gate; return ok('codex-cli 0.167.0'); } });

    const a = verifyCodexLockdown(binary, { probeRunner: runner });
    const b = verifyCodexLockdown(binary, { probeRunner: runner });
    const c = verifyCodexLockdown(binary, { probeRunner: runner, force: true }); // joins the in-flight run
    expect(b).toBe(a);
    expect(c).toBe(a);
    release();
    await Promise.all([a, b, c]);
    expect(runner.calls).toHaveLength(5);

    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(5); // cached

    await verifyCodexLockdown(binary, { probeRunner: runner, force: true });
    expect(runner.calls).toHaveLength(10); // explicit re-check
  });

  it('a replaced binary (new fingerprint) is verified again', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(5);

    writeFileSync(binary, '#!/bin/sh\n# updated build\nexit 98\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(binary, future, future);
    expect(isCodexLockdownPassed(binary)).toBe(false); // old pass does not carry over
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(10);
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
    expect(runner.calls).toHaveLength(5);
    expect(isCodexLockdownPassed(binary, { envSettings })).toBe(true);

    writeFileSync(authFile, '{"OPENAI_API_KEY":"redacted-in-test"}');
    const future = new Date(Date.now() + 60_000);
    utimesSync(authFile, future, future);

    expect(isCodexLockdownPassed(binary, { envSettings })).toBe(false);
    expect(getCodexLockdownStatus(binary, { envSettings })).toBeNull();
    await verifyCodexLockdown(binary, { probeRunner: runner, envSettings });
    expect(runner.calls).toHaveLength(10);
  });

  it('a finished result expires after CODEX_SELF_CHECK_MAX_AGE_MS', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner();
    const first = await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(5);
    expect(isCodexLockdownPassed(binary)).toBe(true);

    // Age the finished result past the max age instead of waiting an hour.
    (first as { finishedAt: number | null }).finishedAt = Date.now() - CODEX_SELF_CHECK_MAX_AGE_MS - 1;
    expect(isCodexLockdownPassed(binary)).toBe(false);
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(runner.calls).toHaveLength(10);
  });

  it('stops at the first failure: untested version -> setup_required, no further probes', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner({ version: ok('codex-cli 0.144.4\n') });
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
    expect(runner.calls).toHaveLength(5);
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
        features_list: ok(featuresWith((lines) => setFeature(lines, 'shell_tool', true))),
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

  it('the model/CLI gate refuses a GPT-6 model on an older codex-cli, even with allowUntestedVersion', async () => {
    for (const [version, allowUntestedVersion] of [['0.144.4', false], ['0.144.4', true], ['0.154.9', false], ['0.154.9', true], ['0.155.0-alpha.1', false]] as const) {
      resetCodexSelfCheckCache();
      const runner = scriptedRunner({ version: ok(`codex-cli ${version}\n`) });
      const result = await verifyCodexLockdown(dummyBinary(), { probeRunner: runner, model: 'gpt-6-luna', allowUntestedVersion });
      if (version === '0.155.0-alpha.1') {
        // major.minor.patch only: a prerelease of the floor clears the model
        // gate, then fails the tested range as usual.
        expect(result.failure?.error.code).toBe('codex_version_untested');
        continue;
      }
      expect(result.state).toBe('failed');
      expect(result.failure?.step).toBe('version');
      expect(result.failure?.error.kind).toBe('setup_required');
      expect(result.failure?.error.code).toBe('codex_model_needs_newer_cli');
      expect(result.failure?.error.message).toContain('gpt-6-luna needs codex-cli 0.155.0 or newer');
      expect(result.failure?.error.message).toContain(version);
      expect(runner.calls.map((c) => c.kind)).toEqual(['version']);
    }
  });

  it('the model/CLI gate passes GPT-6 models on 0.167.0, and astra on 0.153.0 only with allowUntestedVersion', async () => {
    for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']) {
      const runner = scriptedRunner({
        models_catalog: ok(catalogWith([{ slug: model, tool_mode: 'code_mode_only', experimental_supported_tools: ['send_user_message_async', 'clock'] }])),
      });
      const result = await verifyCodexLockdown(dummyBinary(), { probeRunner: runner, model });
      expect(result.state).toBe('passed');
      expect(runner.calls.find((c) => c.kind === 'prompt_input')?.args).toEqual(buildCodexProbeArgs('prompt_input', { model }));
    }

    const astra = (allowUntestedVersion: boolean) => verifyCodexLockdown(dummyBinary(), {
      model: 'gpt-6-astra',
      allowUntestedVersion,
      probeRunner: scriptedRunner({
        version: ok('codex-cli 0.153.0\n'),
        models_catalog: ok(catalogWith([{ slug: 'gpt-6-astra', tool_mode: 'code_mode_only', experimental_supported_tools: ['clock'] }])),
      }),
    });
    const tested = await astra(false);
    expect(tested.failure?.error.code).toBe('codex_version_untested');
    const allowed = await astra(true);
    expect(allowed.state).toBe('passed');
    expect(allowed.warnings.some((w) => w.includes('0.153.0'))).toBe(true);

    // 0.153.0 is below the luna floor even with allowUntestedVersion.
    const luna = await verifyCodexLockdown(dummyBinary(), {
      model: 'gpt-6-luna',
      allowUntestedVersion: true,
      probeRunner: scriptedRunner({ version: ok('codex-cli 0.153.0\n') }),
    });
    expect(luna.failure?.error.code).toBe('codex_model_needs_newer_cli');
  });

  it('a catalog the selected model fails stops before features list', async () => {
    const binary = dummyBinary();
    const runner = scriptedRunner({
      models_catalog: ok(catalogWith([{ slug: 'gpt-5.6-luna', tool_mode: 'code_mode_only', experimental_supported_tools: ['exec_command'] }])),
    });
    const result = await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(result.state).toBe('failed');
    expect(result.authMethod).toBe('chatgpt');
    expect(result.failure?.step).toBe('models_catalog');
    expect(result.failure?.error.kind).toBe('setup_required');
    expect(result.failure?.error.code).toBe('codex_self_check_failed');
    expect(result.failure?.error.message).toContain('model catalog');
    expect(result.failure?.error.message).toContain('exec_command');
    expect(runner.calls.map((c) => c.kind)).toEqual(['version', 'login_status', 'models_catalog']);
    expect(getCodexAuthMethodDescription(binary)).toBe('Codex CLI (self-check failed: codex_self_check_failed)');

    const missing = await verifyCodexLockdown(dummyBinary(), { probeRunner: scriptedRunner(), model: 'gpt-6-sol' });
    expect(missing.failure?.step).toBe('models_catalog');
    expect(missing.failure?.error.message).toContain('gpt-6-sol is not in the Codex model catalog');

    const crashed = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ models_catalog: { exitCode: 1, signal: null, stdout: '', stderr: 'boom\n', timedOut: false } }),
    });
    expect(crashed.failure?.step).toBe('models_catalog');
    expect(crashed.failure?.error.code).toBe('codex_self_check_failed');

    const slow = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ models_catalog: { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true } }),
    });
    expect(slow.failure?.step).toBe('models_catalog');
    expect(slow.failure?.error.message).toContain('timed out');
  });

  it('a non-zero catalog exit fails on the exit status, whatever the output', async () => {
    // A valid catalog on stdout does not rescue a failed `debug models`.
    const exited = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({ models_catalog: { exitCode: 1, signal: null, stdout: MODELS, stderr: 'boom\n', timedOut: false } }),
    });
    expect(exited.state).toBe('failed');
    expect(exited.failure?.step).toBe('models_catalog');
    expect(exited.failure?.error.code).toBe('codex_self_check_failed');
    expect(exited.failure?.error.message).toContain('models_catalog probe exited with status 1');

    // An upstream failure keeps its own classification (and its action).
    const unauthorized = await verifyCodexLockdown(dummyBinary(), {
      probeRunner: scriptedRunner({
        models_catalog: { exitCode: 1, signal: null, stdout: MODELS, stderr: 'Error: unexpected status 401 Unauthorized\n', timedOut: false },
      }),
    });
    expect(unauthorized.failure?.step).toBe('models_catalog');
    expect(unauthorized.failure?.error.code).toBe('codex_auth_invalid');
  });

  it('checks a different summary model too: its codex-cli floor and its catalog entry', async () => {
    // Summary and wrap-up execs run CLAUDE_MEM_CODEX_SUMMARY_MODEL.
    const oldCli = await verifyCodexLockdown(dummyBinary(), {
      summaryModel: 'gpt-6-luna',
      allowUntestedVersion: true,
      probeRunner: scriptedRunner({ version: ok('codex-cli 0.154.9\n') }),
    });
    expect(oldCli.failure?.step).toBe('version');
    expect(oldCli.failure?.error.code).toBe('codex_model_needs_newer_cli');
    expect(oldCli.failure?.error.message).toContain('summary model gpt-6-luna needs codex-cli 0.155.0 or newer');

    const unlisted = await verifyCodexLockdown(dummyBinary(), { probeRunner: scriptedRunner(), summaryModel: 'gpt-5.3-codex' });
    expect(unlisted.state).toBe('failed');
    expect(unlisted.failure?.step).toBe('models_catalog');
    expect(unlisted.failure?.error.message).toContain('model catalog: summary model gpt-5.3-codex is not in the Codex model catalog');

    const extraTool = await verifyCodexLockdown(dummyBinary(), {
      summaryModel: 'gpt-6-luna',
      probeRunner: scriptedRunner({
        models_catalog: ok(catalogWith([
          { slug: 'gpt-5.6-luna', tool_mode: 'code_mode_only', experimental_supported_tools: [] },
          { slug: 'gpt-6-luna', tool_mode: 'code_mode_only', experimental_supported_tools: ['clock', 'exec_command'] },
        ])),
      }),
    });
    expect(extraTool.failure?.step).toBe('models_catalog');
    expect(extraTool.failure?.error.message).toContain('summary model gpt-6-luna');
    expect(extraTool.failure?.error.message).toContain('exec_command');

    // A listed summary model passes; the canary is still rendered for the observer model.
    const binary = dummyBinary();
    const runner = scriptedRunner();
    const both = await verifyCodexLockdown(binary, { probeRunner: runner, summaryModel: 'gpt-6-luna' });
    expect(both.state).toBe('passed');
    expect(runner.calls.find((c) => c.kind === 'prompt_input')?.args).toEqual(buildCodexProbeArgs('prompt_input', { model: 'gpt-5.6-luna' }));
    expect(isCodexLockdownPassed(binary, { summaryModel: 'gpt-6-luna' })).toBe(true);
    expect(isCodexLockdownPassed(binary)).toBe(false); // keyed separately

    // No summary model, an empty one and the observer model itself share one key.
    await verifyCodexLockdown(binary, { probeRunner: runner });
    expect(isCodexLockdownPassed(binary, { summaryModel: '' })).toBe(true);
    expect(isCodexLockdownPassed(binary, { summaryModel: 'gpt-5.6-luna' })).toBe(true);
  });

  it('a config.toml that sets model_catalog_json fails the catalog probe closed', async () => {
    // `debug models` loads config.toml (exec does not), and this key replaces
    // the catalog it prints, so its output would say nothing about exec's.
    const codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-home-')));
    roots.push(codexHome);
    const envSettings = { CLAUDE_MEM_CODEX_HOME: codexHome };
    const configFile = join(codexHome, 'config.toml');
    for (const text of [
      'model_catalog_json = "/tmp/catalog.json"\n',
      '[profiles.observer]\n  model_catalog_json = "/tmp/catalog.json"\n',
      'profiles.observer.model_catalog_json = "/tmp/catalog.json"\n',
      '"model_catalog_json" = "/tmp/catalog.json"\n',
    ]) {
      resetCodexSelfCheckCache();
      writeFileSync(configFile, text);
      const runner = scriptedRunner();
      const result = await verifyCodexLockdown(dummyBinary(), { probeRunner: runner, envSettings });
      expect(result.state).toBe('failed');
      expect(result.failure?.step).toBe('models_catalog');
      expect(result.failure?.error.code).toBe('codex_self_check_failed');
      expect(result.failure?.error.message).toContain('sets model_catalog_json');
      expect(runner.calls.map((c) => c.kind)).toEqual(['version', 'login_status', 'models_catalog']);
    }

    // A commented-out key, other keys, or no config.toml at all are fine.
    for (const text of ['# model_catalog_json = "/tmp/catalog.json"\nmodel = "gpt-5.6-luna"\n', null]) {
      resetCodexSelfCheckCache();
      if (text === null) rmSync(configFile, { force: true });
      else writeFileSync(configFile, text);
      const result = await verifyCodexLockdown(dummyBinary(), { probeRunner: scriptedRunner(), envSettings });
      expect(result.state).toBe('passed');
    }
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
    expect(calls).toHaveLength(5);
    expect(calls[0]).toBe('--version');
    expect(calls[1]).toBe('login status');
    expect(calls[2]).toBe('debug models');
    expect(calls[3].startsWith('features list -c ')).toBe(true);
    expect(calls[4].startsWith('debug prompt-input -c model="gpt-5.6-luna" ')).toBe(true);
    expect(calls[4].endsWith(CODEX_PROBE_CANARY)).toBe(true);
    expect((f.read('argv-debug.txt') ?? '').replace(/\n$/, '').split('\n')).toEqual(buildCodexProbeArgs('prompt_input', { model: 'gpt-5.6-luna' }));

    expect(f.read('cwd.txt')?.trim()).toBe(realpathSync(join(OBSERVER_SESSIONS_DIR, CODEX_SELF_CHECK_DIRNAME)));
    expect(f.read('models-stdin.txt')).toBe('');
    expect(f.read('prompt-input-stdin.txt')).toBe('');

    const env = Object.fromEntries((f.read('env.txt') ?? '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
    expect(env.CODEX_HOME).toBe(join(f.root, 'codex-home'));
    expect(env.TERM).toBe('dumb');
    expect(env.CODEX_EXEC_SERVER_URL).toBe('none');
    expect(env.CODEX_API_KEY).toBeUndefined();
  }, SPAWN_TEST_TIMEOUT_MS);

  posixIt('a hanging probe is killed at its deadline (process group) and fails the check', async () => {
    const f = probesFake({ hangOn: 'features' });
    const envSettings = { CLAUDE_MEM_CODEX_HOME: join(f.root, 'codex-home') };
    const started = Date.now();
    // The deadline must outlast four fake probe start-ups on a loaded machine,
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
