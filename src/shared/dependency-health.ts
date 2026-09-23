export type DependencyStatusKind =
  | 'setup_required'
  /**
   * The dependency is installed and resolvable, but not signed in. Separate
   * from `setup_required` because the remedy is different (`codex login`, not
   * an install) and because the two carry different re-check economics: a
   * missing binary reappears by itself when the user installs it, a missing
   * login only ever comes back after a human does something.
   */
  | 'auth_required'
  | 'vector_search_unavailable';

export type DependencyName = 'claude_cli' | 'codex_cli' | 'uvx' | 'chroma';

export interface DependencyStatus {
  dependency: DependencyName;
  kind: DependencyStatusKind;
  message: string;
  remediation?: string;
  recordedAtMs: number;
}

export const CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

export const CLAUDE_CLI_SETUP_REMEDIATION =
  'Install or update Claude Code CLI, then restart claude-mem. Try `claude update`, ' +
  '`npm install -g @anthropic-ai/claude-code@latest`, or set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json.';

/**
 * How long a recorded `codex_cli` problem withholds further attempts before the
 * worker quietly re-checks, mirroring CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS.
 *
 * One window covers both `setup_required` and `auth_required`: the re-check for
 * either is the model-free self-check (`codex --version`, `features list`,
 * `login status`), which costs nothing against the user's plan, so there is no
 * reason to make a logged-out user wait longer than a user who has not
 * installed the CLI yet.
 */
export const CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

/**
 * Deliberately worded the same way as the CodexProvider `setup_required` error
 * action, so the session-start banner, the log line and /api/health all tell
 * the user to do the same thing.
 *
 * No "then restart claude-mem" (M3): the codex gate re-checks the binary and
 * the lockdown self-check on its own, and CLAUDE_MEM_CODEX_PATH is re-read on
 * every check. A restart would fix nothing the re-check does not, and it would
 * throw away the observations the gate is holding while it waits.
 */
export const CODEX_CLI_SETUP_REMEDIATION =
  'Install the Codex CLI or set CLAUDE_MEM_CODEX_PATH to the absolute native codex binary in ' +
  '~/.claude-mem/settings.json. The worker re-checks on its own; no restart is needed.';

export const CODEX_CLI_AUTH_REMEDIATION =
  'Run `codex login` and sign in with the ChatGPT account whose plan should run the memory observer. ' +
  'An API-key login is not accepted: it would bill your API account instead of your plan.';

export const UVX_VECTOR_SEARCH_REMEDIATION =
  'Install uv/uvx and make uvx visible to the worker PATH, then restart claude-mem. ' +
  'Try `curl -LsSf https://astral.sh/uv/install.sh | sh` or `brew install uv`.';

export const CHROMA_VECTOR_SEARCH_REMEDIATION =
  'Stop the other claude-mem worker using the same Chroma data directory, or configure a distinct ' +
  'CLAUDE_MEM_DATA_DIR / remote Chroma instance, then restart claude-mem.';

const statuses = new Map<DependencyName, DependencyStatus>();

export interface DependencyHealthSnapshot {
  degraded: boolean;
  statuses: DependencyStatus[];
}

export function recordDependencyStatus(
  dependency: DependencyName,
  kind: DependencyStatusKind,
  message: string,
  remediation?: string,
): DependencyStatus {
  const status: DependencyStatus = {
    dependency,
    kind,
    message,
    ...(remediation ? { remediation } : {}),
    recordedAtMs: Date.now(),
  };
  statuses.set(dependency, status);
  return status;
}

export function recordClaudeCliSetupRequired(message: string): DependencyStatus {
  return recordDependencyStatus('claude_cli', 'setup_required', message, CLAUDE_CLI_SETUP_REMEDIATION);
}

/** The Codex CLI could not be resolved, or its lockdown self-check failed. */
export function recordCodexCliSetupRequired(message: string): DependencyStatus {
  return recordDependencyStatus('codex_cli', 'setup_required', message, CODEX_CLI_SETUP_REMEDIATION);
}

/**
 * The Codex CLI is there but its login is missing, expired, or an API key.
 *
 * Recorded under the same `codex_cli` key as the setup case on purpose: the
 * gate asks one question ("is codex usable, and may I try again yet?"), and two
 * keys would let a stale setup record keep gating a binary that has since been
 * installed and merely needs a login.
 */
export function recordCodexAuthRequired(message: string): DependencyStatus {
  return recordDependencyStatus('codex_cli', 'auth_required', message, CODEX_CLI_AUTH_REMEDIATION);
}

export function recordUvxVectorSearchUnavailable(message: string): DependencyStatus {
  return recordDependencyStatus('uvx', 'vector_search_unavailable', message, UVX_VECTOR_SEARCH_REMEDIATION);
}

export function recordChromaVectorSearchUnavailable(message: string): DependencyStatus {
  return recordDependencyStatus('chroma', 'vector_search_unavailable', message, CHROMA_VECTOR_SEARCH_REMEDIATION);
}

export function clearDependencyStatus(dependency: DependencyName): void {
  statuses.delete(dependency);
}

export function getDependencyStatus(dependency: DependencyName): DependencyStatus | null {
  return statuses.get(dependency) ?? null;
}

export function isDependencyStatusInCooldown(
  status: DependencyStatus,
  cooldownMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - status.recordedAtMs < cooldownMs;
}

export function snapshotDependencyHealth(): DependencyHealthSnapshot {
  const currentStatuses = Array.from(statuses.values())
    .map(status => ({ ...status }))
    .sort((a, b) => a.dependency.localeCompare(b.dependency));
  return {
    degraded: currentStatuses.length > 0,
    statuses: currentStatuses,
  };
}

export function resetDependencyStatusesForTesting(): void {
  statuses.clear();
}
