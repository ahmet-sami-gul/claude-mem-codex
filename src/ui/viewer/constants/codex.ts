/**
 * What the settings modal may offer for the Codex CLI observer (plan 3.7).
 *
 * The viewer cannot import worker code (its tsconfig is rooted at
 * src/ui/viewer), so these mirror the server's rules by value. Every choice the
 * modal offers must be one POST /api/settings accepts:
 *
 *   - CODEX_MODEL_OPTIONS  <- CODEX_MODEL_ALLOWLIST (codex-invocation.ts): the
 *                             only ids the route accepts for a model CHANGE;
 *                             the value already persisted is accepted as well.
 *   - CODEX_LEVEL_OPTIONS  <- CODEX_REASONING_EFFORTS / CODEX_VERBOSITIES.
 *   - CODEX_NUMBER_BOUNDS  <- the ranges SettingsRoutes.validateCodexSettings
 *                             enforces, and CODEX_CONFIG_BOUNDS (CodexProvider)
 *                             clamps to at runtime.
 *   - the provider rule    <- SettingsRoutes.validateSettings: switching TO
 *                             codex and switching AWAY from a persisted codex
 *                             are both settings.json / env only.
 *   - CODEX_MODEL_ID_RE    <- MODEL_ID_RE, and the effective* helpers <-
 *                             CodexProvider.getConfig (clampedInt, modelSetting,
 *                             enumText): what the worker actually runs with.
 *
 * tests/viewer/codex-settings.test.ts and
 * tests/worker/http/routes/settings-routes-codex.test.ts fail when the two
 * sides drift.
 */

import { DEFAULT_SETTINGS } from './settings';

/**
 * Where a value the viewer did not write came from. GET /api/settings applies
 * the worker's environment over settings.json, so the viewer cannot tell the
 * two apart and names both.
 */
const CONFIGURED_SOURCE = 'settings.json or the environment';

export interface SelectOption {
  value: string;
  label: string;
}

export const PROVIDER_OPTIONS: readonly SelectOption[] = [
  { value: 'claude', label: 'Claude (uses your Claude account)' },
  { value: 'gemini', label: 'Gemini (uses API key)' },
  { value: 'openrouter', label: 'OpenRouter / claude-mem observer' },
  { value: 'codex', label: 'Codex CLI (uses your ChatGPT/Codex plan)' },
];

/**
 * Whether the provider select may offer `option`, given the provider that is
 * PERSISTED — what GET /api/settings returned, not the form's current value.
 *
 * The settings route is unauthenticated, so it refuses to switch memory onto a
 * ChatGPT plan, and refuses to switch a persisted codex away (a one-way gate
 * would be a trapdoor). Offering either would only earn a 400 on save, so a
 * codex install can select nothing but codex, and any other install can select
 * everything but codex.
 */
export function isProviderOptionSelectable(option: string, persistedProvider: string | undefined): boolean {
  return persistedProvider === 'codex' ? option === 'codex' : option !== 'codex';
}

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-luna';

export const CODEX_MODEL_OPTIONS: readonly SelectOption[] = [
  { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna (default)' },
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
  { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol (much smaller Plus allowance)' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'gpt-6-luna', label: 'gpt-6-luna (larger Plus allowance than gpt-5.6-luna)' },
  { value: 'gpt-6-sol', label: 'gpt-6-sol (much smaller Plus allowance)' },
  { value: 'gpt-6-astra', label: 'gpt-6-astra (smallest Plus allowance)' },
];

/** Models whose ChatGPT Plus allowance is a small fraction of gpt-5.6-luna's. */
export const CODEX_SMALL_ALLOWANCE_MODELS: ReadonlySet<string> = new Set(['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-astra']);

export const CODEX_LEVEL_OPTIONS: readonly SelectOption[] = [
  { value: 'low', label: 'low (default)' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

/**
 * `options`, plus the value already persisted when it is not one of them.
 *
 * settings.json may hold a value the viewer would never offer (a newer model
 * id, an upper-case level). The route accepts it unchanged, so the select has
 * to be able to show it and keep it — otherwise it would display the first
 * option while the form still carries the persisted value. Only the PERSISTED
 * value is added: it is the one non-listed value a save may carry.
 */
export function withPersistedOption(options: readonly SelectOption[], persisted: unknown): SelectOption[] {
  if (typeof persisted !== 'string' || persisted.trim() === '' || options.some(option => option.value === persisted)) {
    return [...options];
  }
  return [...options, { value: persisted, label: `${persisted} (set in ${CONFIGURED_SOURCE})` }];
}

/**
 * The seven codex keys the settings route never writes (SettingsRoutes'
 * write allowlist leaves them out): each could lift the exec cap, run another
 * binary or login, or relax a guard, so only settings.json or the environment
 * sets them. The viewer leaves them out of every save. Posting them back gains
 * nothing, and the route still validates what it is sent: a hand-edited
 * `"CLAUDE_MEM_CODEX_PATH": null` in the file would otherwise make every save
 * fail with a 400, including saves of unrelated settings.
 */
export const CODEX_FILE_ONLY_KEYS: readonly string[] = [
  'CLAUDE_MEM_CODEX_PATH',
  'CLAUDE_MEM_CODEX_HOME',
  'CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H',
  'CLAUDE_MEM_CODEX_TRANSPORT',
  'CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT',
  'CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS',
  'CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION',
];

/**
 * The body the modal POSTs: the form, minus what it must not send back.
 *
 * GET /api/settings returns settings.json with the worker's environment
 * applied, but POST writes settings.json. Posting the whole GET body back
 * would copy an environment value into the file. For CLAUDE_MEM_PROVIDER that
 * is a switch to (or away from) codex through the API, which the route is
 * meant to allow only through the file or the environment: its "unchanged"
 * check reads the same env-applied value, so it accepts the copy. So:
 *
 *   - the seven file/env-only codex keys are never sent (CODEX_FILE_ONLY_KEYS);
 *   - CLAUDE_MEM_PROVIDER and every other CLAUDE_MEM_CODEX_* key is sent only
 *     when the user changed it from what GET returned (`persisted`).
 *
 * The route skips keys a body leaves out, so nothing about an unchanged value
 * is lost.
 */
export function buildSettingsSaveBody<T extends object>(form: T, persisted: T): T {
  const body: Record<string, unknown> = { ...(form as Record<string, unknown>) };
  const before = persisted as Record<string, unknown>;
  for (const key of CODEX_FILE_ONLY_KEYS) {
    delete body[key];
  }
  for (const key of Object.keys(body)) {
    const sentOnlyWhenChanged = key === 'CLAUDE_MEM_PROVIDER' || key.startsWith('CLAUDE_MEM_CODEX_');
    if (sentOnlyWhenChanged && body[key] === before[key]) {
      delete body[key];
    }
  }
  return body as T;
}

export type CodexNumberKey =
  | 'CLAUDE_MEM_CODEX_TIMEOUT_MS'
  | 'CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS'
  | 'CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS';

export const CODEX_NUMBER_BOUNDS: Readonly<Record<CodexNumberKey, { min: number; max: number }>> = {
  CLAUDE_MEM_CODEX_TIMEOUT_MS: { min: 30_000, max: 600_000 },
  CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: { min: 40_000, max: 400_000 },
  CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: { min: 1, max: 12 },
};

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The route's rule for one numeric codex key, evaluated before the save so the
 * modal can say what is wrong instead of a bare "Bad Request": an empty value
 * (the worker then uses the default) and the value already persisted are
 * always accepted; anything else must be an integer inside the range.
 */
export function codexNumberError(key: CodexNumberKey, value: unknown, persistedValue: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === persistedValue) return null;
  const { min, max } = CODEX_NUMBER_BOUNDS[key];
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `Must be a whole number from ${formatCount(min)} to ${formatCount(max)}.`;
  }
  return null;
}

/**
 * What the worker does with a value it is given, next to the value itself.
 * `problem` is set when the worker does not use the value as written — a JSON
 * number, an out-of-range count, an unknown level or model id — and says what
 * it uses instead, so a field never looks like it is in force when it is not.
 */
export interface CodexEffectiveValue<T> {
  value: T;
  problem: string | null;
}

/** Mirrors MODEL_ID_RE (codex-invocation.ts); ids are case-sensitive. */
export const CODEX_MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function describeRaw(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : String(JSON.stringify(raw));
}

/**
 * CLAUDE_MEM_CODEX_MODEL as CodexProvider's modelSetting reads it: trimmed,
 * then checked against MODEL_ID_RE (no lower-casing), with the default for an
 * empty, non-string or invalid value. Allowlisting is the route's rule for a
 * CHANGE; any valid id the file or env sets is run as is.
 */
export function effectiveCodexModel(raw: unknown): CodexEffectiveValue<string> {
  if (raw === undefined || raw === null) return { value: CODEX_DEFAULT_MODEL, problem: null };
  if (typeof raw !== 'string') {
    return {
      value: CODEX_DEFAULT_MODEL,
      problem: `${CONFIGURED_SOURCE} holds ${describeRaw(raw)}, which is not a string, so the worker uses ${CODEX_DEFAULT_MODEL} instead.`,
    };
  }
  const text = raw.trim();
  if (text === '') return { value: CODEX_DEFAULT_MODEL, problem: null };
  if (!CODEX_MODEL_ID_RE.test(text)) {
    return {
      value: CODEX_DEFAULT_MODEL,
      problem: `${describeRaw(raw)} is not a valid model id (lower-case letters, digits, ".", "_" and "-"), so the worker uses ${CODEX_DEFAULT_MODEL} instead.`,
    };
  }
  return { value: text, problem: null };
}

/**
 * CLAUDE_MEM_CODEX_REASONING_EFFORT / _VERBOSITY as getConfig reads them
 * (enumText): trimmed and lower-cased, then one of the levels, else the
 * default `low`.
 */
export function effectiveCodexLevel(raw: unknown): CodexEffectiveValue<string> {
  const fallback = CODEX_LEVEL_OPTIONS[0].value;
  if (raw === undefined || raw === null) return { value: fallback, problem: null };
  if (typeof raw !== 'string') {
    return {
      value: fallback,
      problem: `${CONFIGURED_SOURCE} holds ${describeRaw(raw)}, which is not a string, so the worker uses ${fallback} instead.`,
    };
  }
  const text = raw.trim().toLowerCase();
  if (text === '') return { value: fallback, problem: null };
  if (!CODEX_LEVEL_OPTIONS.some(option => option.value === text)) {
    return {
      value: fallback,
      problem: `${describeRaw(raw)} is not low, medium or high, so the worker uses ${fallback} instead.`,
    };
  }
  return { value: text, problem: null };
}

/**
 * A numeric codex key as getConfig reads it (clampedInt): empty means the
 * default, a non-string or non-integer falls back to the default, and a whole
 * number outside the range is clamped to the nearest bound.
 */
export function effectiveCodexNumber(key: CodexNumberKey, raw: unknown): CodexEffectiveValue<number> {
  const { min, max } = CODEX_NUMBER_BOUNDS[key];
  const fallback = Number(DEFAULT_SETTINGS[key]);
  if (raw === undefined || raw === null) return { value: fallback, problem: null };
  if (typeof raw !== 'string') {
    return {
      value: fallback,
      problem: `${CONFIGURED_SOURCE} holds ${describeRaw(raw)}, which is not a string, so the worker ignores it and uses ${formatCount(fallback)}. Write it as a quoted string.`,
    };
  }
  const text = raw.trim();
  if (text === '') return { value: fallback, problem: null };
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    return {
      value: fallback,
      problem: `${describeRaw(raw)} is not a whole number, so the worker ignores it and uses ${formatCount(fallback)}.`,
    };
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed));
    return {
      value: clamped,
      problem: `${describeRaw(raw)} is outside ${formatCount(min)}–${formatCount(max)}, so the worker uses ${formatCount(clamped)}.`,
    };
  }
  return { value: parsed, problem: null };
}

export interface CodexExecCapDescription {
  /** The limit the worker applies; 0 means no local cap. */
  limit: number;
  text: string;
  /** Set when the configured value is not used as written. */
  problem: string | null;
}

/**
 * CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H as the worker reads it (CodexProvider's
 * clampedInt with bounds 0..MAX_SAFE_INTEGER, fallback 0): empty is 0, a
 * non-string or non-integer falls back to 0, a negative clamps to 0. Shown
 * read-only, so it must say what is actually enforced, not merely what the file
 * says — a JSON number in settings.json silently means "no cap".
 */
export function describeCodexExecCap(raw: unknown): CodexExecCapDescription {
  let limit = 0;
  let problem: string | null = null;
  if (raw === undefined || raw === null) {
    limit = 0;
  } else if (typeof raw !== 'string') {
    problem = `${CONFIGURED_SOURCE} holds ${describeRaw(raw)}, which is not a string, so the worker ignores it. Write it as a quoted string.`;
  } else if (raw.trim() !== '') {
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed)) {
      problem = `${CONFIGURED_SOURCE} holds "${raw}", which is not a whole number, so the worker ignores it.`;
    } else if (parsed < 0) {
      problem = `${CONFIGURED_SOURCE} holds "${raw}"; the worker treats a negative value as 0.`;
    } else {
      limit = Math.min(parsed, Number.MAX_SAFE_INTEGER);
    }
  }
  const text = limit === 0
    ? 'No local cap (0)'
    : `${formatCount(limit)} Codex call${limit === 1 ? '' : 's'} per 5 hours`;
  return { limit, text, problem };
}
