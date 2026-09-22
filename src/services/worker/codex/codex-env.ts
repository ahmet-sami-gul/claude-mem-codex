/**
 * Environment allowlist for every Codex subprocess: exec turns and the
 * self-check probes alike (plan 2.3, 5/L2).
 *
 * Call site shape (keeps scripts/check-spawn-env-discipline.cjs happy):
 *
 *   env: buildCodexObserverEnv(sanitizeEnv(process.env), settings)
 *
 * This is an ALLOWLIST, unlike buildIsolatedEnv (src/shared/EnvManager.ts),
 * which is a deny-list and injects GEMINI/OPENROUTER keys into the child.
 *
 * Kept: PATH, HOME, USER, LOGNAME, TMPDIR, LANG, LC_*, TZ, the upper- and
 * lower-case HTTP(S)_PROXY / NO_PROXY / ALL_PROXY, SSL_CERT_FILE, SSL_CERT_DIR,
 * NODE_EXTRA_CA_CERTS. On win32 also the OS essentials a Windows child cannot
 * start without (CODEX_ENV_WIN32_ALLOWLIST: SystemRoot, ComSpec, USERPROFILE,
 * APPDATA/LOCALAPPDATA, TEMP/TMP, PATHEXT, ...); the rest of this module is
 * already win32-aware (resolveCodexHome, the runner's kill path, the binary
 * resolver), so the child env must be too.
 *
 * TZ matters: Codex formats the usage-limit reset time ("Try again at 3:45 PM")
 * in its own local zone and the worker parses it in the worker's zone. If the
 * worker has TZ set, the child must see the same value or resumeAtMs drifts by
 * hours. Without TZ both processes use the system zone.
 *
 * Added: CODEX_HOME (CLAUDE_MEM_CODEX_HOME || $CODEX_HOME || ~/.codex; the
 * user's real home, auth.json is never copied because the refresh token
 * rotates), TERM=dumb, NO_COLOR=1, RUST_LOG=error, CLAUDE_MEM_INTERNAL=1 (makes
 * claude-mem's own hooks ignore observer runs).
 *
 * Explicitly dropped even if a future edit widened the allowlist:
 * CODEX_API_KEY / CODEX_ACCESS_TOKEN (exec prefers them over the ChatGPT login,
 * silently moving billing to the API), OPENAI_* (notably OPENAI_BASE_URL),
 * ANTHROPIC_*, GEMINI_API_KEY, OPENROUTER_API_KEY, AWS_*, GH_TOKEN,
 * GITHUB_TOKEN, NODE_OPTIONS, DYLD_*, LD_PRELOAD, CODEX_THREAD_ID,
 * CODEX_SANDBOX*, CODEX_INTERNAL_ORIGINATOR_OVERRIDE, CODEX_MANAGED_BY_*,
 * CODEX_MANAGED_PACKAGE_ROOT (npm-wrapper variables; Phase 0 ran the native
 * binary without them).
 *
 * Pure module: no I/O beyond os.homedir() as a fallback, no logging.
 */

import { homedir } from 'os';
import { isAbsolute, join, win32 } from 'path';
import { expandHome } from '../../../shared/expand-home.js';

/** Exact keys copied from the (already sanitizeEnv-filtered) base env. */
export const CODEX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * Extra keys copied only on win32. Without SystemRoot most Windows binaries
 * fail Winsock/DNS initialisation, and without ComSpec / TEMP / USERPROFILE /
 * APPDATA the child misbehaves in ways that surface as an opaque transient
 * `codex_exit_nonzero` rather than a diagnosable setup error. None of them
 * carry credentials, so the allowlist stays as tight as it is on POSIX.
 */
export const CODEX_ENV_WIN32_ALLOWLIST: ReadonlySet<string> = new Set([
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'SystemDrive',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

/** Key prefixes copied from the base env (locale categories: LC_ALL, LC_CTYPE, ...). */
export const CODEX_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/** Exact keys that must never reach a Codex child. */
export const CODEX_ENV_EXPLICIT_DROPS: ReadonlySet<string> = new Set([
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'CODEX_THREAD_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_MANAGED_PACKAGE_ROOT',
]);

/** Key prefixes that must never reach a Codex child. */
export const CODEX_ENV_DROPPED_PREFIXES: readonly string[] = [
  'OPENAI_',
  'ANTHROPIC_',
  'AWS_',
  'DYLD_',
  'CODEX_SANDBOX',
  'CODEX_MANAGED_BY_',
];

/** Values forced onto every Codex child. */
export const CODEX_ENV_FORCED: Readonly<Record<string, string>> = Object.freeze({
  TERM: 'dumb',
  NO_COLOR: '1',
  RUST_LOG: 'error',
  CLAUDE_MEM_INTERNAL: '1',
});

/** Used only when the base env has no PATH at all. */
export const CODEX_ENV_FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Settings this module reads (file/env only; never writable over HTTP). */
export interface CodexEnvSettings {
  CLAUDE_MEM_CODEX_HOME?: string;
}

export interface CodexEnvOptions {
  /** Home directory fallback when base.HOME is missing; defaults to os.homedir(). */
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function isExplicitlyDroppedCodexEnvKey(key: string): boolean {
  return CODEX_ENV_EXPLICIT_DROPS.has(key) || CODEX_ENV_DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isAllowedCodexEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  if (isExplicitlyDroppedCodexEnvKey(key)) return false;
  if (platform === 'win32' && CODEX_ENV_WIN32_ALLOWLIST.has(key)) return true;
  return CODEX_ENV_ALLOWLIST.has(key) || CODEX_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : isAbsolute(value);
}

/**
 * CODEX_HOME for the child: CLAUDE_MEM_CODEX_HOME || $CODEX_HOME || ~/.codex.
 * A leading `~` is expanded. Fails closed (throws) on a configured value that
 * is relative or contains a NUL byte, instead of silently falling back to a
 * different login.
 */
export function resolveCodexHome(
  settings: CodexEnvSettings,
  base: NodeJS.ProcessEnv,
  options: CodexEnvOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const home = usable(base.HOME) ?? options.homeDir ?? homedir();

  const candidates: Array<[string, string | undefined]> = [
    ['CLAUDE_MEM_CODEX_HOME', settings.CLAUDE_MEM_CODEX_HOME],
    ['CODEX_HOME', base.CODEX_HOME],
  ];
  for (const [source, raw] of candidates) {
    const value = nonEmpty(raw);
    if (value === undefined) continue;
    if (value.includes('\0')) {
      throw new Error(`${source} contains a NUL byte`);
    }
    const expanded = expandHome(value, platform, home);
    if (!isAbsoluteForPlatform(expanded, platform)) {
      throw new Error(`${source} must be an absolute path (got a relative path)`);
    }
    return expanded;
  }
  return platform === 'win32' ? win32.join(home, '.codex') : join(home, '.codex');
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Non-empty and free of NUL bytes. */
function usable(value: string | undefined): string | undefined {
  const trimmed = nonEmpty(value);
  return trimmed !== undefined && !trimmed.includes('\0') ? trimmed : undefined;
}

/**
 * Build the child env from `base` (pass `sanitizeEnv(process.env)`). Only
 * allowlisted keys survive; values containing a NUL byte are dropped (spawn
 * would reject them). HOME and PATH always exist in the result.
 */
export function buildCodexObserverEnv(
  base: NodeJS.ProcessEnv,
  settings: CodexEnvSettings = {},
  options: CodexEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  const platform = options.platform ?? process.platform;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!isAllowedCodexEnvKey(key, platform)) continue;
    if (value.includes('\0')) continue;
    env[key] = value;
  }

  if (!usable(env.HOME)) {
    env.HOME = options.homeDir ?? homedir();
  }
  if (!usable(env.PATH)) {
    env.PATH = CODEX_ENV_FALLBACK_PATH;
  }

  env.CODEX_HOME = resolveCodexHome(settings, { ...base, HOME: env.HOME }, options);

  for (const [key, value] of Object.entries(CODEX_ENV_FORCED)) {
    env[key] = value;
  }

  return env;
}
