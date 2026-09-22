/**
 * POSIX fake `codex` binaries for the runner / self-check / lockdown tests.
 *
 * Every fake lives in its own mkdtemp directory and records what the real
 * binary would see (argv, cwd, env, stdin) into files next to it. The exec
 * fake reads stdin with `cat` until EOF exactly like `codex exec -`, so a
 * runner that forgets to end stdin hangs the test instead of passing
 * (`exitBeforeStdin` is the opposite case: it dies without draining stdin, so
 * a large prompt reaches the runner's EPIPE path).
 *
 * Safety: createFakeCodex / createFakeCodexProbes assert that the binary they
 * return resolves (realpath) inside their own mkdtemp root, so no test can end
 * up spawning the real codex CLI (which would spend the user's paid plan).
 *
 * Not a test file (no `.test.ts` suffix); imported by the codex tests.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

export const IS_WINDOWS = process.platform === 'win32';

export const FIXTURES_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'codex');

export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

/** Shell-quote for embedding a path in a single-quoted sh string. */
function shq(value: string): string {
  if (value.includes("'")) throw new Error(`fake codex paths must not contain a single quote: ${value}`);
  return `'${value}'`;
}

function assertInside(root: string, file: string): void {
  const real = realpathSync(file);
  if (!real.startsWith(root + sep)) {
    throw new Error(`fake codex binary ${real} escaped its mkdtemp root ${root}`);
  }
}

export interface FakeCodexOptions {
  /** JSONL fixture copied to stdout after stdin EOF. */
  stdoutFixture?: string;
  /** Inline stdout lines (used when no fixture is given). */
  stdoutLines?: string[];
  /** Extra stderr text written after the stdin notice. */
  stderrText?: string;
  exitCode?: number;
  /**
   * Start a background `sleep 60` (a grandchild in the same process group,
   * holding stdout/stderr) BEFORE printing stdout, then `wait` for it: the
   * process never ends on its own and must be killed by the runner.
   */
  hang?: boolean;
  /** `trap '' INT`: SIGINT is ignored, so only the SIGKILL follow-up ends it. */
  ignoreSigint?: boolean;
  /** Trap SIGINT, record it in signals.txt, then continue to exit. */
  recordSigint?: boolean;
  /** End by killing itself with this signal instead of exiting. */
  selfSignal?: 'TERM';
  /**
   * Exit immediately WITHOUT draining stdin (no `cat`, no stdin-eof marker),
   * like a real codex that dies at flag parsing or on an auth error. A writer
   * pushing more than the pipe buffer then gets EPIPE on child.stdin.
   */
  exitBeforeStdin?: boolean;
  /**
   * Start a background `sleep 60` that inherits stdout/stderr and then exit the
   * LEADER without `wait`: the pipes stay open after the leader is gone, which
   * is the only way to reach the runner's exit-drain branch.
   */
  detachChild?: boolean;
}

export interface FakeCodex {
  /** realpath of the mkdtemp root. */
  root: string;
  binaryPath: string;
  recDir: string;
  read(name: string): string | null;
  argv(): string[];
  env(): Record<string, string>;
  grandchildPid(): number | null;
  cleanup(): void;
}

function parseEnvDump(text: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  if (!text) return env;
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function makeRoot(prefix: string): { root: string; recDir: string; binDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const recDir = join(root, 'rec');
  const binDir = join(root, 'bin');
  mkdirSync(recDir);
  mkdirSync(binDir);
  return { root, recDir, binDir };
}

function killIfAlive(pid: number | null): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function recorder(root: string, recDir: string, binaryPath: string): Omit<FakeCodex, 'cleanup'> & { cleanup(): void } {
  const read = (name: string): string | null => {
    const file = join(recDir, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  const grandchildPid = (): number | null => {
    const text = read('grandchild.pid');
    const pid = text ? Number(text.trim()) : NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  return {
    root,
    binaryPath,
    recDir,
    read,
    argv: () => {
      const text = read('argv.txt');
      return text === null ? [] : text.replace(/\n$/, '').split('\n');
    },
    env: () => parseEnvDump(read('env.txt')),
    grandchildPid,
    cleanup: () => {
      killIfAlive(grandchildPid());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Fake `codex exec`: records argv/cwd/env/stdin, then replays a JSONL stream. */
export function createFakeCodex(options: FakeCodexOptions = {}): FakeCodex {
  const { root, recDir, binDir } = makeRoot('claude-mem-fake-codex-');
  const stdoutFile = join(root, 'stdout.jsonl');
  const stderrFile = join(root, 'stderr.txt');
  if (options.stdoutFixture) {
    writeFileSync(stdoutFile, readFileSync(options.stdoutFixture));
  } else {
    writeFileSync(stdoutFile, (options.stdoutLines ?? []).map((line) => line + '\n').join(''));
  }
  writeFileSync(stderrFile, options.stderrText ?? '');

  // Signal dispositions first, so a deadline can never beat them.
  const lines = ['#!/bin/sh', `REC=${shq(recDir)}`];
  if (options.ignoreSigint) lines.push(`trap '' INT`);
  if (options.recordSigint) lines.push(`trap 'echo INT >> "$REC/signals.txt"' INT`);
  lines.push(
    `printf '%s\\n' "$@" > "$REC/argv.txt"`,
    `pwd -P > "$REC/cwd.txt"`,
    `env > "$REC/env.txt"`,
    `echo "$$" > "$REC/pid.txt"`,
  );
  lines.push(`printf '%s\\n' 'Reading additional input from stdin...' >&2`);
  if (options.exitBeforeStdin) {
    // No `cat`: stdin is never drained and the process is gone before the
    // writer finishes, so a large prompt hits EPIPE.
    lines.push(`cat ${shq(stderrFile)} >&2`, `exit ${options.exitCode ?? 1}`, '');
  } else {
    lines.push(`cat > "$REC/stdin.txt"`, `: > "$REC/stdin-eof"`);
    if (options.hang || options.detachChild) {
      lines.push(`sleep 60 &`, `echo "$!" > "$REC/grandchild.pid"`);
    }
    lines.push(`cat ${shq(stdoutFile)}`, `cat ${shq(stderrFile)} >&2`);
    if (options.hang) lines.push('wait');
    if (options.selfSignal) lines.push(`kill -${options.selfSignal} $$`);
    lines.push(`exit ${options.exitCode ?? 0}`, '');
  }

  const binaryPath = join(binDir, 'codex');
  writeFileSync(binaryPath, lines.join('\n'));
  chmodSync(binaryPath, 0o755);
  assertInside(root, binaryPath);
  return recorder(root, recDir, binaryPath);
}

export interface FakeCodexProbeOptions {
  versionOutput?: string;
  loginStdout?: string;
  loginStderr?: string;
  loginExit?: number;
  featuresFixture?: string;
  promptInputFixture?: string;
  promptInputExit?: number;
  promptInputStderr?: string;
  /** Probe that sleeps instead of answering (for deadline tests). */
  hangOn?: 'version' | 'login' | 'features' | 'debug';
}

/** Fake codex answering the four self-check probes by argv[1]. */
export function createFakeCodexProbes(options: FakeCodexProbeOptions = {}): FakeCodex {
  const { root, recDir, binDir } = makeRoot('claude-mem-fake-codex-probes-');
  const files = {
    version: join(root, 'version.txt'),
    loginOut: join(root, 'login.out'),
    loginErr: join(root, 'login.err'),
    features: join(root, 'features.txt'),
    promptInput: join(root, 'prompt-input.json'),
    promptInputErr: join(root, 'prompt-input.err'),
  };
  writeFileSync(files.version, options.versionOutput ?? 'codex-cli 0.144.4\n');
  writeFileSync(files.loginOut, options.loginStdout ?? '');
  writeFileSync(files.loginErr, options.loginStderr ?? 'Logged in using ChatGPT\n');
  writeFileSync(files.features, readFileSync(options.featuresFixture ?? fixturePath('p0-features-list-locked.txt')));
  writeFileSync(files.promptInput, readFileSync(options.promptInputFixture ?? fixturePath('p0-prompt-input-locked.json')));
  writeFileSync(files.promptInputErr, options.promptInputStderr ?? '');

  const hang = (kind: string): string[] =>
    options.hangOn === kind ? [`sleep 60 &`, `echo "$!" > "$REC/grandchild.pid"`, 'wait'] : [];

  const lines = [
    '#!/bin/sh',
    `REC=${shq(recDir)}`,
    `printf '%s\\n' "$*" >> "$REC/calls.txt"`,
    `printf '%s\\n' "$@" > "$REC/argv-$1.txt"`,
    `pwd -P > "$REC/cwd.txt"`,
    `env > "$REC/env.txt"`,
    'case "$1" in',
    `  --version)`, ...hang('version').map((l) => `    ${l}`), `    cat ${shq(files.version)} ;;`,
    `  login)`, ...hang('login').map((l) => `    ${l}`),
    `    cat ${shq(files.loginOut)}`, `    cat ${shq(files.loginErr)} >&2`, `    exit ${options.loginExit ?? 0} ;;`,
    `  features)`, ...hang('features').map((l) => `    ${l}`), `    cat ${shq(files.features)} ;;`,
    // stdin must be /dev/null ('ignore'): an open pipe would block this cat.
    `  debug)`, ...hang('debug').map((l) => `    ${l}`),
    `    cat > "$REC/prompt-input-stdin.txt"`,
    `    cat ${shq(files.promptInput)}`, `    cat ${shq(files.promptInputErr)} >&2`, `    exit ${options.promptInputExit ?? 0} ;;`,
    `  *) printf 'unexpected probe\\n' >&2; exit 2 ;;`,
    'esac',
    'exit 0',
    '',
  ];
  const binaryPath = join(binDir, 'codex');
  writeFileSync(binaryPath, lines.join('\n'));
  chmodSync(binaryPath, 0o755);
  assertInside(root, binaryPath);
  const base = recorder(root, recDir, binaryPath);
  return {
    ...base,
    argv: () => [],
  };
}

/** Poll until `predicate` is true or the deadline passes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(stepMs);
  }
  return predicate();
}

/**
 * Fail closed on a pid the fake never recorded. `process.kill(null, 0)` throws
 * ERR_INVALID_ARG_TYPE, which is neither EPERM nor a live process, so without
 * this guard isPidAlive(null) would answer "not alive" and waitForPidGone
 * would pass vacuously - turning the only proof that the process group was
 * killed into a green no-op.
 */
function assertRealPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`needs a real pid; the fake never recorded one (got ${String(pid)})`);
  }
}

export function isPidAlive(pid: number): boolean {
  assertRealPid(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Wait for a (possibly zombie-then-reaped) pid to disappear. */
export async function waitForPidGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  assertRealPid(pid);
  return waitFor(() => !isPidAlive(pid), timeoutMs);
}
