import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import path from 'node:path';
import { runWorkerDependencyPreflight } from '../../src/services/worker/dependency-preflight.js';
import * as findCodex from '../../src/shared/find-codex-executable.js';
import * as selfCheck from '../../src/services/worker/codex/codex-self-check.js';
import {
  CODEX_CLI_AUTH_REMEDIATION,
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  CODEX_CLI_SETUP_REMEDIATION,
  getDependencyStatus,
  isDependencyStatusInCooldown,
  recordCodexAuthRequired,
  recordCodexCliSetupRequired,
  recordDependencyStatus,
  resetDependencyStatusesForTesting,
  snapshotDependencyHealth,
} from '../../src/shared/dependency-health.js';

function classifier(error: unknown): { kind: string; message: string } {
  return {
    kind: error instanceof Error && /Claude executable not found/.test(error.message)
      ? 'setup_required'
      : 'transient',
    message: error instanceof Error ? error.message : String(error),
  };
}

describe('worker dependency preflight', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('records missing uvx using PATH/file checks without checking Claude for Gemini', () => {
    let claudeChecked = false;

    const snapshot = runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_CHROMA_ENABLED: 'true',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        claudeChecked = true;
        throw new Error('Claude should not be checked for Gemini');
      },
      env: { PATH: '/tmp/no-uvx' },
      platform: 'linux',
      homedir: () => '/tmp/home',
      pathExists: () => false,
      isFile: () => false,
    });

    expect(claudeChecked).toBe(false);
    expect(snapshot.degraded).toBe(true);
    expect(getDependencyStatus('uvx')).toMatchObject({
      dependency: 'uvx',
      kind: 'vector_search_unavailable',
    });
    expect(getDependencyStatus('uvx')?.remediation).toContain('uv/uvx');
  });

  it('recognizes a Homebrew-only uvx install on darwin', () => {
    let claudeChecked = false;

    const snapshot = runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_CHROMA_ENABLED: 'true',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        claudeChecked = true;
        throw new Error('Claude should not be checked for Gemini');
      },
      env: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      homedir: () => '/tmp/home',
      pathExists: filePath => filePath === '/opt/homebrew/bin',
      isFile: filePath => filePath === path.join('/opt/homebrew/bin', 'uvx'),
    });

    expect(claudeChecked).toBe(false);
    expect(snapshot.degraded).toBe(false);
    expect(getDependencyStatus('uvx')).toBeNull();
  });

  it('clears stale Claude CLI setup status when a non-Claude provider is selected', () => {
    recordDependencyStatus('claude_cli', 'setup_required', 'old failure');

    runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        throw new Error('Claude should not be checked for OpenRouter');
      },
      env: { PATH: '' },
      platform: 'linux',
      homedir: () => '/tmp/home',
      pathExists: () => false,
      isFile: () => false,
    });

    expect(getDependencyStatus('claude_cli')).toBeNull();
  });

  it('records Claude CLI setup_required when Claude is selected and discovery fails', () => {
    runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'claude',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        throw new Error('Claude executable not found. Please install Claude Code CLI.');
      },
      env: { PATH: '' },
      platform: 'linux',
      homedir: () => '/tmp/home',
      pathExists: () => false,
      isFile: () => false,
    });

    expect(getDependencyStatus('claude_cli')).toMatchObject({
      dependency: 'claude_cli',
      kind: 'setup_required',
      message: 'Claude executable not found. Please install Claude Code CLI.',
    });
    expect(getDependencyStatus('claude_cli')?.remediation).toContain('Claude Code CLI');
  });

  /**
   * Plan 3.5, M3. The codex branch resolves the binary and NOTHING else.
   *
   * The thing these tests are really defending is the omission: the Codex
   * lockdown self-check spawns five probe subprocesses and is async, preflight
   * is synchronous and runs on the worker's boot path, so a self-check here
   * would put five process spawns in front of the worker's first route.
   */
  describe('codex provider', () => {
    function runCodexPreflight(findCodexExecutable: () => unknown, codexPath = '') {
      return runWorkerDependencyPreflight({
        settings: {
          CLAUDE_MEM_PROVIDER: 'codex',
          CLAUDE_MEM_CHROMA_ENABLED: 'false',
          CLAUDE_MEM_CODEX_PATH: codexPath,
        },
        classifyClaudeError: classifier,
        findClaudeExecutable: () => {
          throw new Error('Claude should not be checked for Codex');
        },
        findCodexExecutable,
        env: { PATH: '' },
        platform: 'linux',
        homedir: () => '/tmp/home',
        pathExists: () => false,
        isFile: () => false,
      });
    }

    it('records codex_cli setup_required when the binary cannot be resolved', () => {
      const snapshot = runCodexPreflight(() => {
        throw new Error('No usable codex binary found on PATH');
      });

      expect(snapshot.degraded).toBe(true);
      expect(getDependencyStatus('codex_cli')).toMatchObject({
        dependency: 'codex_cli',
        kind: 'setup_required',
      });
      expect(getDependencyStatus('codex_cli')?.message).toContain('No usable codex binary found on PATH');
      expect(getDependencyStatus('codex_cli')?.remediation).toContain('CLAUDE_MEM_CODEX_PATH');
    });

    it('clears codex_cli once the binary resolves, and never checks Claude', () => {
      recordDependencyStatus('codex_cli', 'setup_required', 'old failure');
      let resolved = 0;

      const snapshot = runCodexPreflight(() => {
        resolved += 1;
        return { path: '/usr/local/bin/codex' };
      });

      expect(resolved).toBe(1);
      expect(snapshot.degraded).toBe(false);
      expect(getDependencyStatus('codex_cli')).toBeNull();
      expect(getDependencyStatus('claude_cli')).toBeNull();
    });

    it('passes CLAUDE_MEM_CODEX_PATH through to resolution', () => {
      // The configured path is authoritative and fails closed in
      // findCodexExecutable; preflight must not quietly drop it and report on
      // some other codex it found on PATH instead. The seam receives exactly
      // the options preflight resolves with.
      let seen: unknown = null;
      runWorkerDependencyPreflight({
        settings: {
          CLAUDE_MEM_PROVIDER: 'codex',
          CLAUDE_MEM_CHROMA_ENABLED: 'false',
          CLAUDE_MEM_CODEX_PATH: '/opt/codex/bin/codex',
        },
        classifyClaudeError: classifier,
        findClaudeExecutable: () => {
          throw new Error('Claude should not be checked for Codex');
        },
        findCodexExecutable: (options) => {
          seen = options.explicitPath;
          return { path: '/opt/codex/bin/codex' };
        },
        env: { PATH: '' },
        platform: 'linux',
        homedir: () => '/tmp/home',
        pathExists: () => false,
        isFile: () => false,
      });

      expect(seen).toBe('/opt/codex/bin/codex');
    });

    it('the production resolver receives the configured path when no seam is injected', () => {
      const resolve = spyOn(findCodex, 'findCodexExecutable').mockReturnValue({ path: '/opt/codex/bin/codex' } as never);
      try {
        runWorkerDependencyPreflight({
          settings: {
            CLAUDE_MEM_PROVIDER: 'codex',
            CLAUDE_MEM_CHROMA_ENABLED: 'false',
            CLAUDE_MEM_CODEX_PATH: '/opt/codex/bin/codex',
          },
          classifyClaudeError: classifier,
          findClaudeExecutable: () => {
            throw new Error('Claude should not be checked for Codex');
          },
          env: { PATH: '' },
          platform: 'linux',
          homedir: () => '/tmp/home',
          pathExists: () => false,
          isFile: () => false,
        });

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith({ explicitPath: '/opt/codex/bin/codex' });
        expect(getDependencyStatus('codex_cli')).toBeNull();

        // Unset means "search", which is findCodexExecutable's empty path.
        runWorkerDependencyPreflight({
          settings: { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CHROMA_ENABLED: 'false' },
          classifyClaudeError: classifier,
          env: { PATH: '' },
          platform: 'linux',
          homedir: () => '/tmp/home',
          pathExists: () => false,
          isFile: () => false,
        });
        expect(resolve).toHaveBeenLastCalledWith({ explicitPath: '' });
      } finally {
        resolve.mockRestore();
      }
    });

    it('does not run the lockdown self-check — resolution is the only probe', () => {
      // The self-check spawns five probes and is async; on the boot path it
      // would hold the worker shut. Spied on the real module, so a preflight
      // that started one — awaited or not — is caught here. Never-settling
      // stand-ins: if it WERE called, nothing may spawn.
      const verify = spyOn(selfCheck, 'verifyCodexLockdown')
        .mockImplementation((() => new Promise(() => {})) as never);
      const status = spyOn(selfCheck, 'getCodexLockdownStatus');
      const passed = spyOn(selfCheck, 'isCodexLockdownPassed');
      try {
        const calls: string[] = [];
        const snapshot = runCodexPreflight(() => {
          calls.push('resolve');
          return { path: '/usr/local/bin/codex' };
        });

        expect(calls).toEqual(['resolve']);
        // Synchronous: a snapshot object, never a promise.
        expect(snapshot).not.toBeInstanceOf(Promise);
        expect(snapshot.statuses).toEqual([]);
        expect(verify).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(passed).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
        status.mockRestore();
        passed.mockRestore();
      }
    });

    it('clears a stale codex_cli status when a non-codex provider is selected', () => {
      recordDependencyStatus('codex_cli', 'auth_required', 'logged out');

      runWorkerDependencyPreflight({
        settings: {
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_CHROMA_ENABLED: 'false',
        },
        classifyClaudeError: classifier,
        findClaudeExecutable: () => {
          throw new Error('Claude should not be checked for OpenRouter');
        },
        findCodexExecutable: () => {
          throw new Error('Codex should not be checked for OpenRouter');
        },
        env: { PATH: '' },
        platform: 'linux',
        homedir: () => '/tmp/home',
        pathExists: () => false,
        isFile: () => false,
      });

      expect(getDependencyStatus('codex_cli')).toBeNull();
    });

    it('clears a stale codex_cli status when Claude is selected', () => {
      recordDependencyStatus('codex_cli', 'setup_required', 'no codex');

      runWorkerDependencyPreflight({
        settings: {
          CLAUDE_MEM_PROVIDER: 'claude',
          CLAUDE_MEM_CHROMA_ENABLED: 'false',
        },
        classifyClaudeError: classifier,
        findClaudeExecutable: () => '/usr/local/bin/claude',
        findCodexExecutable: () => {
          throw new Error('Codex should not be checked for Claude');
        },
        env: { PATH: '' },
        platform: 'linux',
        homedir: () => '/tmp/home',
        pathExists: () => false,
        isFile: () => false,
      });

      expect(getDependencyStatus('codex_cli')).toBeNull();
      expect(getDependencyStatus('claude_cli')).toBeNull();
    });
  });
});

/**
 * The dependency-health entries the codex gate (SessionRoutes) and the
 * session-start banner read. Both statuses land on ONE key, `codex_cli`,
 * because the gate asks a single question of it.
 */
describe('codex dependency health entries', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('records setup_required with the install/CLAUDE_MEM_CODEX_PATH remediation', () => {
    const status = recordCodexCliSetupRequired('codex binary not found');

    expect(status).toMatchObject({ dependency: 'codex_cli', kind: 'setup_required' });
    expect(status.remediation).toBe(CODEX_CLI_SETUP_REMEDIATION);
    expect(CODEX_CLI_SETUP_REMEDIATION).toContain('CLAUDE_MEM_CODEX_PATH');
    expect(CODEX_CLI_SETUP_REMEDIATION).toContain('Codex CLI');
  });

  it('records auth_required with the `codex login` remediation', () => {
    const status = recordCodexAuthRequired('not logged in');

    expect(status).toMatchObject({ dependency: 'codex_cli', kind: 'auth_required' });
    expect(status.remediation).toBe(CODEX_CLI_AUTH_REMEDIATION);
    expect(CODEX_CLI_AUTH_REMEDIATION).toContain('codex login');
  });

  it('replaces rather than accumulates, so a fixed install is not still gated by the old status', () => {
    recordCodexCliSetupRequired('codex binary not found');
    recordCodexAuthRequired('not logged in');

    expect(getDependencyStatus('codex_cli')?.kind).toBe('auth_required');
    expect(snapshotDependencyHealth().statuses.filter(s => s.dependency === 'codex_cli')).toHaveLength(1);
  });

  it('surfaces codex_cli through the snapshot /api/health reads', () => {
    recordCodexAuthRequired('not logged in');

    const snapshot = snapshotDependencyHealth();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.statuses.map(s => s.dependency)).toContain('codex_cli');
  });

  it('honours the recheck cooldown the gate uses to stop per-tool-call spawns', () => {
    const status = recordCodexCliSetupRequired('codex binary not found');

    expect(isDependencyStatusInCooldown(
      status,
      CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
      status.recordedAtMs + CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS - 1,
    )).toBe(true);
    expect(isDependencyStatusInCooldown(
      status,
      CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
      status.recordedAtMs + CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS + 1,
    )).toBe(false);
  });
});
