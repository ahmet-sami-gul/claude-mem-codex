import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import {
  buildCodexObserverEnv,
  resolveCodexHome,
  isAllowedCodexEnvKey,
  CODEX_ENV_ALLOWLIST,
  CODEX_ENV_FALLBACK_PATH,
} from '../../../src/services/worker/codex/codex-env.js';
import { sanitizeEnv } from '../../../src/supervisor/env-sanitizer.js';

const HOME = '/Users/tester';

const KEPT: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME,
  USER: 'tester',
  LOGNAME: 'tester',
  TMPDIR: '/var/folders/xx/T/',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TZ: 'Europe/Istanbul',
  HTTP_PROXY: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  ALL_PROXY: 'socks5://proxy:1080',
  http_proxy: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  no_proxy: 'localhost',
  all_proxy: 'socks5://proxy:1080',
  SSL_CERT_FILE: '/etc/ssl/cert.pem',
  SSL_CERT_DIR: '/etc/ssl/certs',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
};

const DROPPED: Record<string, string> = {
  CODEX_API_KEY: 'sk-codex-should-not-leak',
  CODEX_ACCESS_TOKEN: 'tok-should-not-leak',
  OPENAI_API_KEY: 'sk-openai',
  OPENAI_BASE_URL: 'https://evil.example/v1',
  OPENAI_ORG_ID: 'org',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_BASE_URL: 'https://evil.example',
  GEMINI_API_KEY: 'gem',
  OPENROUTER_API_KEY: 'or',
  AWS_ACCESS_KEY_ID: 'AKIA',
  AWS_SECRET_ACCESS_KEY: 'secret',
  AWS_PROFILE: 'default',
  GH_TOKEN: 'ghp_x',
  GITHUB_TOKEN: 'ghp_y',
  NODE_OPTIONS: '--require /tmp/evil.js',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  LD_PRELOAD: '/tmp/evil.so',
  CODEX_THREAD_ID: 'thread',
  CODEX_SANDBOX: 'seatbelt',
  CODEX_SANDBOX_NETWORK_DISABLED: '1',
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'x',
  CODEX_MANAGED_BY_NPM: '1',
  CODEX_MANAGED_BY_BUN: '1',
  CODEX_MANAGED_PACKAGE_ROOT: '/opt/codex',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  CLAUDE_MEM_WORKER_PORT: '37701',
  SHELL: '/bin/zsh',
  EDITOR: 'vim',
  RANDOM_VAR: 'x',
};

describe('buildCodexObserverEnv: allowlist', () => {
  it('keeps only allowlisted keys plus CODEX_HOME and the forced values', () => {
    const env = buildCodexObserverEnv({ ...KEPT, ...DROPPED, TERM: 'xterm-256color', RUST_LOG: 'trace', NO_COLOR: '0' });
    const expectedKeys = new Set([...Object.keys(KEPT), 'CODEX_HOME', 'TERM', 'NO_COLOR', 'RUST_LOG', 'CLAUDE_MEM_INTERNAL']);
    expect(new Set(Object.keys(env))).toEqual(expectedKeys);
    for (const [key, value] of Object.entries(KEPT)) {
      expect(env[key]).toBe(value);
    }
  });

  it('drops API keys, provider base URLs, loader hooks and Codex internal variables', () => {
    const env = buildCodexObserverEnv({ ...KEPT, ...DROPPED });
    for (const key of Object.keys(DROPPED)) {
      expect(env[key]).toBeUndefined();
      expect(isAllowedCodexEnvKey(key)).toBe(false);
    }
  });

  it('forces TERM=dumb, NO_COLOR=1, RUST_LOG=error and CLAUDE_MEM_INTERNAL=1 over base values', () => {
    const env = buildCodexObserverEnv({ ...KEPT, TERM: 'xterm', NO_COLOR: '', RUST_LOG: 'debug', CLAUDE_MEM_INTERNAL: '0' });
    expect(env.TERM).toBe('dumb');
    expect(env.NO_COLOR).toBe('1');
    expect(env.RUST_LOG).toBe('error');
    expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
  });

  it('passes TZ through when the worker has it and omits it otherwise', () => {
    expect(CODEX_ENV_ALLOWLIST.has('TZ')).toBe(true);
    expect(buildCodexObserverEnv({ ...KEPT, TZ: 'America/New_York' }).TZ).toBe('America/New_York');
    const { TZ: _tz, ...withoutTz } = KEPT;
    expect(buildCodexObserverEnv(withoutTz).TZ).toBeUndefined();
  });

  it('fills HOME and PATH when missing and drops values containing NUL', () => {
    const env = buildCodexObserverEnv({ USER: 'a\0b', LANG: 'C' }, {}, { homeDir: '/home/fallback' });
    expect(env.HOME).toBe('/home/fallback');
    expect(env.PATH).toBe(CODEX_ENV_FALLBACK_PATH);
    expect(env.USER).toBeUndefined();
    expect(env.LANG).toBe('C');
    expect(env.CODEX_HOME).toBe(join('/home/fallback', '.codex'));
  });

  it('composes with sanitizeEnv(process-like env) and does not alias its input', () => {
    const base = sanitizeEnv({ ...KEPT, CLAUDE_CODE_EFFORT_LEVEL: 'MAX', CODEX_API_KEY: 'sk-x' });
    const env = buildCodexObserverEnv(base);
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    env.PATH = '/mutated';
    expect(base.PATH).toBe(KEPT.PATH);
  });
});

describe('win32 essentials', () => {
  const WIN_BASE: Record<string, string> = {
    PATH: 'C:\\Windows\\system32;C:\\tools',
    USERPROFILE: 'C:\\Users\\tester',
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    NUMBER_OF_PROCESSORS: '8',
    PROCESSOR_ARCHITECTURE: 'AMD64',
  };

  it('keeps the OS variables a Windows child cannot start without', () => {
    // Without SystemRoot most Windows binaries fail Winsock/DNS init; the
    // failure would surface as an opaque transient codex_exit_nonzero.
    const env = buildCodexObserverEnv({ ...WIN_BASE, HOME: 'C:\\Users\\tester' }, {}, { platform: 'win32' });
    for (const key of Object.keys(WIN_BASE)) {
      expect(env[key]).toBe(WIN_BASE[key]);
    }
    expect(env.CODEX_HOME).toBe('C:\\Users\\tester\\.codex');
    expect(env.CLAUDE_MEM_INTERNAL).toBe('1');
  });

  it('does not widen the POSIX allowlist, and still drops credentials on win32', () => {
    const posix = buildCodexObserverEnv({ ...KEPT, SystemRoot: 'C:\\Windows', APPDATA: '/appdata' }, {}, { platform: 'darwin' });
    expect(posix.SystemRoot).toBeUndefined();
    expect(posix.APPDATA).toBeUndefined();
    expect(isAllowedCodexEnvKey('SystemRoot', 'linux')).toBe(false);
    expect(isAllowedCodexEnvKey('SystemRoot', 'win32')).toBe(true);

    const win = buildCodexObserverEnv(
      { ...WIN_BASE, HOME: 'C:\\Users\\tester', CODEX_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://x', NODE_OPTIONS: '--require evil' },
      {},
      { platform: 'win32' },
    );
    expect(win.CODEX_API_KEY).toBeUndefined();
    expect(win.OPENAI_BASE_URL).toBeUndefined();
    expect(win.NODE_OPTIONS).toBeUndefined();
  });
});

describe('CODEX_HOME resolution', () => {
  it('prefers CLAUDE_MEM_CODEX_HOME, then $CODEX_HOME, then ~/.codex', () => {
    expect(buildCodexObserverEnv({ ...KEPT, CODEX_HOME: '/env/codex' }, { CLAUDE_MEM_CODEX_HOME: '/settings/codex' }).CODEX_HOME)
      .toBe('/settings/codex');
    expect(buildCodexObserverEnv({ ...KEPT, CODEX_HOME: '/env/codex' }, {}).CODEX_HOME).toBe('/env/codex');
    expect(buildCodexObserverEnv({ ...KEPT }, {}).CODEX_HOME).toBe(join(HOME, '.codex'));
  });

  it('ignores a whitespace-only setting and expands a leading ~', () => {
    expect(buildCodexObserverEnv({ ...KEPT }, { CLAUDE_MEM_CODEX_HOME: '   ' }).CODEX_HOME).toBe(join(HOME, '.codex'));
    expect(buildCodexObserverEnv({ ...KEPT }, { CLAUDE_MEM_CODEX_HOME: '~/alt-codex' }, { platform: 'darwin' }).CODEX_HOME)
      .toBe(join(HOME, 'alt-codex'));
  });

  it('fails closed on a relative or NUL-bearing configured home', () => {
    expect(() => resolveCodexHome({ CLAUDE_MEM_CODEX_HOME: 'relative/codex' }, KEPT)).toThrow(/absolute/);
    expect(() => resolveCodexHome({}, { ...KEPT, CODEX_HOME: 'rel' })).toThrow(/absolute/);
    expect(() => resolveCodexHome({ CLAUDE_MEM_CODEX_HOME: '/a\0b' }, KEPT)).toThrow(/NUL/);
  });
});
