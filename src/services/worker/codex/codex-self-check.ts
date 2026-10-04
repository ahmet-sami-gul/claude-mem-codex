/**
 * Codex lockdown self-check (plan 2.10, 5/L3).
 *
 * Five model-free probes, run in order and stopping at the first failure:
 *
 *   1. `codex --version`: parsed and checked against the tested range
 *      (>=0.160.0 <0.161) unless allowUntestedVersion is set. The version is
 *      recorded on the binary fingerprint (find-codex-executable.ts). An exec
 *      model (the observer model, or a different summary model) with a
 *      CODEX_MODEL_MIN_CLI_VERSION floor above the installed version fails
 *      here too (model_needs_newer_cli), and allowUntestedVersion does NOT
 *      bypass that.
 *   2. `codex login status`: stderr must say "Logged in using ChatGPT"
 *      (Phase 0: exit 0, stdout empty). An API-key login is rejected:
 *      billing would silently move to the API.
 *   3. `codex debug models`: the model catalog, from the same CODEX_HOME.
 *      Every exec model must be listed, its experimental_supported_tools
 *      must be within CODEX_ACCEPTED_EXPERIMENTAL_TOOLS and its tool_mode
 *      absent, null or `code_mode_only`. Catalog-granted tools have no
 *      feature or config gate, so this is the only probe that sees them.
 *      Unlike exec, `debug models` loads that home's config.toml (it has no
 *      --ignore-user-config): `model_catalog_json` there replaces the catalog
 *      outright, so it fails this step closed; `model_provider` or a base URL
 *      there can still point it at another catalog source than exec's.
 *   4. `codex features list <exec pins> <exec disables>`: every enabled
 *      feature must be one of CODEX_EXPECTED_ENABLED_FEATURES, in the
 *      "removed" stage, or one of CODEX_FORCED_ENABLED_FEATURES while
 *      shell_tool is disabled, and every name we --disable must be listed
 *      (known).
 *   5. `codex debug prompt-input -c model=... <exec pins> <exec disables>
 *      CLAUDE_MEM_CODEX_CANARY`: the items must be exactly
 *      [developer == CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS, user == canary],
 *      rendered for the observer model. prompt-input and features list load
 *      the user's config.toml, so this is stricter than exec but not
 *      byte-for-byte equivalent (plan 2.10).
 *
 * Every probe runs with the same env as exec (buildCodexObserverEnv, same
 * CODEX_HOME), stdio ['ignore','pipe','pipe'] (stdin is /dev/null, so no
 * probe can block on it), a 5-15 s deadline and the jail cwd
 * OBSERVER_SESSIONS_DIR/codex-selfcheck, which passes the same jail check as
 * the exec cwd. All of it is async; nothing here is spawnSync, so boot and
 * ingest are never blocked.
 *
 * States: 'pending' (in flight), 'passed', 'failed'. Results are cached per
 * binary fingerprint (realpath + mtime + size) plus the model / summary model /
 * effort / verbosity / allow-untested inputs, the CLAUDE_MEM_CODEX_HOME
 * setting, the EFFECTIVE CODEX_HOME and that home's auth.json (mtime + size),
 * so a replaced binary or a re-login is re-verified; a finished result also
 * expires after CODEX_SELF_CHECK_MAX_AGE_MS so a long-lived worker re-proves
 * the ChatGPT login (and re-reads the model catalog, which is not part of the
 * key). Calls are single-flight per key and never reject. "pending"
 * and "never run" are NEVER treated as passed: isCodexLockdownPassed() is
 * true only for a finished, passing check of the current fingerprint.
 *
 * Wired in M3 through the route's codex gate (session/codex-readiness-gate.ts,
 * via CodexProvider.verifyLockdown): the gate starts the check in the
 * background, never awaits it on the ingest path, and turns a failed verdict
 * into a codex_cli dependency record plus an observer-health record. Status
 * readers use getCodexAuthMethodDescription().
 */

import { existsSync, readFileSync, realpathSync, statSync, type Stats } from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { logger } from '../../../utils/logger.js';
import { recordObserverToolAttempt } from '../../../utils/observer-audit.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { spawnHidden } from '../../../shared/spawn.js';
import { ensureDir, OBSERVER_SESSIONS_DIR } from '../../../shared/paths.js';
import { recordCodexBinaryVersion } from '../../../shared/find-codex-executable.js';
import type { ClassifiedProviderError } from '../provider-errors.js';
import {
  assertCodexProbeArgvSafe,
  buildCodexProbeArgs,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_DEFAULT_VERBOSITY,
  CODEX_DISABLED_FEATURES,
  CODEX_EXPECTED_ENABLED_FEATURES,
  CODEX_FORCED_ENABLED_FEATURES,
  CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS,
  CODEX_PROBE_CANARY,
  codexModelMinCliVersion,
  type CodexProbeKind,
} from './codex-invocation.js';
import { buildCodexObserverEnv, resolveCodexHome, type CodexEnvSettings } from './codex-env.js';
import { classifyCodexFailure, redactCodexDiagnostic, type CodexRunnerCondition } from './codex-errors.js';
import { assertCodexJailSafe, killCodexProcessGroup } from './codex-exec-runner.js';
import type { CodexReasoningEffort, CodexVerbosity } from './codex-transport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tested codex-cli range, until re-validated (plan 2.10). Re-validated on
 * 0.160.0 (model-free probes plus paid canaries); 0.157-0.159 were never
 * tested, and 0.144.x is refused because the 0.156 disables and pins are
 * unknown there.
 */
export const CODEX_TESTED_VERSION_RANGE = Object.freeze({
  minInclusive: [0, 160, 0] as const,
  maxExclusive: [0, 161, 0] as const,
  label: '>=0.160.0 <0.161',
});

/**
 * Probe deadlines (plan 2.10: 5-10 s). The catalog probe gets 15 s because it
 * may refresh the catalog over the network when it is not cached yet.
 */
export const CODEX_PROBE_TIMEOUTS_MS: Readonly<Record<CodexProbeKind, number>> = Object.freeze({
  version: 5_000,
  login_status: 10_000,
  models_catalog: 15_000,
  features_list: 10_000,
  prompt_input: 10_000,
});

/** Probe output caps; oversized output fails parsing (fail closed). */
export const CODEX_PROBE_MAX_STDOUT_BYTES = 1024 * 1024;
export const CODEX_PROBE_MAX_STDERR_BYTES = 64 * 1024;

/** After exit (or a deadline kill), how long to wait for the probe's pipes to close. */
export const CODEX_PROBE_DRAIN_MS = 2_000;

/** Jail cwd for the probes. */
export const CODEX_SELF_CHECK_DIRNAME = 'codex-selfcheck';

/** The probes, in the order they run (the self-check stops at the first failure). */
export const CODEX_PROBE_ORDER: readonly CodexProbeKind[] = Object.freeze([
  'version',
  'login_status',
  'models_catalog',
  'features_list',
  'prompt_input',
] as const);

/**
 * Experimental tools an exec model's catalog entry may grant (0.156.1:
 * the GPT-6 entries grant exactly these two). They have no feature or config
 * gate, so they are accepted on these grounds, and anything else fails the
 * catalog probe closed:
 *   - `clock`: its clock.sleep tool is off through `--disable=sleep_tool`;
 *     clock.curr_time only reads the clock (no command, file or network) and
 *     on code_mode_only models (every current entry granting it) is only
 *     reachable through code-mode exec, which fails closed with
 *     code_mode_host disabled.
 *   - `send_user_message_async`: registers request_user_input_async, which
 *     has no gate on 0.156.1 and produces only text (no command, file or
 *     network). exec emits that text as an ordinary agent_message; the
 *     single-answer rule in codex-jsonl.ts keeps only the turn's LAST
 *     agent_message as the reply and audits a turn that had more than one.
 */
export const CODEX_ACCEPTED_EXPERIMENTAL_TOOLS = Object.freeze(['send_user_message_async', 'clock'] as const);

/** Catalog tool_mode values accepted besides absent / null (Direct). */
const ACCEPTED_TOOL_MODES: ReadonlySet<string> = new Set(['code_mode_only']);

/** Stage column values of `codex features list` (0.156.1 cli/src/main.rs). */
const FEATURE_STAGES: ReadonlySet<string> = new Set(['under development', 'experimental', 'stable', 'deprecated', 'removed']);

/** Feature keys, dotted for sub-features (0.156.1 lists `guardianv2.thread_context`). */
const FEATURE_NAME_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/**
 * A `model_catalog_json` key in config.toml, in any table (a profile included).
 * `codex debug models` then prints that file instead of the catalog exec loads
 * (exec runs with --ignore-user-config). Matched on the raw text: a false
 * match only fails the catalog probe closed.
 */
const CATALOG_OVERRIDE_KEY_RE = /^[ \t]*(?:[A-Za-z0-9_.-]+\.)?["']?model_catalog_json["']?[ \t]*=/m;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexLockdownState = 'pending' | 'passed' | 'failed';

export type CodexSelfCheckStep = 'fingerprint' | 'jail' | CodexProbeKind;

export type CodexAuthMethod = 'chatgpt' | 'api_key' | 'not_logged_in' | 'unknown';

export interface CodexLockdownFailure {
  step: CodexSelfCheckStep;
  error: ClassifiedProviderError;
}

export interface CodexLockdownResult {
  state: CodexLockdownState;
  binaryPath: string;
  /** Null when the binary could not be fingerprinted. */
  cacheKey: string | null;
  version: string | null;
  authMethod: CodexAuthMethod;
  failure: CodexLockdownFailure | null;
  warnings: string[];
  startedAt: number;
  finishedAt: number | null;
}

export interface CodexProbeRequest {
  kind: CodexProbeKind;
  binaryPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface CodexProbeResponse {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started. */
  spawnError?: string;
}

export type CodexProbeRunner = (request: CodexProbeRequest) => Promise<CodexProbeResponse>;

export interface VerifyCodexLockdownOptions {
  /** Observer model the canary is rendered for; defaults to CODEX_DEFAULT_MODEL. */
  model?: string;
  /**
   * Model the summary and wrap-up execs run (CLAUDE_MEM_CODEX_SUMMARY_MODEL);
   * empty or absent means `model`. A different one gets the model/CLI gate
   * and the catalog check too.
   */
  summaryModel?: string;
  effort?: CodexReasoningEffort;
  verbosity?: CodexVerbosity;
  /** CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION (file/env only). */
  allowUntestedVersion?: boolean;
  /** CLAUDE_MEM_CODEX_HOME etc. (file/env only). */
  envSettings?: CodexEnvSettings;
  /** Test seam; defaults to createCodexProbeRunner(envSettings). */
  probeRunner?: CodexProbeRunner;
  /** Defaults to OBSERVER_SESSIONS_DIR/codex-selfcheck. */
  jailDir?: string;
  timeouts?: Partial<Record<CodexProbeKind, number>>;
  /** Ignore a finished cached result (the M3 re-check); joins an in-flight run. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Pure evaluators
// ---------------------------------------------------------------------------

export interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  /** Normalised `major.minor.patch[-prerelease]`. */
  raw: string;
}

const VERSION_RE = /(?:^|[^\d.])(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?/;

/** Parse `codex-cli 0.144.4` (or a bare `0.144.4`). Null when no version is present. */
export function parseCodexVersion(output: string): CodexVersion | null {
  if (typeof output !== 'string') return null;
  const match = VERSION_RE.exec(output.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] ?? null;
  return { major, minor, patch, prerelease, raw: `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}` };
}

function compareTriple(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * True for versions inside CODEX_TESTED_VERSION_RANGE. A prerelease of any
 * version is untested (semver orders 0.144.4-alpha below 0.144.4).
 */
export function isCodexVersionTested(version: CodexVersion): boolean {
  if (version.prerelease) return false;
  const triple = [version.major, version.minor, version.patch];
  return compareTriple(triple, CODEX_TESTED_VERSION_RANGE.minInclusive) >= 0
    && compareTriple(triple, CODEX_TESTED_VERSION_RANGE.maxExclusive) < 0;
}

export interface CodexFeatureRow {
  name: string;
  stage: string;
  enabled: boolean;
}

/**
 * Parse `codex features list` (`<name> <stage words...> <true|false>`).
 * Returns null when any non-blank line does not fit (including a stage outside
 * the known set), so a format change fails closed instead of being half-read.
 */
export function parseCodexFeaturesList(output: string): CodexFeatureRow[] | null {
  if (typeof output !== 'string') return null;
  const rows: CodexFeatureRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) return null;
    const name = tokens[0];
    const flag = tokens[tokens.length - 1];
    if (!FEATURE_NAME_RE.test(name) || (flag !== 'true' && flag !== 'false')) return null;
    const stage = tokens.slice(1, -1).join(' ');
    if (!FEATURE_STAGES.has(stage)) return null;
    rows.push({ name, stage, enabled: flag === 'true' });
  }
  return rows.length > 0 ? rows : null;
}

export type CodexFeaturesEvaluation =
  | { ok: true }
  | { ok: false; reason: string; unexpectedEnabled: string[]; unknownDisabled: string[] };

/**
 * Only CODEX_EXPECTED_ENABLED_FEATURES or "removed"-stage flags may be on, plus
 * CODEX_FORCED_ENABLED_FEATURES while a shell_tool row exists and is disabled;
 * every disable must be known.
 */
export function evaluateCodexFeatures(rows: readonly CodexFeatureRow[]): CodexFeaturesEvaluation {
  const expected = new Set<string>(CODEX_EXPECTED_ENABLED_FEATURES);
  const forced = new Set<string>(CODEX_FORCED_ENABLED_FEATURES);
  const shellToolRows = rows.filter((row) => row.name === 'shell_tool');
  const shellToolDisabled = shellToolRows.length > 0 && shellToolRows.every((row) => !row.enabled);
  const enabled = rows.filter((row) => row.enabled && row.stage !== 'removed' && !expected.has(row.name));
  const unexpectedEnabled = enabled
    .filter((row) => !(forced.has(row.name) && shellToolDisabled))
    .map((row) => row.name);
  const forcedWithShell = unexpectedEnabled.filter((name) => forced.has(name));
  const listed = new Set(rows.map((row) => row.name));
  const unknownDisabled = CODEX_DISABLED_FEATURES.filter((name) => !listed.has(name));
  if (unexpectedEnabled.length === 0 && unknownDisabled.length === 0) return { ok: true };
  const parts: string[] = [];
  if (unexpectedEnabled.length > 0) parts.push(`still enabled: ${unexpectedEnabled.join(', ')}`);
  if (forcedWithShell.length > 0) {
    parts.push(
      `${forcedWithShell.join(', ')} cannot be turned off and is tolerated only while shell_tool is disabled, `
      + `but shell_tool is ${shellToolRows.length === 0 ? 'not listed' : 'enabled'}`,
    );
  }
  if (unknownDisabled.length > 0) parts.push(`unknown --disable names: ${unknownDisabled.join(', ')}`);
  return { ok: false, reason: parts.join('; '), unexpectedEnabled, unknownDisabled };
}

export type CodexModelCatalogEvaluation = { ok: true } | { ok: false; reason: string };

/** A catalog-controlled value, bounded for a failure reason. */
function describeCatalogValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

/**
 * `codex debug models` prints `{"models":[...]}`. Fails closed when the output
 * is not that shape, when `model` has no entry, when an entry for it grants an
 * experimental tool outside CODEX_ACCEPTED_EXPERIMENTAL_TOOLS, or when its
 * tool_mode is anything but absent, null or `code_mode_only`.
 */
export function evaluateCodexModelCatalog(output: string, model: string): CodexModelCatalogEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof output === 'string' ? output.trim() : '');
  } catch {
    // [ANTI-PATTERN IGNORED]: unparseable probe output is the documented fail-closed result.
    return { ok: false, reason: 'debug models output is not JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return { ok: false, reason: 'debug models output has no models list' };
  }
  const entries = parsed.models.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.slug === model);
  if (entries.length === 0) return { ok: false, reason: `${model} is not in the Codex model catalog` };

  const accepted = new Set<string>(CODEX_ACCEPTED_EXPERIMENTAL_TOOLS);
  for (const entry of entries) {
    const tools = entry.experimental_supported_tools;
    if (tools !== undefined && tools !== null) {
      if (!Array.isArray(tools)) {
        return { ok: false, reason: `${model}: experimental_supported_tools is not a list` };
      }
      const extra = tools.filter((tool) => typeof tool !== 'string' || !accepted.has(tool));
      if (extra.length > 0) {
        return { ok: false, reason: `${model}: the catalog grants experimental tools outside the accepted set: ${extra.map(describeCatalogValue).join(', ')}` };
      }
    }
    const toolMode = entry.tool_mode;
    if (toolMode !== undefined && toolMode !== null && !(typeof toolMode === 'string' && ACCEPTED_TOOL_MODES.has(toolMode))) {
      return { ok: false, reason: `${model}: unexpected tool_mode ${describeCatalogValue(toolMode)}` };
    }
  }
  return { ok: true };
}

export type CodexPromptInputEvaluation = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of a `message` item with the given role, or null when the shape differs. */
function messageText(item: unknown, role: string): string | null {
  if (!isRecord(item) || item.type !== 'message' || item.role !== role) return null;
  if (!Array.isArray(item.content) || item.content.length === 0) return null;
  let text = '';
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== 'input_text' || typeof part.text !== 'string') return null;
    text += part.text;
  }
  return text;
}

function describeItem(item: unknown): string {
  if (!isRecord(item)) return typeof item;
  return `${String(item.type)}/${String(item.role ?? '-')}`;
}

/**
 * The canary must yield exactly [developer == CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS,
 * user == CODEX_PROBE_CANARY]. Any extra item (skills, permissions, AGENTS.md,
 * environment context, multi-agent hints) is a lockdown failure. Extra fields
 * on an item (0.156.1 adds an id and metadata) are ignored.
 *
 * The canary shows input items only, never the tool list; catalog-granted
 * tools are covered by the models_catalog probe (evaluateCodexModelCatalog).
 */
export function evaluateCodexPromptInput(output: string): CodexPromptInputEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof output === 'string' ? output.trim() : '');
  } catch {
    // [ANTI-PATTERN IGNORED]: unparseable probe output is the documented fail-closed result.
    return { ok: false, reason: 'prompt-input output is not JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'prompt-input output is not a JSON array' };
  if (parsed.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly [developer, user], got ${parsed.length} items (${parsed.map(describeItem).join(', ')})`,
    };
  }
  const developer = messageText(parsed[0], 'developer');
  if (developer === null) return { ok: false, reason: `first item is ${describeItem(parsed[0])}, expected a developer message` };
  if (developer !== CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS) {
    return { ok: false, reason: 'developer item differs from CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS' };
  }
  const user = messageText(parsed[1], 'user');
  if (user === null) return { ok: false, reason: `second item is ${describeItem(parsed[1])}, expected a user message` };
  if (user !== CODEX_PROBE_CANARY) return { ok: false, reason: 'user item is not the canary' };
  return { ok: true };
}

export type CodexLoginEvaluation =
  | { ok: true; authMethod: 'chatgpt' }
  | { ok: false; authMethod: CodexAuthMethod; error: ClassifiedProviderError };

/**
 * `codex login status` prints its verdict on stderr (Phase 0: exit 0, stdout
 * empty, stderr "Logged in using ChatGPT"). An API-key login anywhere in the
 * output is rejected.
 */
export function evaluateCodexLoginStatus(response: Pick<CodexProbeResponse, 'exitCode' | 'stdout' | 'stderr'>): CodexLoginEvaluation {
  const combined = `${response.stdout}\n${response.stderr}`;
  if (/logged in using an api key/i.test(combined)) {
    return { ok: false, authMethod: 'api_key', error: conditionError('api_key_login', 'login status reports an API-key login') };
  }
  if (response.exitCode === 0 && /Logged in using ChatGPT/.test(response.stderr)) {
    return { ok: true, authMethod: 'chatgpt' };
  }
  if (/\bnot logged in\b/i.test(combined)) {
    const outcome = classifyCodexFailure({ failureMessage: 'Not logged in', exitCode: response.exitCode });
    if (outcome.type === 'error') return { ok: false, authMethod: 'not_logged_in', error: outcome.error };
  }
  return {
    ok: false,
    authMethod: 'unknown',
    error: conditionError('self_check_failed', `login status did not report a ChatGPT login (exit ${String(response.exitCode)})`),
  };
}

// ---------------------------------------------------------------------------
// Default probe runner
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conditionError(condition: CodexRunnerCondition, detail?: string): ClassifiedProviderError {
  const outcome = classifyCodexFailure({ condition, detail: detail ?? null });
  if (outcome.type !== 'error') {
    throw new Error(`codex condition ${condition} did not classify as an error`);
  }
  return outcome.error;
}

/**
 * Real probe runner: async spawn with the codex env allowlist, stdin ignored,
 * the process group SIGKILLed at the deadline. Never rejects.
 */
export function createCodexProbeRunner(envSettings: CodexEnvSettings = {}): CodexProbeRunner {
  return (request) => new Promise<CodexProbeResponse>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let child: ChildProcess;

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, ...(spawnError ? { spawnError } : {}) });
    };

    /** Something outside our reach still holds the pipes: stop waiting for 'close'. */
    const armDrain = (): void => {
      if (drainTimer || settled) return;
      drainTimer = setTimeout(() => {
        if (child.pid) killCodexProcessGroup(child.pid, child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exitCode, exitSignal);
      }, CODEX_PROBE_DRAIN_MS);
    };

    try {
      assertCodexProbeArgvSafe(request.args);
      child = spawnHidden(request.binaryPath, request.args, {
        cwd: request.cwd,
        env: buildCodexObserverEnv(sanitizeEnv(process.env), envSettings),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error: unknown) {
      spawnError = errorMessage(error);
      settle(null, null);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= CODEX_PROBE_MAX_STDOUT_BYTES) return;
      const room = CODEX_PROBE_MAX_STDOUT_BYTES - stdoutBytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdoutBytes += slice.length;
      stdout += slice.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= CODEX_PROBE_MAX_STDERR_BYTES) return;
      const room = CODEX_PROBE_MAX_STDERR_BYTES - stderrBytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrBytes += slice.length;
      stderr += slice.toString('utf8');
    });
    child.on('error', (error: Error) => {
      spawnError = error.message;
      if (!child.pid) settle(null, null);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      armDrain();
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killCodexProcessGroup(child.pid, child, 'SIGKILL');
      armDrain();
    }, request.timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Cache and single-flight
// ---------------------------------------------------------------------------

interface InFlight {
  placeholder: CodexLockdownResult;
  promise: Promise<CodexLockdownResult>;
}

const inFlight = new Map<string, InFlight>();
const completed = new Map<string, CodexLockdownResult>();
let lastResult: CodexLockdownResult | null = null;

/**
 * How long a finished result is reused. The key already changes when the
 * binary, the inputs or the auth file change, but a long-lived worker should
 * still re-verify the login periodically: the probes are model-free and cheap
 * (five short subprocesses), so a stale "ChatGPT login" verdict is never worth
 * more than an hour.
 *
 * The model catalog is deliberately not in the key. codex refreshes it on its
 * own (a 300 s cache TTL, or a new models etag on a response), so a catalog
 * that changes after a pass is only seen by the next check, at most this long
 * later. Keying on models_cache.json would re-run the check every few minutes
 * (codex rewrites it on each refresh) and hold the observer meanwhile.
 */
export const CODEX_SELF_CHECK_MAX_AGE_MS = 60 * 60_000;

function freshCompleted(key: string, nowMs: number): CodexLockdownResult | null {
  const done = completed.get(key);
  if (!done) return null;
  if (nowMs - (done.finishedAt ?? done.startedAt) > CODEX_SELF_CHECK_MAX_AGE_MS) {
    completed.delete(key);
    return null;
  }
  return done;
}

interface ResolvedOptions {
  model: string;
  summaryModel: string;
  effort: CodexReasoningEffort;
  verbosity: CodexVerbosity;
  allowUntestedVersion: boolean;
  envSettings: CodexEnvSettings;
}

function resolveOptions(options: VerifyCodexLockdownOptions): ResolvedOptions {
  const model = options.model ?? CODEX_DEFAULT_MODEL;
  return {
    model,
    summaryModel: options.summaryModel || model,
    effort: options.effort ?? CODEX_DEFAULT_REASONING_EFFORT,
    verbosity: options.verbosity ?? CODEX_DEFAULT_VERBOSITY,
    allowUntestedVersion: options.allowUntestedVersion === true,
    envSettings: options.envSettings ?? {},
  };
}

/** Every model an exec may run: the observer model, then a different summary model. */
function execModels(resolved: ResolvedOptions): string[] {
  return resolved.summaryModel === resolved.model ? [resolved.model] : [resolved.model, resolved.summaryModel];
}

/** `model` as a failure message names it. */
function describeExecModel(resolved: ResolvedOptions, model: string): string {
  return model === resolved.model ? model : `summary model ${model}`;
}

interface Fingerprint {
  realpath: string;
  mtimeMs: number;
  size: number;
}

function fingerprintOf(binaryPath: string): Fingerprint {
  if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) {
    throw new Error('the Codex binary path must be absolute');
  }
  const real = realpathSync(binaryPath);
  const stat: Stats = statSync(real);
  if (!stat.isFile()) throw new Error(`${real} is not a regular file`);
  return { realpath: real, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * Fingerprint of the login the probes would verify: the EFFECTIVE CODEX_HOME
 * (not just CLAUDE_MEM_CODEX_HOME) plus auth.json's mtime and size. The
 * login_status probe is the only thing proving a ChatGPT (plan-billed) login
 * rather than an API key, so a `codex login --with-api-key` or a replaced
 * auth.json must invalidate the cached pass instead of leaving
 * isCodexLockdownPassed() true while billing silently moves to the API.
 */
function authFingerprint(options: ResolvedOptions): string {
  let home: string;
  try {
    home = resolveCodexHome(options.envSettings, sanitizeEnv(process.env));
  } catch {
    // [ANTI-PATTERN IGNORED]: an unusable CODEX_HOME fails every probe anyway; the
    // key only has to be stable, and the configured value makes it so.
    return `unresolved\u0000${options.envSettings.CLAUDE_MEM_CODEX_HOME ?? ''}`;
  }
  try {
    const stat = statSync(path.join(home, 'auth.json'));
    return `${home}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  } catch {
    // [ANTI-PATTERN IGNORED]: a missing auth.json is the ordinary not-logged-in
    // state; it keys as "no auth file" and the login probe reports it.
    return `${home}\u0000none`;
  }
}

function cacheKeyOf(fingerprint: Fingerprint, options: ResolvedOptions): string {
  return [
    fingerprint.realpath,
    fingerprint.mtimeMs,
    fingerprint.size,
    options.model,
    options.summaryModel,
    options.effort,
    options.verbosity,
    options.allowUntestedVersion ? 'allow-untested' : 'tested-only',
    options.envSettings.CLAUDE_MEM_CODEX_HOME ?? '',
    authFingerprint(options),
  ].join('\u0000');
}

function currentKey(binaryPath: string, options: VerifyCodexLockdownOptions): string | null {
  try {
    return cacheKeyOf(fingerprintOf(binaryPath), resolveOptions(options));
  } catch {
    // [ANTI-PATTERN IGNORED]: an unreadable binary has no fingerprint, so there is no cached result to report.
    return null;
  }
}

function recordFailureAudit(result: CodexLockdownResult): void {
  if (!result.failure) return;
  recordObserverToolAttempt({
    source: 'Observer',
    provider: 'codex',
    tool_name: `codex_self_check:${result.failure.step}`,
    tool_input: { step: result.failure.step, code: result.failure.error.code ?? null, version: result.version },
    result: 'error',
    error_message: result.failure.error.message,
  });
}

/**
 * Run (or join) the self-check for `binaryPath`. Never rejects: failures are a
 * 'failed' result. A finished result is reused until the fingerprint or the
 * inputs change, unless `force` is set.
 */
export function verifyCodexLockdown(
  binaryPath: string,
  options: VerifyCodexLockdownOptions = {},
): Promise<CodexLockdownResult> {
  const resolved = resolveOptions(options);
  const startedAt = Date.now();

  let fingerprint: Fingerprint;
  try {
    fingerprint = fingerprintOf(binaryPath);
  } catch (error: unknown) {
    const result: CodexLockdownResult = {
      state: 'failed',
      binaryPath: String(binaryPath),
      cacheKey: null,
      version: null,
      authMethod: 'unknown',
      failure: { step: 'fingerprint', error: conditionError('not_executable', errorMessage(error)) },
      warnings: [],
      startedAt,
      finishedAt: Date.now(),
    };
    lastResult = result;
    logger.warn('SDK', 'Codex self-check could not fingerprint the binary', { binaryPath, error: errorMessage(error) });
    recordFailureAudit(result);
    return Promise.resolve(result);
  }

  const key = cacheKeyOf(fingerprint, resolved);
  const running = inFlight.get(key);
  if (running) return running.promise;
  if (!options.force) {
    const done = freshCompleted(key, startedAt);
    if (done) return Promise.resolve(done);
  }

  const placeholder: CodexLockdownResult = {
    state: 'pending',
    binaryPath,
    cacheKey: key,
    version: null,
    authMethod: 'unknown',
    failure: null,
    warnings: [],
    startedAt,
    finishedAt: null,
  };
  lastResult = placeholder;

  const promise = runSelfCheck(binaryPath, fingerprint, key, resolved, options, startedAt)
    .catch((error: unknown): CodexLockdownResult => ({
      ...placeholder,
      state: 'failed',
      failure: { step: 'fingerprint', error: conditionError('self_check_failed', `unexpected self-check error: ${errorMessage(error)}`) },
      finishedAt: Date.now(),
    }))
    .then((result) => {
      completed.set(key, result);
      if (lastResult === placeholder || lastResult?.cacheKey === key) lastResult = result;
      if (result.state === 'passed') {
        logger.info('SDK', 'Codex lockdown self-check passed', {
          binaryPath,
          version: result.version,
          authMethod: result.authMethod,
          warnings: result.warnings.length,
        });
      } else {
        logger.warn('SDK', 'Codex lockdown self-check failed', {
          binaryPath,
          step: result.failure?.step,
          code: result.failure?.error.code,
          kind: result.failure?.error.kind,
        });
        recordFailureAudit(result);
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, { placeholder, promise });
  return promise;
}

async function runSelfCheck(
  binaryPath: string,
  fingerprint: Fingerprint,
  key: string,
  resolved: ResolvedOptions,
  options: VerifyCodexLockdownOptions,
  startedAt: number,
): Promise<CodexLockdownResult> {
  const warnings: string[] = [];
  let version: string | null = null;
  let authMethod: CodexAuthMethod = 'unknown';

  const finish = (failure: CodexLockdownFailure | null): CodexLockdownResult => ({
    state: failure ? 'failed' : 'passed',
    binaryPath,
    cacheKey: key,
    version,
    authMethod,
    failure,
    warnings,
    startedAt,
    finishedAt: Date.now(),
  });

  const jailDir = options.jailDir ?? path.join(OBSERVER_SESSIONS_DIR, CODEX_SELF_CHECK_DIRNAME);
  try {
    ensureDir(jailDir);
    assertCodexJailSafe(jailDir);
  } catch (error: unknown) {
    return finish({ step: 'jail', error: conditionError('self_check_failed', `self-check jail is not safe: ${errorMessage(error)}`) });
  }

  const runner = options.probeRunner ?? createCodexProbeRunner(resolved.envSettings);
  const probe = async (kind: CodexProbeKind): Promise<CodexProbeResponse> => {
    const args = buildCodexProbeArgs(kind, { model: resolved.model, effort: resolved.effort, verbosity: resolved.verbosity });
    const timeoutMs = options.timeouts?.[kind] ?? CODEX_PROBE_TIMEOUTS_MS[kind];
    return runner({ kind, binaryPath: fingerprint.realpath, args, cwd: jailDir, timeoutMs });
  };

  for (const kind of CODEX_PROBE_ORDER) {
    const response = await probe(kind);
    const failure = probeTransportFailure(kind, response);
    if (failure) return finish({ step: kind, error: failure });

    switch (kind) {
      case 'version': {
        if (response.exitCode !== 0) return finish({ step: kind, error: nonZeroExitFailure(kind, response) });
        const parsed = parseCodexVersion(response.stdout);
        if (!parsed) {
          return finish({ step: kind, error: conditionError('self_check_failed', 'could not parse the `codex --version` output') });
        }
        version = parsed.raw;
        recordCodexBinaryVersion(fingerprint, parsed.raw);
        // Before the tested-range check and never waived by allowUntestedVersion:
        // an older CLI does not know the model and would send it with generic
        // metadata. major.minor.patch only (a prerelease of the floor passes).
        for (const model of execModels(resolved)) {
          const minimum = codexModelMinCliVersion(model);
          if (minimum && compareTriple([parsed.major, parsed.minor, parsed.patch], minimum) < 0) {
            return finish({
              step: kind,
              error: conditionError(
                'model_needs_newer_cli',
                `${describeExecModel(resolved, model)} needs codex-cli ${minimum.join('.')} or newer (found ${parsed.raw})`,
              ),
            });
          }
        }
        if (!isCodexVersionTested(parsed)) {
          if (!resolved.allowUntestedVersion) {
            return finish({
              step: kind,
              error: conditionError('version_untested', `codex-cli ${parsed.raw} (tested ${CODEX_TESTED_VERSION_RANGE.label})`),
            });
          }
          warnings.push(`codex-cli ${parsed.raw} is outside the tested range ${CODEX_TESTED_VERSION_RANGE.label} (allowed by CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION)`);
        }
        break;
      }
      case 'login_status': {
        const login = evaluateCodexLoginStatus(response);
        authMethod = login.authMethod;
        if (!login.ok) return finish({ step: kind, error: login.error });
        break;
      }
      case 'models_catalog': {
        if (response.exitCode !== 0) return finish({ step: kind, error: nonZeroExitFailure(kind, response) });
        const override = catalogOverrideProblem(resolved.envSettings);
        if (override) return finish({ step: kind, error: conditionError('self_check_failed', `model catalog: ${override}`) });
        // Summary and wrap-up execs run the summary model, so it is checked
        // against the same output.
        for (const model of execModels(resolved)) {
          const evaluation = evaluateCodexModelCatalog(response.stdout, model);
          if (!evaluation.ok) {
            const subject = model === resolved.model ? '' : 'summary model ';
            return finish({ step: kind, error: conditionError('self_check_failed', `model catalog: ${subject}${evaluation.reason}`) });
          }
        }
        break;
      }
      case 'features_list': {
        if (response.exitCode !== 0) return finish({ step: kind, error: nonZeroExitFailure(kind, response) });
        const rows = parseCodexFeaturesList(response.stdout);
        if (!rows) {
          return finish({ step: kind, error: conditionError('self_check_failed', 'could not parse the `codex features list` output') });
        }
        const evaluation = evaluateCodexFeatures(rows);
        if (!evaluation.ok) return finish({ step: kind, error: conditionError('self_check_failed', `features list: ${evaluation.reason}`) });
        break;
      }
      case 'prompt_input': {
        if (response.exitCode !== 0) return finish({ step: kind, error: nonZeroExitFailure(kind, response) });
        const evaluation = evaluateCodexPromptInput(response.stdout);
        if (!evaluation.ok) return finish({ step: kind, error: conditionError('self_check_failed', `prompt-input canary: ${evaluation.reason}`) });
        break;
      }
      default: {
        const exhaustive: never = kind;
        throw new Error(`unknown probe ${String(exhaustive)}`);
      }
    }
  }

  try {
    const codexHome = resolveCodexHome(resolved.envSettings, sanitizeEnv(process.env));
    if (existsSync(path.join(codexHome, 'AGENTS.md'))) {
      warnings.push('A global $CODEX_HOME/AGENTS.md exists; the canary did not show it, but review it if observer output drifts.');
    }
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: an unusable CODEX_HOME already failed the probes (they share the env); this is only a hint.
    warnings.push(`CODEX_HOME could not be resolved for the AGENTS.md hint: ${errorMessage(error)}`);
  }

  return finish(null);
}

/**
 * Why `codex debug models` cannot stand for exec's catalog, or null. The probe
 * loads CODEX_HOME/config.toml (it has no --ignore-user-config) and
 * `model_catalog_json` there replaces the catalog outright, so a pass would
 * prove nothing about the one exec uses.
 */
function catalogOverrideProblem(envSettings: CodexEnvSettings): string | null {
  let configPath: string;
  try {
    configPath = path.join(resolveCodexHome(envSettings, sanitizeEnv(process.env)), 'config.toml');
  } catch (error: unknown) {
    return `CODEX_HOME could not be resolved to read its config.toml: ${errorMessage(error)}`;
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    // [ANTI-PATTERN IGNORED]: no config.toml is the ordinary case, and one this
    // user cannot read, codex (run as the same user) cannot read either.
    return null;
  }
  return CATALOG_OVERRIDE_KEY_RE.test(text)
    ? '$CODEX_HOME/config.toml sets model_catalog_json, so `codex debug models` does not show the catalog observer calls use'
    : null;
}

function probeTransportFailure(kind: CodexProbeKind, response: CodexProbeResponse): ClassifiedProviderError | null {
  if (response.spawnError !== undefined) {
    return conditionError('self_check_failed', `${kind} probe could not start: ${response.spawnError}`);
  }
  if (response.timedOut) {
    return conditionError('self_check_failed', `${kind} probe timed out`);
  }
  return null;
}

const FALLBACK_RULES = new Set(['terminated', 'exit_nonzero', 'unknown']);

/**
 * A probe exited non-zero. Keep a specific upstream classification
 * (auth, invalid invocation, unknown feature flag) when the text matches one;
 * otherwise it is a self-check failure (fail closed, never transient-by-default).
 */
function nonZeroExitFailure(kind: CodexProbeKind, response: CodexProbeResponse): ClassifiedProviderError {
  const outcome = classifyCodexFailure({
    failureMessage: response.stderr,
    stderrTail: response.stdout,
    exitCode: response.exitCode,
    signal: response.signal,
  });
  if (outcome.type === 'error' && !FALLBACK_RULES.has(outcome.rule)) return outcome.error;
  const excerpt = redactCodexDiagnostic(response.stderr || response.stdout);
  return conditionError(
    'self_check_failed',
    `${kind} probe exited with status ${String(response.exitCode)}${excerpt ? `: ${excerpt}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Cached state for the binary's CURRENT fingerprint: the in-flight
 * placeholder ('pending'), the finished result, or null when no check has run
 * for it (or it cannot be fingerprinted).
 */
export function getCodexLockdownStatus(
  binaryPath: string,
  options: VerifyCodexLockdownOptions = {},
): CodexLockdownResult | null {
  const key = currentKey(binaryPath, options);
  if (key === null) return null;
  return inFlight.get(key)?.placeholder ?? freshCompleted(key, Date.now()) ?? null;
}

/**
 * The key a verdict for `binaryPath` would be cached under right now: the
 * binary's realpath, mtime and size, the codex settings the check depends on,
 * and the auth.json fingerprint. It changes exactly when a re-check could
 * reach a different verdict — a new binary, a new login, changed settings —
 * and, unlike the cache lookup, not when a verdict merely ages out. Null when
 * the binary cannot be fingerprinted. Reads only (a realpath and three stats);
 * never spawns.
 */
export function getCodexLockdownFingerprint(
  binaryPath: string,
  options: VerifyCodexLockdownOptions = {},
): string | null {
  return currentKey(binaryPath, options);
}

/** True only for a finished, passing check of the current fingerprint. Pending / never run is false. */
export function isCodexLockdownPassed(binaryPath: string, options: VerifyCodexLockdownOptions = {}): boolean {
  return getCodexLockdownStatus(binaryPath, options)?.state === 'passed';
}

/** The most recently started or finished check, for status displays. */
export function getLastCodexLockdownResult(): CodexLockdownResult | null {
  return lastResult;
}

/**
 * Human-readable auth method for getAiStatus (plan 3.4). With a binary path
 * it describes that binary's current fingerprint; otherwise the last check.
 */
export function getCodexAuthMethodDescription(
  binaryPath?: string | null,
  options: VerifyCodexLockdownOptions = {},
): string {
  const result = binaryPath ? getCodexLockdownStatus(binaryPath, options) : lastResult;
  if (!result) return 'Codex CLI (not verified yet)';
  if (result.state === 'pending') return 'Codex CLI (verifying ChatGPT login)';
  if (result.state === 'passed') return 'Codex CLI (ChatGPT login)';
  if (result.authMethod === 'api_key') return 'Codex CLI (API-key login rejected; run `codex login` with ChatGPT)';
  if (result.authMethod === 'not_logged_in') return 'Codex CLI (not logged in; run `codex login`)';
  return `Codex CLI (self-check failed: ${result.failure?.error.code ?? 'unknown'})`;
}

/** Test hook: forget every cached and in-flight result. */
export function resetCodexSelfCheckCache(): void {
  inFlight.clear();
  completed.clear();
  lastResult = null;
}
