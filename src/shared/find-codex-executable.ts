/**
 * Fail-closed resolution of the native Codex CLI binary for the codex observer
 * provider (plan 2.1).
 *
 * Search order:
 *   1. An explicit path (the caller passes CLAUDE_MEM_CODEX_PATH; file/env only,
 *      never writable over HTTP). When set, it is authoritative: a broken
 *      explicit path is an error, never a reason to search further.
 *   2. Every `codex` on PATH, absolute PATH entries only (`which -a`
 *      semantics, first usable match wins). On win32 `codex.exe`, `codex.cmd`
 *      and `codex.bat` are probed per entry, because npm installs only the
 *      shims there; a shim is never returned (see below) but it makes the
 *      failure say what to do instead of "not found".
 *   3. macOS app bundles (/Applications/{ChatGPT,Codex}.app/Contents/Resources/codex)
 *      via lookupCodexOnMacOS from CodexCliInstaller.ts, used read-only and
 *      with its PATH branch disabled, because that branch returns the bare
 *      name 'codex'.
 * The hit is then realpath'ed. An npm wrapper (realpath ending in
 * `@openai/codex/bin/codex.js`) is replaced by the native binary it would
 * launch (`<pkg>/node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex`,
 * or the hoisted sibling / legacy vendor layouts). The wrapper is never run:
 * it needs `node` on the daemon PATH, adds a process layer and forwards
 * signals through `stdio: inherit`. A Windows `.cmd`/`.bat`/`.ps1` shim is
 * rejected outright (`codex_unsupported_wrapper`) from every source, explicit
 * path included: the process registry would spawn a `.cmd` through
 * `cmd.exe /d /c`, re-parsing the locked argv under shell quoting rules the
 * argv guard does not model.
 *
 * Validation: the final binary must be a regular file passing
 * accessSync(X_OK). Anything else throws CodexExecutableError; the bare name
 * 'codex' is NEVER returned (resolveCodexCommand in CodexCliInstaller.ts does
 * return it, which is why it is not used here).
 *
 * No subprocess is started: resolution runs from the synchronous boot
 * preflight. isUsableCodexBundle (which spawns `--version` with the inherited
 * env) is therefore not the default bundle check; callers may inject it via
 * `isBundleAvailable`. The version is learned by the async self-check probe
 * and recorded with recordCodexBinaryVersion(); the fingerprint
 * realpath + mtime + size + version keys every cached result, so an updated
 * binary is re-verified.
 */

import { accessSync, constants, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { isUsableCodexBundle, lookupCodexOnMacOS } from '../services/integrations/CodexCliInstaller.js';
import { expandHome } from './expand-home.js';
import { logger } from '../utils/logger.js';

export type CodexExecutableErrorCode =
  | 'codex_path_not_absolute'
  | 'codex_path_missing'
  | 'codex_not_executable'
  | 'codex_not_found'
  | 'codex_wrapper_native_missing'
  | 'codex_unsupported_wrapper'
  | 'codex_unsupported_platform';

export class CodexExecutableError extends Error {
  readonly code: CodexExecutableErrorCode;
  /** Candidates that were considered and rejected, with the reason. */
  readonly rejected: readonly string[];
  constructor(code: CodexExecutableErrorCode, message: string, rejected: readonly string[] = []) {
    super(message);
    this.name = 'CodexExecutableError';
    this.code = code;
    this.rejected = rejected;
  }
}

export interface CodexBinaryFingerprint {
  realpath: string;
  mtimeMs: number;
  size: number;
  /** Known once the async `--version` probe recorded it; null before. */
  version: string | null;
}

export type CodexExecutableSource = 'explicit' | 'path' | 'macos_bundle';

export interface CodexExecutableResolution {
  /** Absolute realpath of the native binary to spawn. */
  path: string;
  source: CodexExecutableSource;
  /** The path found before realpath / wrapper derivation. */
  foundPath: string;
  viaNpmWrapper: boolean;
  fingerprint: CodexBinaryFingerprint;
}

export interface FindCodexExecutableOptions {
  /** CLAUDE_MEM_CODEX_PATH value; empty or whitespace means "search". */
  explicitPath?: string;
  /** PATH to search; defaults to process.env.PATH. */
  pathEnv?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  /**
   * macOS bundle availability check handed to lookupCodexOnMacOS. Defaults to
   * a spawn-free "regular file with X_OK" check.
   */
  isBundleAvailable?: (candidate: string) => boolean;
}

/** Filesystem seam; tests replace members instead of mocking modules. */
export const _internals = {
  accessSync: accessSync as (p: string, mode?: number) => void,
  statSync: ((p: string) => statSync(p)) as (p: string) => { isFile(): boolean; mtimeMs: number; size: number },
  realpathSync: ((p: string) => realpathSync(p)) as (p: string) => string,
  lookupCodexOnMacOS,
  homedir,
};

const PLATFORM_PACKAGE_BY_TRIPLE: Readonly<Record<string, string>> = Object.freeze({
  'x86_64-unknown-linux-musl': 'codex-linux-x64',
  'aarch64-unknown-linux-musl': 'codex-linux-arm64',
  'x86_64-apple-darwin': 'codex-darwin-x64',
  'aarch64-apple-darwin': 'codex-darwin-arm64',
  'x86_64-pc-windows-msvc': 'codex-win32-x64',
  'aarch64-pc-windows-msvc': 'codex-win32-arm64',
});

/** Rust target triple the npm wrapper would pick (mirrors @openai/codex bin/codex.js). */
export function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case 'linux':
    case 'android':
      return arch === 'x64' ? 'x86_64-unknown-linux-musl' : arch === 'arm64' ? 'aarch64-unknown-linux-musl' : null;
    case 'darwin':
      return arch === 'x64' ? 'x86_64-apple-darwin' : arch === 'arm64' ? 'aarch64-apple-darwin' : null;
    case 'win32':
      return arch === 'x64' ? 'x86_64-pc-windows-msvc' : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : null;
    default:
      return null;
  }
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'codex.exe' : 'codex';
}

/**
 * Names to look for on each PATH entry. On win32 the npm install puts
 * `codex.cmd` (plus `codex.ps1`) on PATH and there is no `codex.exe`, so
 * probing only `codex.exe` would make PATH discovery silently impossible
 * there. The shims are probed so resolveCandidate can reject them with the
 * actionable `codex_unsupported_wrapper` reason instead of the generic
 * "not found"; they are never returned as the native binary.
 */
function binaryNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
}

const WRAPPER_SUFFIX = ['@openai', 'codex', 'bin', 'codex.js'];

/** Windows shims that launch the real binary through a shell; never a native binary. */
const SHIM_EXTENSION_RE = /\.(?:cmd|bat|ps1)$/i;

/** True when a realpath is the @openai/codex npm entry script. */
export function isCodexNpmWrapper(realPath: string): boolean {
  const parts = realPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length < WRAPPER_SUFFIX.length) return false;
  const tail = parts.slice(-WRAPPER_SUFFIX.length);
  return tail.every((part, i) => part === WRAPPER_SUFFIX[i]);
}

/**
 * Candidate native binaries behind an npm wrapper realpath, most specific
 * first: nested optional dependency, hoisted sibling, legacy bundled vendor.
 */
export function nativeCandidatesForWrapper(wrapperRealPath: string, platform: NodeJS.Platform, arch: string): string[] {
  const triple = codexTargetTriple(platform, arch);
  if (!triple) return [];
  const pkgName = PLATFORM_PACKAGE_BY_TRIPLE[triple];
  const p = pathApi(platform);
  const pkgRoot = p.dirname(p.dirname(wrapperRealPath)); // .../@openai/codex
  const scopeDir = p.dirname(pkgRoot); // .../@openai
  const exe = binaryName(platform);
  return [
    p.join(pkgRoot, 'node_modules', '@openai', pkgName, 'vendor', triple, 'bin', exe),
    p.join(scopeDir, pkgName, 'vendor', triple, 'bin', exe),
    p.join(pkgRoot, 'vendor', triple, 'bin', exe),
  ];
}

type FileCheck = { ok: true; mtimeMs: number; size: number } | { ok: false; reason: string };

function checkExecutableFile(candidate: string): FileCheck {
  let stat: { isFile(): boolean; mtimeMs: number; size: number };
  try {
    stat = _internals.statSync(candidate);
  } catch {
    // [ANTI-PATTERN IGNORED]: a missing candidate is the normal negative result of a lookup.
    return { ok: false, reason: 'does not exist' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'is not a regular file' };
  try {
    _internals.accessSync(candidate, constants.X_OK);
  } catch {
    // [ANTI-PATTERN IGNORED]: X_OK failure is the documented "not executable" outcome.
    return { ok: false, reason: 'is not executable' };
  }
  return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
}

function realpathOrSelf(candidate: string): string {
  try {
    return _internals.realpathSync(candidate);
  } catch {
    // [ANTI-PATTERN IGNORED]: an unresolvable symlink is re-checked below and rejected there.
    return candidate;
  }
}

function isAbsoluteFor(platform: NodeJS.Platform, candidate: string): boolean {
  return pathApi(platform).isAbsolute(candidate);
}

type CandidateResult =
  | { ok: true; resolution: CodexExecutableResolution }
  | { ok: false; code: CodexExecutableErrorCode; reason: string };

function resolveCandidate(
  foundPath: string,
  source: CodexExecutableSource,
  platform: NodeJS.Platform,
  arch: string,
): CandidateResult {
  const found = checkExecutableFile(foundPath);
  if (!found.ok) {
    return { ok: false, code: found.reason === 'does not exist' ? 'codex_path_missing' : 'codex_not_executable', reason: `${foundPath} ${found.reason}` };
  }

  const real = realpathOrSelf(foundPath);
  let nativePath = real;
  let viaNpmWrapper = false;

  if (isCodexNpmWrapper(real)) {
    viaNpmWrapper = true;
    const candidates = nativeCandidatesForWrapper(real, platform, arch);
    if (candidates.length === 0) {
      return { ok: false, code: 'codex_unsupported_platform', reason: `${foundPath} is the npm wrapper, but ${platform}/${arch} has no native Codex package` };
    }
    const hit = candidates.find((candidate) => checkExecutableFile(candidate).ok);
    if (!hit) {
      return { ok: false, code: 'codex_wrapper_native_missing', reason: `${foundPath} is the npm wrapper, but its native binary is missing (looked in ${candidates.join(', ')})` };
    }
    nativePath = realpathOrSelf(hit);
  } else if (/\.(?:c|m)?js$/i.test(real)) {
    return { ok: false, code: 'codex_unsupported_wrapper', reason: `${foundPath} resolves to a script (${path.basename(real)}), not a native binary` };
  } else if (SHIM_EXTENSION_RE.test(real)) {
    // A .cmd/.bat/.ps1 shim (the npm wrapper shape on Windows) must never be
    // returned as "the native binary": process-registry spawns a `.cmd` through
    // `cmd.exe /d /c`, which re-parses the whole locked argv (including
    // `-c developer_instructions="..."`) under shell quoting rules that
    // assertCodexArgvSafe does not model.
    return {
      ok: false,
      code: 'codex_unsupported_wrapper',
      reason: `${foundPath} resolves to a Windows shim (${path.basename(real)}); set CLAUDE_MEM_CODEX_PATH to the native codex binary (…\\@openai\\codex-<platform>\\vendor\\<triple>\\bin\\codex.exe)`,
    };
  }

  if (!isAbsoluteFor(platform, nativePath)) {
    return { ok: false, code: 'codex_path_not_absolute', reason: `${nativePath} is not absolute` };
  }
  const native = checkExecutableFile(nativePath);
  if (!native.ok) {
    return { ok: false, code: 'codex_not_executable', reason: `${nativePath} ${native.reason}` };
  }

  const fingerprint: CodexBinaryFingerprint = {
    realpath: nativePath,
    mtimeMs: native.mtimeMs,
    size: native.size,
    version: lookupRecordedVersion(nativePath, native.mtimeMs, native.size),
  };
  return {
    ok: true,
    resolution: { path: nativePath, source, foundPath, viaNpmWrapper, fingerprint },
  };
}

function pathCandidates(pathEnv: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform);
  const delimiter = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.trim();
    if (!dir || !p.isAbsolute(dir)) continue; // relative PATH entries are never searched
    for (const name of binaryNames(platform)) {
      const candidate = p.join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

function defaultBundleCheck(candidate: string): boolean {
  return checkExecutableFile(candidate).ok;
}

/**
 * Opt-in bundle check that reuses CodexCliInstaller's `isUsableCodexBundle`
 * (it runs `<candidate> --version` with the INHERITED env, so it is not the
 * default here: findCodexExecutable is called from the synchronous boot
 * preflight and must not spawn). Pass it as `isBundleAvailable` from an async
 * caller that can afford the probe. CodexCliInstaller.ts is used read-only and
 * is never modified or moved.
 */
export function codexBundleAvailableViaVersionProbe(candidate: string): boolean {
  return defaultBundleCheck(candidate) && isUsableCodexBundle(candidate);
}

// ---------------------------------------------------------------------------
// Fingerprint / version cache
// ---------------------------------------------------------------------------

const recordedVersions = new Map<string, string>();
let lastLoggedFingerprint: string | null = null;

function versionKey(realPath: string, mtimeMs: number, size: number): string {
  return `${realPath}\u0000${mtimeMs}\u0000${size}`;
}

function lookupRecordedVersion(realPath: string, mtimeMs: number, size: number): string | null {
  return recordedVersions.get(versionKey(realPath, mtimeMs, size)) ?? null;
}

/**
 * Record the version the async `--version` probe returned for a binary. Only
 * that exact realpath + mtime + size gets it; a replaced binary starts over
 * with version null.
 */
export function recordCodexBinaryVersion(
  fingerprint: Pick<CodexBinaryFingerprint, 'realpath' | 'mtimeMs' | 'size'>,
  version: string,
): CodexBinaryFingerprint {
  const trimmed = version.trim();
  recordedVersions.set(versionKey(fingerprint.realpath, fingerprint.mtimeMs, fingerprint.size), trimmed);
  return { realpath: fingerprint.realpath, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, version: trimmed };
}

/** Stable key for caches of per-binary results (self-check outcome, etc.). */
export function codexFingerprintKey(fingerprint: CodexBinaryFingerprint): string {
  return `${versionKey(fingerprint.realpath, fingerprint.mtimeMs, fingerprint.size)}\u0000${fingerprint.version ?? ''}`;
}

/** Test hook. */
export function resetCodexExecutableCache(): void {
  recordedVersions.clear();
  lastLoggedFingerprint = null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function logResolution(resolution: CodexExecutableResolution): void {
  const key = codexFingerprintKey(resolution.fingerprint);
  if (key === lastLoggedFingerprint) return;
  lastLoggedFingerprint = key;
  logger.info('WORKER', `Using Codex CLI native binary at ${resolution.path}`, {
    source: resolution.source,
    viaNpmWrapper: resolution.viaNpmWrapper,
    version: resolution.fingerprint.version,
  });
}

/**
 * Resolve the native Codex binary. Synchronous and spawn-free. Throws
 * CodexExecutableError when nothing usable is found; never returns a bare name.
 */
export function findCodexExecutable(options: FindCodexExecutableOptions = {}): CodexExecutableResolution {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.homeDir ?? _internals.homedir();

  // 1. Explicit path: authoritative, fail closed.
  const explicitRaw = (options.explicitPath ?? '').trim();
  if (explicitRaw.length > 0) {
    if (explicitRaw.includes('\0')) {
      throw new CodexExecutableError('codex_path_not_absolute', 'CLAUDE_MEM_CODEX_PATH contains a NUL byte');
    }
    const explicit = expandHome(explicitRaw, platform, home);
    if (!isAbsoluteFor(platform, explicit)) {
      throw new CodexExecutableError(
        'codex_path_not_absolute',
        `CLAUDE_MEM_CODEX_PATH must be an absolute path to the codex binary (got "${explicitRaw}")`,
      );
    }
    const result = resolveCandidate(explicit, 'explicit', platform, arch);
    if (!result.ok) {
      throw new CodexExecutableError(result.code, `CLAUDE_MEM_CODEX_PATH is set but unusable: ${result.reason}`, [result.reason]);
    }
    logResolution(result.resolution);
    return result.resolution;
  }

  const rejected: string[] = [];

  // 2. Absolute PATH entries.
  for (const candidate of pathCandidates(options.pathEnv ?? process.env.PATH ?? '', platform)) {
    const result = resolveCandidate(candidate, 'path', platform, arch);
    if (result.ok) {
      logResolution(result.resolution);
      return result.resolution;
    }
    if (result.code !== 'codex_path_missing') rejected.push(result.reason);
  }

  // 3. macOS app bundles (PATH branch of lookupCodexOnMacOS disabled: it would return the bare name).
  if (platform === 'darwin') {
    const bundle = _internals.lookupCodexOnMacOS(() => false, options.isBundleAvailable ?? defaultBundleCheck);
    if (bundle && bundle !== 'codex' && isAbsoluteFor(platform, bundle)) {
      const result = resolveCandidate(bundle, 'macos_bundle', platform, arch);
      if (result.ok) {
        logResolution(result.resolution);
        return result.resolution;
      }
      rejected.push(result.reason);
    }
  }

  const detail = rejected.length > 0 ? ` Rejected: ${rejected.join('; ')}.` : '';
  throw new CodexExecutableError(
    rejected.some((reason) => reason.includes('native binary is missing'))
      ? 'codex_wrapper_native_missing'
      : rejected.some((reason) => reason.includes('Windows shim'))
        ? 'codex_unsupported_wrapper'
        : 'codex_not_found',
    `Codex CLI not found. Install it or set CLAUDE_MEM_CODEX_PATH to the absolute native codex binary.${detail}`,
    rejected,
  );
}
