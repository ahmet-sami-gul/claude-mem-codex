import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  envFilePath,
  buildIsolatedEnv,
  buildIsolatedEnvWithFreshOAuth,
} from '../src/shared/EnvManager.js';
import { sanitizeEnv } from '../src/supervisor/env-sanitizer.js';
import * as oauthToken from '../src/shared/oauth-token.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { paths, CLAUDE_CONFIG_DIR, DEFAULT_CLAUDE_CONFIG_DIR, MARKETPLACE_ROOT } from '../src/shared/paths.js';
import { buildCodexObserverEnv } from '../src/services/worker/codex/codex-env.js';
// CJS interop: the check is a .cjs module exporting findViolations.
import { createRequire } from 'module';
const requireCjs = createRequire(import.meta.url);
const { findViolations } = requireCjs('../scripts/check-spawn-env-discipline.cjs') as {
  findViolations: () => Array<{ file: string; line: number }>;
};
type CodexLintViolation = { file: string; line: number; rule: string; detail?: string };
const { findCodexViolations, findCodexSpawnSites, checkCodexSource } = requireCjs('../scripts/check-spawn-env-discipline.cjs') as {
  findCodexViolations: () => CodexLintViolation[];
  findCodexSpawnSites: () => Array<{ file: string; line: number; ok: boolean }>;
  checkCodexSource: (relPath: string, source: string) => CodexLintViolation[];
};

/**
 * Tests for issue #2375: ANTHROPIC_BASE_URL must not leak from the parent
 * shell into the spawned worker's isolatedEnv, AND the OAuth-skip predicate
 * must not inject the user's Anthropic OAuth token onto a custom gateway URL
 * (which would be a token leak to a third party).
 *
 * Redirect EnvManager to a per-suite temp file via CLAUDE_MEM_ENV_FILE so
 * the user's real ~/.claude-mem/.env is never read or mutated even if a test
 * fails mid-flight. envFilePath() resolves the override on every call, so
 * this works regardless of the order other tests imported the module.
 */

const TEST_DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'claude-mem-env-isolation-'));
const TEST_ENV_FILE = join(TEST_DATA_DIR, '.env');
const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;

const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ORIGINAL_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function clearEnvFile(): void {
  if (fs.existsSync(TEST_ENV_FILE)) {
    fs.unlinkSync(TEST_ENV_FILE);
  }
}

function clearAnthropicEnv(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

function restoreOriginalEnv(): void {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL;
  }
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  }
  if (ORIGINAL_AUTH_TOKEN === undefined) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  }
  if (ORIGINAL_OAUTH_TOKEN === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_OAUTH_TOKEN;
  }
}

describe('Issue #2375: ANTHROPIC_BASE_URL env-var isolation', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
    process.env.CLAUDE_MEM_ENV_FILE = TEST_ENV_FILE;
    expect(envFilePath()).toBe(TEST_ENV_FILE);
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    if (ORIGINAL_ENV_FILE === undefined) {
      delete process.env.CLAUDE_MEM_ENV_FILE;
    } else {
      process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
    }
  });

  beforeEach(() => {
    clearEnvFile();
    clearAnthropicEnv();
  });

  afterEach(() => {
    clearEnvFile();
    restoreOriginalEnv();
  });

  it('leaked ANTHROPIC_BASE_URL is stripped from isolatedEnv', () => {
    // No .env file exists. The parent shell sets a stray ANTHROPIC_BASE_URL —
    // this MUST NOT propagate into the subprocess isolatedEnv, because doing
    // so used to trigger the OAuth-skip path and leave the worker with no
    // credentials at all.
    process.env.ANTHROPIC_BASE_URL = 'https://shouldnotleak.example';

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('~/.claude-mem/.env BASE_URL + AUTH_TOKEN reaches isolatedEnv', () => {
    // User intentionally configured a gateway with a gateway-appropriate
    // auth token. Both must be re-injected into isolatedEnv.
    fs.writeFileSync(
      TEST_ENV_FILE,
      'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('test-token');
  });

  it('leaked process.env BASE_URL never reaches the OAuth-skip predicate', async () => {
    // The root cause of #2375: a BASE_URL exported by the parent shell used to
    // survive into isolatedEnv and trigger the OAuth-skip path, leaving the
    // subprocess with no credentials at all. With BASE_URL in BLOCKED_ENV_VARS,
    // the leak is stripped before the predicate runs, so OAuth lookup still
    // fires (the real credential path) rather than being short-circuited.
    process.env.ANTHROPIC_BASE_URL = 'https://leaked-from-shell.example';

    const oauthSpy = spyOn(oauthToken, 'readClaudeOAuthToken');
    try {
      const result = await buildIsolatedEnvWithFreshOAuth();
      // The leaked BASE_URL must not be present (it was never re-injected from
      // .env, which does not exist in this test).
      expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      oauthSpy.mockRestore();
    }
  });

  it('bare .env BASE_URL alone does not trigger OAuth fetch', async () => {
    // A user with a tokenless gateway (e.g. mTLS at the network boundary)
    // configures BASE_URL only. The three-branch predicate must hit the
    // BASE_URL-set branch BEFORE OAuth lookup, so CLAUDE_CODE_OAUTH_TOKEN
    // must NOT appear in the result. This is the security-regression guard
    // against a token leak to a third-party gateway.
    //
    // Note: EnvManager captures readClaudeOAuthToken via a named import at
    // module load, so spyOn on the namespace export only weakly observes
    // the call (the binding inside EnvManager is independent). The
    // behavioral assertions (BASE_URL re-injected AND OAuth token NOT
    // injected) are the load-bearing checks: in the no-OAuth-injection
    // outcome, the only execution path that produces this combination is
    // the new BASE_URL-first branch returning early.
    fs.writeFileSync(
      TEST_ENV_FILE,
      'ANTHROPIC_BASE_URL=https://gateway.example\n',
      { mode: 0o600 },
    );

    const oauthSpy = spyOn(oauthToken, 'readClaudeOAuthToken');

    try {
      const result = await buildIsolatedEnvWithFreshOAuth();

      expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // Best-effort sanity check; see note above.
      expect(oauthSpy).not.toHaveBeenCalled();
    } finally {
      oauthSpy.mockRestore();
    }
  });
});

/**
 * Issue #2357 (defense-in-depth): CLAUDE_CODE_EFFORT_LEVEL /
 * CLAUDE_CODE_ALWAYS_ENABLE_EFFORT must never reach the SDK subprocess. The
 * SDK forwards CLAUDE_CODE_EFFORT_LEVEL as the `effort` Messages API parameter;
 * models that don't support it reject with a permanent HTTP 400. Two layers
 * strip it: BLOCKED_ENV_VARS (buildIsolatedEnv) and the CLAUDE_CODE_* prefix
 * filter (sanitizeEnv). These tests prove BOTH layers independently.
 */
describe('Issue #2357: CLAUDE_CODE_EFFORT_* env-var isolation', () => {
  const ORIGINAL_EFFORT = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const ORIGINAL_ALWAYS = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;

  afterEach(() => {
    if (ORIGINAL_EFFORT === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = ORIGINAL_EFFORT;
    if (ORIGINAL_ALWAYS === undefined) delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;
    else process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = ORIGINAL_ALWAYS;
  });

  it('buildIsolatedEnv strips CLAUDE_CODE_EFFORT_LEVEL via BLOCKED_ENV_VARS (layer 1)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX';
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = 'true';

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(result.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined();
  });

  it('sanitizeEnv(buildIsolatedEnv()) strips CLAUDE_CODE_EFFORT_LEVEL (both layers)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX';

    const result = sanitizeEnv(buildIsolatedEnv());

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('sanitizeEnv alone strips CLAUDE_CODE_EFFORT_LEVEL via the CLAUDE_CODE_* prefix (layer 2)', () => {
    const result = sanitizeEnv({ CLAUDE_CODE_EFFORT_LEVEL: 'MAX', PATH: '/usr/bin' });

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    // Unrelated vars survive.
    expect(result.PATH).toBe('/usr/bin');
  });
});

/**
 * Spawn-env discipline (plan 06 Phase 7): every env-bearing subprocess spawn in
 * src/ must sanitize process.env before handing it to the child. This test runs
 * the CI grep check inside the suite so a regression fails `bun test`, not just
 * a separate lint step.
 */
describe('spawn-env discipline (CI guard)', () => {
  it('no spawn site hands raw process.env to a child without sanitizeEnv', () => {
    const violations = findViolations();
    expect(violations).toEqual([]);
  });
});

/**
 * Codex observer rules (plan 3.10): every spawn in src/services/worker/codex/
 * (spawnSdkProcess and execFile included, env or not) must build its env with
 * buildCodexObserverEnv(sanitizeEnv(...)), and the dangerous Codex flags may
 * only be spelled in codex-invocation.ts (where they are listed as forbidden).
 */
describe('codex spawn-env and forbidden-argument rules (plan 3.10)', () => {
  const CODEX_FILE = 'src/services/worker/codex/some-module.ts';

  it('finds the real codex spawn sites (runner + self-check) and all of them use buildCodexObserverEnv', () => {
    const sites = findCodexSpawnSites();
    const files = new Set(sites.map((s) => s.file));
    expect(files.has('src/services/worker/codex/codex-exec-runner.ts')).toBe(true);
    expect(files.has('src/services/worker/codex/codex-self-check.ts')).toBe(true);
    expect(sites.every((s) => s.ok)).toBe(true);
  });

  it('src/ and scripts/ have no codex violations', () => {
    expect(findCodexViolations()).toEqual([]);
  });

  it('flags a codex-dir spawnSdkProcess that only sanitizes the env', () => {
    const source = [
      'const handle = _internals.spawnSdkProcess(id, {',
      '  command: bin,',
      '  args,',
      '  env: sanitizeEnv(process.env),',
      '});',
    ].join('\n');
    expect(checkCodexSource(CODEX_FILE, source)).toEqual([{ file: CODEX_FILE, line: 1, rule: 'codex-spawn-env' }]);
  });

  it('flags env-less execFile / spawn / fork / bare exec calls in the codex dir', () => {
    for (const call of ['execFile(bin, args, cb);', 'spawn(bin, args);', 'fork(script);', 'exec(`codex login`);', 'execSync("codex logout");']) {
      expect(checkCodexSource(CODEX_FILE, call).map((v) => v.rule)).toEqual(['codex-spawn-env']);
    }
  });

  it('accepts a codex spawn built with buildCodexObserverEnv(sanitizeEnv(process.env)) and ignores RegExp.exec', () => {
    const source = [
      'child = spawnHidden(bin, args, {',
      '  cwd,',
      '  env: buildCodexObserverEnv(sanitizeEnv(process.env), settings),',
      "  stdio: ['ignore', 'pipe', 'pipe'],",
      '});',
      'const match = RESET_RE.exec(message);',
      '// spawn(bin) in a comment is ignored',
    ].join('\n');
    expect(checkCodexSource(CODEX_FILE, source)).toEqual([]);
  });

  it('scopes the DIRECTORY spawn rule to the codex dir', () => {
    expect(checkCodexSource('src/services/worker/OtherProvider.ts', 'spawnSdkProcess(id, { env: sanitizeEnv(process.env) });')).toEqual([]);
  });

  it('flags a DOTTED exec / execSync in the codex dir but still ignores regex receivers', () => {
    // `cp.execSync(cmd)` starts a process with the inherited worker env
    // (CODEX_API_KEY, OPENAI_BASE_URL, NODE_OPTIONS); only RegExp receivers
    // may be skipped.
    for (const call of [
      'cp.execSync(cmd);',
      'childProcess.exec(cmd);',
      "require('child_process').execSync(cmd);",
      'cp.exec(`codex login`, cb);',
    ]) {
      expect(checkCodexSource(CODEX_FILE, call).map((v) => v.rule)).toEqual(['codex-spawn-env']);
    }
    for (const call of [
      'const m = RESET_RE.exec(message);',
      'const m = ENVELOPE_CLOSE_RE.exec(out);',
      'const m = /foo/g.exec(text);',
      'const m = pattern.exec(text);',
    ]) {
      expect(checkCodexSource(CODEX_FILE, call)).toEqual([]);
    }
  });

  it('flags a codex spawn OUTSIDE the codex dir when it names the codex binary (callee-anchored)', () => {
    // M2/M3 wire codex into dependency-health.ts, provider-dispatch.ts,
    // worker-service.ts and SessionRoutes.ts; none of them are under the codex
    // dir, so the directory rule alone would accept a credential-leaking probe.
    const health = [
      'const codexPath = findCodexExecutable().path;',
      'const probe = spawnSync(codexPath, ["--version"], {',
      '  env: sanitizeEnv(process.env),',
      '});',
    ].join('\n');
    expect(checkCodexSource('src/services/worker/dependency-health.ts', health)).toEqual([
      { file: 'src/services/worker/dependency-health.ts', line: 2, rule: 'codex-callee-env' },
    ]);

    const envless = 'execFileSync(codexBinary, buildCodexProbeArgs("version", opts));';
    expect(checkCodexSource('src/services/worker/provider-dispatch.ts', envless).map((v) => v.rule)).toEqual(['codex-callee-env']);

    const ok = [
      'const child = spawnHidden(codexBinary, buildCodexExecArgs(opts), {',
      '  env: buildCodexObserverEnv(sanitizeEnv(process.env), settings),',
      '});',
    ].join('\n');
    expect(checkCodexSource('src/services/worker/worker-service.ts', ok)).toEqual([]);

    // A non-codex spawn outside the codex dir is untouched by the codex rules.
    expect(checkCodexSource('src/services/worker/OtherProvider.ts', 'spawnSync(bin, args, { env: sanitizeEnv(process.env) });')).toEqual([]);

    // claude-mem's Codex HOST integration is a different trust boundary.
    expect(checkCodexSource('src/services/integrations/CodexCliInstaller.ts', envless)).toEqual([]);
  });

  it('flags the dangerous codex flags anywhere except codex-invocation.ts', () => {
    const lines = [
      "const a = '--dangerously-bypass-approvals-and-sandbox';",
      "const b = '--dangerously-bypass-hook-trust';",
      "const c = 'danger-full-access';",
      "const d = ['resume', '--last'];",
      "const e = '--add-dir';",
    ];
    for (const file of ['src/services/worker/CodexProvider.ts', 'scripts/some-script.cjs', CODEX_FILE]) {
      const found = checkCodexSource(file, lines.join('\n')).filter((v) => v.rule === 'codex-forbidden-arg');
      expect(found.map((v) => v.detail)).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        'danger-full-access',
        "'--last'",
        '--add-dir',
      ]);
    }
    expect(checkCodexSource('src/services/worker/codex/codex-invocation.ts', lines.join('\n'))).toEqual([]);
    // Unquoted prose mention of --last is not an argument literal.
    expect(checkCodexSource('src/x.ts', 'resume with --last is never used')).toEqual([]);
  });
});

describe('buildCodexObserverEnv on top of sanitizeEnv', () => {
  it('drops host CLI bleed-through and credentials that would redirect Codex billing', () => {
    const env = buildCodexObserverEnv(
      sanitizeEnv({
        PATH: '/usr/bin',
        HOME: '/home/u',
        CLAUDE_CODE_EFFORT_LEVEL: 'MAX',
        ANTHROPIC_BASE_URL: 'http://gateway.invalid',
        ANTHROPIC_API_KEY: 'x',
        CODEX_API_KEY: 'x',
        OPENAI_BASE_URL: 'http://gateway.invalid',
        AWS_SECRET_ACCESS_KEY: 'x',
        HTTPS_PROXY: 'http://proxy.local:3128',
        TZ: 'Europe/Istanbul',
      }),
      { CLAUDE_MEM_CODEX_HOME: '/home/u/.codex' },
    );
    for (const key of ['CLAUDE_CODE_EFFORT_LEVEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'AWS_SECRET_ACCESS_KEY']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:3128');
    expect(env.TZ).toBe('Europe/Istanbul');
    expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
    expect(env.CODEX_HOME).toBe('/home/u/.codex');
  });
});

/**
 * #2753 — buildIsolatedEnv() must stamp the EFFECTIVE CLAUDE_CONFIG_DIR onto
 * the isolated env it hands to the SDK subprocess (precedence: the
 * CLAUDE_MEM_CLAUDE_CONFIG_DIR setting > process.env.CLAUDE_CONFIG_DIR >
 * default), while never touching the WORKER's own module-level
 * paths.CLAUDE_CONFIG_DIR / MARKETPLACE_ROOT constants.
 *
 * paths.ts's own CLAUDE_CONFIG_DIR is frozen at first module evaluation from
 * process.env.CLAUDE_CONFIG_DIR at THAT time (same convention as DATA_DIR
 * elsewhere in this codebase) — mutating process.env.CLAUDE_CONFIG_DIR at
 * test runtime has no effect on it, so these tests exercise the "setting"
 * side of the precedence (the only side that IS re-read live, via
 * SettingsDefaultsManager.loadFromFile on every call) against whatever the
 * frozen CLAUDE_CONFIG_DIR happens to resolve to in this process — the
 * "process.env > default" half of the fallback is covered separately at the
 * pure-function level in tests/shared/oauth-token.test.ts
 * (resolveEffectiveClaudeConfigDir), where it doesn't depend on module-load
 * timing.
 *
 * SettingsDefaultsManager.loadFromFile is a static method — spyOn mutates
 * the class object every importer (including EnvManager.ts) calls through,
 * so mocking it here is observed by buildIsolatedEnv() without touching the
 * real ~/.claude-mem/settings.json. Always restored in afterEach.
 */
describe('#2753: buildIsolatedEnv resolves CLAUDE_CONFIG_DIR for the SDK subprocess only', () => {
  let loadFromFileSpy: ReturnType<typeof spyOn> | undefined;

  function stubConfigDirSetting(value: string): void {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(
      () => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CLAUDE_CONFIG_DIR: value }) as any
    );
  }

  afterEach(() => {
    loadFromFileSpy?.mockRestore();
    loadFromFileSpy = undefined;
  });

  it('the CLAUDE_MEM_CLAUDE_CONFIG_DIR setting wins over the frozen CLAUDE_CONFIG_DIR fallback', () => {
    stubConfigDirSetting('/tmp/from-setting');

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/from-setting');
    expect(result.CLAUDE_CONFIG_DIR).not.toBe(CLAUDE_CONFIG_DIR);
  });

  it('falls through to the frozen CLAUDE_CONFIG_DIR (env-or-default, resolved at module load) when the setting is empty', () => {
    stubConfigDirSetting('');

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(CLAUDE_CONFIG_DIR);
  });

  it('never touches the worker\'s own paths.CLAUDE_CONFIG_DIR / MARKETPLACE_ROOT module constants, nor the real process.env.CLAUDE_CONFIG_DIR', () => {
    const beforeConfigDir = CLAUDE_CONFIG_DIR;
    const beforeMarketplaceRoot = MARKETPLACE_ROOT;
    // Captured before the call so a regression that ALSO promotes the
    // resolved override onto the real process env (which would leak into
    // every other paths.* consumer in this worker process, not just the
    // isolated subprocess env) is actually caught — `CLAUDE_CONFIG_DIR` /
    // `MARKETPLACE_ROOT` above are frozen module constants that TypeScript
    // `const` semantics make impossible to mutate, so they can't detect that
    // class of leak on their own.
    const beforeProcessEnvConfigDir = process.env.CLAUDE_CONFIG_DIR;

    stubConfigDirSetting('/tmp/subprocess-only-override');
    const result = buildIsolatedEnv();

    // The subprocess env got the override...
    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/subprocess-only-override');
    // ...but the worker's own frozen module constants did not move at all...
    expect(CLAUDE_CONFIG_DIR).toBe(beforeConfigDir);
    expect(MARKETPLACE_ROOT).toBe(beforeMarketplaceRoot);
    expect(paths.supervisorRegistry()).toContain(paths.dataDir());
    // ...and neither did the real process environment.
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(beforeProcessEnvConfigDir);
  });

  it('buildIsolatedEnvWithFreshOAuth(false) inherits the same CLAUDE_CONFIG_DIR resolution as buildIsolatedEnv', async () => {
    stubConfigDirSetting('/tmp/from-setting-via-fresh-oauth');

    // includeCredentials=false short-circuits before any OAuth/keychain
    // lookup (see buildIsolatedEnvWithFreshOAuth's own early return) — this
    // isolates the CLAUDE_CONFIG_DIR assertion from platform-dependent
    // keychain behavior.
    const result = await buildIsolatedEnvWithFreshOAuth(false);

    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/from-setting-via-fresh-oauth');
  });

  // Round 3 fix: resolveEffectiveClaudeConfigDir strips a trailing separator,
  // and buildIsolatedEnv resolves through it — so the SDK subprocess never
  // sees a trailing-slash CLAUDE_CONFIG_DIR that would otherwise mismatch the
  // worker's own no-trailing-slash value elsewhere (and, for the darwin
  // keychain lookup, fail the default-vs-suffixed comparison in
  // deriveMacKeychainServiceName).
  it('strips a trailing separator from a CLAUDE_MEM_CLAUDE_CONFIG_DIR setting before stamping it onto the subprocess env', () => {
    stubConfigDirSetting('/tmp/from-setting-with-slash/');

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/from-setting-with-slash');
  });
});
