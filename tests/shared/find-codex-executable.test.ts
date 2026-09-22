import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  findCodexExecutable,
  recordCodexBinaryVersion,
  codexFingerprintKey,
  resetCodexExecutableCache,
  isCodexNpmWrapper,
  nativeCandidatesForWrapper,
  codexTargetTriple,
  codexBundleAvailableViaVersionProbe,
  CodexExecutableError,
  _internals,
} from '../../src/shared/find-codex-executable.js';

/**
 * Every binary here is a fake file inside a mkdtemp directory. Resolution is
 * spawn-free, so nothing is ever executed; each resolved path is asserted to
 * live inside the temp root. POSIX permissions are required (skipped on win32).
 */
const IS_WINDOWS = process.platform === 'win32';
const ORIGINAL_LOOKUP = _internals.lookupCodexOnMacOS;

let root: string;

function writeFile(path: string, mode = 0o755, content = '#!/bin/sh\nexit 99\n'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function expectCodexError(fn: () => unknown, code: string): CodexExecutableError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CodexExecutableError);
  expect((thrown as CodexExecutableError).code).toBe(code);
  return thrown as CodexExecutableError;
}

/** npm global layout: <prefix>/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js */
function makeNpmWrapper(prefix: string): { binLink: string; wrapper: string; pkgRoot: string } {
  const pkgRoot = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  const wrapper = writeFile(join(pkgRoot, 'bin', 'codex.js'), 0o755, '#!/usr/bin/env node\n');
  const binLink = join(prefix, 'bin', 'codex');
  mkdirSync(dirname(binLink), { recursive: true });
  symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', binLink);
  return { binLink, wrapper, pkgRoot };
}

describe.skipIf(IS_WINDOWS)('findCodexExecutable', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-codex-find-')));
    resetCodexExecutableCache();
    _internals.lookupCodexOnMacOS = () => null;
  });

  afterEach(() => {
    _internals.lookupCodexOnMacOS = ORIGINAL_LOOKUP;
    resetCodexExecutableCache();
    rmSync(root, { recursive: true, force: true });
  });

  describe('explicit CLAUDE_MEM_CODEX_PATH', () => {
    it('uses an absolute executable path, realpath-ed', () => {
      const real = writeFile(join(root, 'opt', 'codex-native'));
      const link = join(root, 'links', 'codex');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(real, link);
      const resolution = findCodexExecutable({ explicitPath: link, pathEnv: '', platform: 'darwin', arch: 'arm64' });
      expect(resolution.path).toBe(real);
      expect(resolution.source).toBe('explicit');
      expect(resolution.foundPath).toBe(link);
      expect(resolution.viaNpmWrapper).toBe(false);
      expect(resolution.path.startsWith(root)).toBe(true);
    });

    it('expands a leading ~ against the home directory', () => {
      const real = writeFile(join(root, 'home', 'bin', 'codex'));
      const resolution = findCodexExecutable({ explicitPath: '~/bin/codex', homeDir: join(root, 'home'), pathEnv: '', platform: 'linux', arch: 'x64' });
      expect(resolution.path).toBe(real);
    });

    it('fails closed on relative, missing, non-executable or directory paths', () => {
      expectCodexError(() => findCodexExecutable({ explicitPath: 'bin/codex', pathEnv: '' }), 'codex_path_not_absolute');
      expectCodexError(() => findCodexExecutable({ explicitPath: join(root, 'nope'), pathEnv: '' }), 'codex_path_missing');
      const noExec = writeFile(join(root, 'noexec', 'codex'), 0o644);
      expectCodexError(() => findCodexExecutable({ explicitPath: noExec, pathEnv: '' }), 'codex_not_executable');
      mkdirSync(join(root, 'dir-codex'));
      expectCodexError(() => findCodexExecutable({ explicitPath: join(root, 'dir-codex'), pathEnv: '' }), 'codex_not_executable');
    });

    it('never falls back to PATH when the explicit path is broken', () => {
      writeFile(join(root, 'good', 'codex'));
      expectCodexError(
        () => findCodexExecutable({ explicitPath: join(root, 'missing', 'codex'), pathEnv: join(root, 'good'), platform: 'linux', arch: 'x64' }),
        'codex_path_missing',
      );
    });

    it('treats a whitespace-only explicit path as unset', () => {
      const real = writeFile(join(root, 'bin', 'codex'));
      expect(findCodexExecutable({ explicitPath: '   ', pathEnv: join(root, 'bin'), platform: 'linux', arch: 'x64' }).path).toBe(real);
    });
  });

  describe('PATH lookup', () => {
    it('takes the first usable absolute match and skips relative entries and non-executables', () => {
      writeFile(join(root, 'first', 'codex'), 0o644); // not executable
      const second = writeFile(join(root, 'second', 'codex'));
      writeFile(join(root, 'third', 'codex'));
      const pathEnv = ['relative/bin', '.', join(root, 'empty'), join(root, 'first'), join(root, 'second'), join(root, 'third')].join(':');
      const resolution = findCodexExecutable({ pathEnv, platform: 'linux', arch: 'x64' });
      expect(resolution.path).toBe(second);
      expect(resolution.source).toBe('path');
    });

    it('reports rejected candidates when nothing usable is found and never returns the bare name', () => {
      writeFile(join(root, 'first', 'codex'), 0o644);
      const error = expectCodexError(
        () => findCodexExecutable({ pathEnv: `${join(root, 'first')}:relative`, platform: 'linux', arch: 'x64' }),
        'codex_not_found',
      );
      expect(error.rejected.length).toBe(1);
      expect(error.message).toContain('CLAUDE_MEM_CODEX_PATH');
      expectCodexError(() => findCodexExecutable({ pathEnv: '', platform: 'linux', arch: 'x64' }), 'codex_not_found');
    });
  });

  describe('npm wrapper -> native binary', () => {
    it('derives the nested optional-dependency binary (darwin arm64 layout)', () => {
      const { binLink, pkgRoot } = makeNpmWrapper(join(root, 'node'));
      const native = writeFile(join(pkgRoot, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'));
      const resolution = findCodexExecutable({ pathEnv: dirname(binLink), platform: 'darwin', arch: 'arm64' });
      expect(resolution.path).toBe(native);
      expect(resolution.viaNpmWrapper).toBe(true);
      expect(resolution.foundPath).toBe(binLink);
      expect(resolution.path.endsWith('.js')).toBe(false);
    });

    it('derives the hoisted sibling layout (linux x64)', () => {
      const { binLink } = makeNpmWrapper(join(root, 'node'));
      const native = writeFile(join(root, 'node', 'lib', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'));
      const resolution = findCodexExecutable({ explicitPath: binLink, platform: 'linux', arch: 'x64' });
      expect(resolution.path).toBe(native);
    });

    it('fails closed when the native binary behind the wrapper is missing', () => {
      const { binLink } = makeNpmWrapper(join(root, 'node'));
      expectCodexError(() => findCodexExecutable({ explicitPath: binLink, platform: 'darwin', arch: 'arm64' }), 'codex_wrapper_native_missing');
      expectCodexError(() => findCodexExecutable({ pathEnv: dirname(binLink), platform: 'darwin', arch: 'arm64' }), 'codex_wrapper_native_missing');
    });

    it('fails closed for a platform the wrapper does not support', () => {
      const { binLink } = makeNpmWrapper(join(root, 'node'));
      expectCodexError(() => findCodexExecutable({ explicitPath: binLink, platform: 'linux', arch: 'ia32' }), 'codex_unsupported_platform');
    });

    it('rejects any other script instead of running it', () => {
      const script = writeFile(join(root, 'tools', 'codex.js'), 0o755, '#!/usr/bin/env node\n');
      expectCodexError(() => findCodexExecutable({ explicitPath: script, platform: 'linux', arch: 'x64' }), 'codex_unsupported_wrapper');
    });

    it('rejects a Windows .cmd / .bat / .ps1 shim from every source, with an actionable message', () => {
      // process-registry spawns a `.cmd` through `cmd.exe /d /c`, re-parsing the
      // whole locked argv (including -c developer_instructions="...") under
      // shell quoting rules that assertCodexArgvSafe does not model. Returning
      // a shim as "the native binary" would break the closed-argv invariant.
      for (const name of ['codex.cmd', 'codex.bat', 'codex.ps1']) {
        const shim = writeFile(join(root, 'shims', name), 0o755, '@echo off\r\n');
        const error = expectCodexError(
          () => findCodexExecutable({ explicitPath: shim, platform: 'win32', arch: 'x64' }),
          'codex_unsupported_wrapper',
        );
        expect(error.message).toContain('CLAUDE_MEM_CODEX_PATH');
        rmSync(join(root, 'shims'), { recursive: true, force: true });
      }
    });

    it('win32 PATH discovery probes the npm shims and says what to do instead of "not found"', () => {
      // npm/pnpm put codex.cmd (and codex.ps1) on PATH on Windows and there is
      // no codex.exe, so probing only codex.exe made PATH discovery impossible
      // there. Windows paths cannot be created on this filesystem, so the three
      // fs seams answer for a virtual C:\ tree instead.
      const files = new Set<string>();
      const originals = { stat: _internals.statSync, access: _internals.accessSync, real: _internals.realpathSync };
      _internals.statSync = (candidate: string) => {
        if (!files.has(candidate)) throw new Error('ENOENT');
        return { isFile: () => true, mtimeMs: 1, size: 2 };
      };
      _internals.accessSync = (candidate: string) => {
        if (!files.has(candidate)) throw new Error('EACCES');
      };
      _internals.realpathSync = (candidate: string) => candidate;
      try {
        files.add('C:\\npm\\codex.cmd');
        const error = expectCodexError(
          () => findCodexExecutable({ pathEnv: 'C:\\npm', platform: 'win32', arch: 'x64' }),
          'codex_unsupported_wrapper',
        );
        expect(error.rejected.join(' ')).toContain('Windows shim');
        expect(error.rejected.join(' ')).toContain('CLAUDE_MEM_CODEX_PATH');

        // A real codex.exe later on PATH still wins over the shim.
        files.add('C:\\tools\\codex.exe');
        const resolution = findCodexExecutable({ pathEnv: 'C:\\npm;C:\\tools', platform: 'win32', arch: 'x64' });
        expect(resolution.path).toBe('C:\\tools\\codex.exe');
        expect(resolution.source).toBe('path');
      } finally {
        _internals.statSync = originals.stat;
        _internals.accessSync = originals.access;
        _internals.realpathSync = originals.real;
      }
    });
  });

  describe('macOS app bundles', () => {
    it('asks lookupCodexOnMacOS with its PATH branch disabled and uses the bundle it returns', () => {
      const bundle = writeFile(join(root, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
      let pathBranchAnswer: boolean | undefined;
      _internals.lookupCodexOnMacOS = (commandInPath = () => true, available = () => false) => {
        pathBranchAnswer = commandInPath('codex');
        return available(bundle) ? bundle : null;
      };
      const resolution = findCodexExecutable({ pathEnv: '', platform: 'darwin', arch: 'arm64' });
      expect(pathBranchAnswer).toBe(false);
      expect(resolution.path).toBe(bundle);
      expect(resolution.source).toBe('macos_bundle');
    });

    it('the real lookupCodexOnMacOS never yields the bare name through our call', () => {
      _internals.lookupCodexOnMacOS = (commandInPath, available) => ORIGINAL_LOOKUP(commandInPath, (candidate) => {
        expect(candidate.startsWith('/Applications/')).toBe(true);
        void available;
        return false; // do not touch the real /Applications bundles
      });
      expectCodexError(() => findCodexExecutable({ pathEnv: '', platform: 'darwin', arch: 'arm64' }), 'codex_not_found');
    });

    it('ignores a bare-name or relative answer from the bundle lookup', () => {
      _internals.lookupCodexOnMacOS = () => 'codex';
      expectCodexError(() => findCodexExecutable({ pathEnv: '', platform: 'darwin', arch: 'arm64' }), 'codex_not_found');
    });

    it('does not consult app bundles on other platforms', () => {
      let called = false;
      _internals.lookupCodexOnMacOS = () => {
        called = true;
        return null;
      };
      expectCodexError(() => findCodexExecutable({ pathEnv: '', platform: 'linux', arch: 'x64' }), 'codex_not_found');
      expect(called).toBe(false);
    });
  });

  describe('fingerprint cache', () => {
    it('carries realpath, mtime and size, and the recorded version only for that exact binary', () => {
      const real = writeFile(join(root, 'bin', 'codex'));
      const first = findCodexExecutable({ explicitPath: real });
      const stat = statSync(real);
      expect(first.fingerprint).toEqual({ realpath: real, mtimeMs: stat.mtimeMs, size: stat.size, version: null });

      const recorded = recordCodexBinaryVersion(first.fingerprint, 'codex-cli 0.144.4\n');
      expect(recorded.version).toBe('codex-cli 0.144.4');
      const second = findCodexExecutable({ explicitPath: real });
      expect(second.fingerprint.version).toBe('codex-cli 0.144.4');
      expect(codexFingerprintKey(second.fingerprint)).not.toBe(codexFingerprintKey(first.fingerprint));

      // Replacing the binary (new mtime) invalidates the recorded version.
      const later = new Date(stat.mtimeMs + 60_000);
      utimesSync(real, later, later);
      const third = findCodexExecutable({ explicitPath: real });
      expect(third.fingerprint.version).toBeNull();
      expect(third.fingerprint.mtimeMs).not.toBe(first.fingerprint.mtimeMs);
    });
  });
});

describe('wrapper helpers', () => {
  it('recognises only the @openai/codex entry script', () => {
    expect(isCodexNpmWrapper('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBe(true);
    expect(isCodexNpmWrapper('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')).toBe(true);
    expect(isCodexNpmWrapper('/usr/local/lib/node_modules/@evil/codex/bin/codex.js')).toBe(false);
    expect(isCodexNpmWrapper('/opt/codex/bin/codex')).toBe(false);
  });

  it('maps platform/arch to the native package like the wrapper does', () => {
    expect(codexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(codexTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(codexTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
    expect(codexTargetTriple('android', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(codexTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(codexTargetTriple('linux', 'ia32')).toBeNull();
    expect(codexTargetTriple('freebsd', 'x64')).toBeNull();
    const wrapper = '/Users/u/.node/lib/node_modules/@openai/codex/bin/codex.js';
    expect(nativeCandidatesForWrapper(wrapper, 'darwin', 'arm64')[0]).toBe(
      '/Users/u/.node/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    );
    expect(nativeCandidatesForWrapper('C:\\n\\node_modules\\@openai\\codex\\bin\\codex.js', 'win32', 'x64')[0].endsWith('codex.exe')).toBe(true);
  });

  it('the resolver source never starts a subprocess outside the opt-in probe helper', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'shared', 'find-codex-executable.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // CodexCliInstaller's version probe is exposed for async callers only; it
    // is the single call site and is never on the resolution path.
    const optIn = /export function codexBundleAvailableViaVersionProbe[\s\S]*?\n}\n/.exec(source);
    expect(optIn).not.toBeNull();
    expect(source.replace(optIn![0], '')).not.toMatch(
      /child_process|spawnSync|execFileSync|execSync|\bspawn\(|isUsableCodexBundle\(/,
    );

    // The default bundle check is the spawn-free "regular file with X_OK" one.
    expect(source).toMatch(/isBundleAvailable \?\? defaultBundleCheck/);
  });

  it('the opt-in version probe short-circuits before spawning when the candidate is unusable', () => {
    const originalStat = _internals.statSync;
    // statSync throws for this path, so isUsableCodexBundle is never reached
    // and no subprocess is started by this test.
    _internals.statSync = () => { throw new Error('ENOENT'); };
    try {
      expect(codexBundleAvailableViaVersionProbe(join(tmpdir(), 'claude-mem-codex-absent', 'codex'))).toBe(false);
    } finally {
      _internals.statSync = originalStat;
    }
  });
});
