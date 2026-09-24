import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CODEX_FILE_ONLY_KEYS,
  CODEX_LEVEL_OPTIONS,
  CODEX_MODEL_ID_RE,
  CODEX_MODEL_OPTIONS,
  CODEX_NUMBER_BOUNDS,
  CODEX_QUEUE_CAP_BOUNDS,
  CODEX_SMALL_ALLOWANCE_MODELS,
  OTHER_FILE_ONLY_KEYS,
  PROVIDER_OPTIONS,
  buildSettingsSaveBody,
  codexNumberError,
  describeCodexExecCap,
  describeCodexQueueCap,
  effectiveCodexLevel,
  effectiveCodexModel,
  effectiveCodexNumber,
  isProviderOptionSelectable,
  withPersistedOption,
  type CodexNumberKey,
} from '../../src/ui/viewer/constants/codex';
import { DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings';
import {
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_DEFAULT_VERBOSITY,
  CODEX_MODEL_ALLOWLIST,
  CODEX_REASONING_EFFORTS,
  CODEX_VERBOSITIES,
  MODEL_ID_RE,
} from '../../src/services/worker/codex/codex-invocation.js';
import { CODEX_CONFIG_BOUNDS } from '../../src/services/worker/CodexProvider.js';

/**
 * The viewer's Codex options (plan 3.7) against the worker's own rules.
 *
 * The viewer cannot import worker code, so src/ui/viewer/constants/codex.ts
 * repeats the allowlist, the levels and the ranges by value. This file is the
 * drift guard for the constants; the route-level half (every option the modal
 * offers is one POST /api/settings accepts, and the GET-then-POST round trip
 * with every codex key present) lives in
 * tests/worker/http/routes/settings-routes-codex.test.ts.
 */

/**
 * The DEFAULTS literal in SettingsDefaultsManager.ts, read from source.
 *
 * Deliberately not SettingsDefaultsManager.getAllDefaults(): several test
 * files mock.module that module with small stubs and never restore it, and
 * bun's module mocks are process-global, so in a full `bun test` run the
 * import is not dependable. The source text is.
 */
function serverCodexDefaults(): Record<string, string> {
  const source = readFileSync(join(import.meta.dir, '../../src/shared/SettingsDefaultsManager.ts'), 'utf-8');
  const defaults: Record<string, string> = {};
  for (const match of source.matchAll(/^\s*(CLAUDE_MEM_(?:CODEX_[A-Z0-9_]+|PROVIDER)):\s*'([^']*)',/gm)) {
    defaults[match[1]] = match[2];
  }
  return defaults;
}

/**
 * The CLAUDE_MEM_CODEX_* keys on the settings route's write allowlist (the
 * `settingKeys` array in SettingsRoutes.handleUpdateSettings), read from
 * source because the array is local to the handler.
 */
function routeWritableCodexKeys(): Set<string> {
  const source = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
  const list = source.match(/const settingKeys = \[([\s\S]*?)\];/);
  if (!list) throw new Error('settingKeys not found in SettingsRoutes.ts');
  return new Set([...list[1].matchAll(/'(CLAUDE_MEM_CODEX_[A-Z0-9_]+)'/g)].map(match => match[1]));
}

describe('viewer codex constants mirror the worker', () => {
  it('offers exactly the models the settings route accepts, default first', () => {
    expect(CODEX_MODEL_OPTIONS.map(option => option.value)).toEqual([...CODEX_MODEL_ALLOWLIST]);
    expect(CODEX_MODEL_OPTIONS[0].value).toBe(CODEX_DEFAULT_MODEL);
    for (const model of CODEX_SMALL_ALLOWANCE_MODELS) {
      expect(CODEX_MODEL_ALLOWLIST as readonly string[]).toContain(model);
    }
    expect([...CODEX_SMALL_ALLOWANCE_MODELS].sort()).toEqual(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-sol']);
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has(CODEX_DEFAULT_MODEL)).toBe(false);
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has('gpt-6-luna')).toBe(false);
  });

  it('labels the GPT-6 models by their Plus allowance', () => {
    const labels = Object.fromEntries(CODEX_MODEL_OPTIONS.map(option => [option.value, option.label]));
    expect(labels['gpt-6-luna']).toBe('gpt-6-luna (larger Plus allowance than gpt-5.6-luna)');
    expect(labels['gpt-6-sol']).toBe('gpt-6-sol (much smaller Plus allowance)');
    expect(labels['gpt-6-astra']).toBe('gpt-6-astra (smallest Plus allowance)');
    // gpt-6-luna has the larger Plus allowance, so the default no longer claims the widest.
    expect(labels[CODEX_DEFAULT_MODEL]).toBe('gpt-5.6-luna (default)');
  });

  it('offers exactly the reasoning efforts and verbosities the argv builder accepts', () => {
    const levels = CODEX_LEVEL_OPTIONS.map(option => option.value);
    expect(levels).toEqual([...CODEX_REASONING_EFFORTS]);
    expect(levels).toEqual([...CODEX_VERBOSITIES]);
    expect(levels[0]).toBe(CODEX_DEFAULT_REASONING_EFFORT);
    expect(levels[0]).toBe(CODEX_DEFAULT_VERBOSITY);
  });

  it('uses the runtime bounds for the numeric fields', () => {
    const runtime: Record<CodexNumberKey, { min: number; max: number; fallback: number }> = {
      CLAUDE_MEM_CODEX_TIMEOUT_MS: CODEX_CONFIG_BOUNDS.timeoutMs,
      CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: CODEX_CONFIG_BOUNDS.maxConversationChars,
      CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: CODEX_CONFIG_BOUNDS.batchMaxObservations,
    };
    for (const key of Object.keys(CODEX_NUMBER_BOUNDS) as CodexNumberKey[]) {
      expect(CODEX_NUMBER_BOUNDS[key]).toEqual({ min: runtime[key].min, max: runtime[key].max });
      expect(DEFAULT_SETTINGS[key]).toBe(String(runtime[key].fallback));
    }
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H).toBe(String(CODEX_CONFIG_BOUNDS.maxExecsPer5h.fallback));
    const { fallback, ...queueCapBounds } = CODEX_CONFIG_BOUNDS.maxQueuedObservations;
    expect(CODEX_QUEUE_CAP_BOUNDS).toEqual(queueCapBounds);
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS).toBe(String(fallback));
  });

  it('seeds every codex field with the server default, exactly', () => {
    const server = serverCodexDefaults();
    const viewerCodexKeys = Object.keys(DEFAULT_SETTINGS).filter(key => key.startsWith('CLAUDE_MEM_CODEX_'));
    expect(viewerCodexKeys.length).toBeGreaterThan(0);
    for (const key of viewerCodexKeys) {
      expect(server[key]).toBeDefined();
      expect(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]).toBe(server[key]);
    }
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_PROVIDER).toBe(server.CLAUDE_MEM_PROVIDER);
  });

  it('treats exactly the codex keys the route never writes as file/env only', () => {
    const writable = routeWritableCodexKeys();
    expect(writable.size).toBeGreaterThan(0);
    const serverCodexKeys = Object.keys(serverCodexDefaults()).filter(key => key.startsWith('CLAUDE_MEM_CODEX_'));
    // The observer keys only; the transcript-ingestion toggle belongs to the
    // Codex host integration, not to this provider.
    const observerKeys = serverCodexKeys.filter(key => key !== 'CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION');
    const fileOnly = observerKeys.filter(key => !writable.has(key)).sort();
    expect([...CODEX_FILE_ONLY_KEYS].sort()).toEqual(fileOnly);
    expect(CODEX_FILE_ONLY_KEYS).toHaveLength(8);
  });

  it('treats CLAUDE_MEM_SUBAGENT_EVENTS and CLAUDE_MEM_DATA_DIR, which the route never writes, as file/env only too', () => {
    expect([...OTHER_FILE_ONLY_KEYS]).toEqual(['CLAUDE_MEM_SUBAGENT_EVENTS', 'CLAUDE_MEM_DATA_DIR']);
    const source = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    const list = source.match(/const settingKeys = \[([\s\S]*?)\];/);
    expect(list).not.toBeNull();
    for (const key of OTHER_FILE_ONLY_KEYS) {
      expect(list![1]).not.toContain(`'${key}'`);
      expect(key in DEFAULT_SETTINGS).toBe(false);
    }
  });

  it('checks model ids with the worker pattern', () => {
    expect(CODEX_MODEL_ID_RE.source).toBe(MODEL_ID_RE.source);
    expect(CODEX_MODEL_ID_RE.flags).toBe(MODEL_ID_RE.flags);
  });

  it('has no field for the binary path or the Codex home', () => {
    expect('CLAUDE_MEM_CODEX_PATH' in DEFAULT_SETTINGS).toBe(false);
    expect('CLAUDE_MEM_CODEX_HOME' in DEFAULT_SETTINGS).toBe(false);
    const modal = readFileSync(
      join(import.meta.dir, '../../src/ui/viewer/components/ContextSettingsModal.tsx'),
      'utf-8',
    );
    expect(modal).not.toContain("'CLAUDE_MEM_CODEX_PATH'");
    expect(modal).not.toContain("'CLAUDE_MEM_CODEX_HOME'");
    // The exec cap and the queue cap are displayed, never edited.
    expect(modal).not.toContain("updateSetting('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H'");
    expect(modal).not.toContain("updateSetting('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS'");
  });
});

describe('isProviderOptionSelectable', () => {
  const providers = PROVIDER_OPTIONS.map(option => option.value);

  it('lists codex beside the three existing providers', () => {
    expect(providers).toEqual(['claude', 'gemini', 'openrouter', 'codex']);
    expect(PROVIDER_OPTIONS.find(option => option.value === 'codex')?.label).toBe('Codex CLI (uses your ChatGPT/Codex plan)');
  });

  it.each(['claude', 'gemini', 'openrouter', undefined, ''])('never offers codex when %p is persisted', persisted => {
    expect(isProviderOptionSelectable('codex', persisted)).toBe(false);
    for (const provider of providers.filter(value => value !== 'codex')) {
      expect(isProviderOptionSelectable(provider, persisted)).toBe(true);
    }
  });

  it('offers nothing but codex when codex is persisted', () => {
    expect(isProviderOptionSelectable('codex', 'codex')).toBe(true);
    for (const provider of ['claude', 'gemini', 'openrouter']) {
      expect(isProviderOptionSelectable(provider, 'codex')).toBe(false);
    }
  });
});

describe('withPersistedOption', () => {
  it('adds a persisted value the list does not offer, once', () => {
    const options = withPersistedOption(CODEX_MODEL_OPTIONS, 'gpt-5.7-future');
    expect(options.map(option => option.value)).toEqual([...CODEX_MODEL_ALLOWLIST, 'gpt-5.7-future']);
    expect(options[options.length - 1].label).toContain('settings.json');
  });

  it.each([['gpt-5.6-terra'], [''], ['   '], [undefined], [42]])('adds nothing for %p', persisted => {
    expect(withPersistedOption(CODEX_MODEL_OPTIONS, persisted)).toEqual([...CODEX_MODEL_OPTIONS]);
  });

  it('does not claim the value came from settings.json alone', () => {
    // GET applies the worker environment over the file, so either may hold it.
    const [added] = withPersistedOption(CODEX_LEVEL_OPTIONS, 'HIGH').slice(-1);
    expect(added.label).toContain('the environment');
  });
});

describe('buildSettingsSaveBody', () => {
  const persisted = {
    CLAUDE_MEM_MODEL: 'claude-sonnet-5',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_CODEX_MODEL: 'gpt-5.6-luna',
    CLAUDE_MEM_CODEX_VERBOSITY: 'low',
    CLAUDE_MEM_CODEX_TIMEOUT_MS: '5',
    CLAUDE_MEM_CODEX_PATH: null,
    CLAUDE_MEM_CODEX_HOME: '   ',
    CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '200',
    CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS: '800',
    CLAUDE_MEM_CODEX_TRANSPORT: 'exec',
    CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT: '0',
    CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS: '300000',
    CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION: 'false',
    CLAUDE_MEM_SUBAGENT_EVENTS: 'writes',
    CLAUDE_MEM_DATA_DIR: '/Users/someone/.claude-mem',
  } as Record<string, unknown>;

  it('never sends the eight file/env-only codex keys, CLAUDE_MEM_SUBAGENT_EVENTS or CLAUDE_MEM_DATA_DIR, changed or not', () => {
    const body = buildSettingsSaveBody(
      {
        ...persisted,
        CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '0',
        CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS: '50',
        CLAUDE_MEM_SUBAGENT_EVENTS: 'all',
        CLAUDE_MEM_DATA_DIR: '/tmp/x',
      },
      persisted,
    );
    for (const key of [...CODEX_FILE_ONLY_KEYS, ...OTHER_FILE_ONLY_KEYS]) {
      expect(key in body).toBe(false);
    }
  });

  it('leaves out an unchanged provider and unchanged codex values', () => {
    const body = buildSettingsSaveBody({ ...persisted }, persisted);
    expect('CLAUDE_MEM_PROVIDER' in body).toBe(false);
    expect(Object.keys(body).filter(key => key.startsWith('CLAUDE_MEM_CODEX_'))).toEqual([]);
    // Everything else still goes back, as before.
    expect(body).toEqual({ CLAUDE_MEM_MODEL: 'claude-sonnet-5', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50' });
  });

  it('sends a provider or codex value the user changed', () => {
    const body = buildSettingsSaveBody(
      { ...persisted, CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_CODEX_VERBOSITY: 'high', CLAUDE_MEM_CODEX_TIMEOUT_MS: '' },
      persisted,
    );
    expect(body).toMatchObject({
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_CODEX_VERBOSITY: 'high',
      CLAUDE_MEM_CODEX_TIMEOUT_MS: '',
    });
    expect('CLAUDE_MEM_CODEX_MODEL' in body).toBe(false);
  });

  it('does not change the form it was given', () => {
    const form = { ...persisted };
    buildSettingsSaveBody(form, persisted);
    expect(form).toEqual(persisted);
  });
});

describe('effective codex values (what CodexProvider.getConfig runs with)', () => {
  it.each([
    [undefined, CODEX_DEFAULT_MODEL, false],
    ['', CODEX_DEFAULT_MODEL, false],
    ['gpt-5.6-terra', 'gpt-5.6-terra', false],
    ['gpt-5.7-future', 'gpt-5.7-future', false],
    [' gpt-5.6-sol ', 'gpt-5.6-sol', false],
    ['GPT-5.6-SOL', CODEX_DEFAULT_MODEL, true],
    ['-gpt', CODEX_DEFAULT_MODEL, true],
    [42, CODEX_DEFAULT_MODEL, true],
  ])('reads the model %p as %p (problem: %p)', (raw, model, problem) => {
    const effective = effectiveCodexModel(raw);
    expect(effective.value).toBe(model);
    expect(effective.problem !== null).toBe(problem);
  });

  it('flags the small-allowance model whatever the spacing, and only when it actually runs', () => {
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has(effectiveCodexModel(' gpt-5.6-sol ').value)).toBe(true);
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has(effectiveCodexModel('GPT-5.6-SOL').value)).toBe(false);
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has(effectiveCodexModel(' gpt-6-astra ').value)).toBe(true);
    expect(CODEX_SMALL_ALLOWANCE_MODELS.has(effectiveCodexModel('GPT-6-SOL').value)).toBe(false);
  });

  it.each([
    [undefined, 'low', false],
    ['', 'low', false],
    ['medium', 'medium', false],
    [' HIGH ', 'high', false],
    ['extreme', 'low', true],
    [true, 'low', true],
  ])('reads the level %p as %p (problem: %p)', (raw, level, problem) => {
    const effective = effectiveCodexLevel(raw);
    expect(effective.value).toBe(level);
    expect(effective.problem !== null).toBe(problem);
  });

  it.each([
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', undefined, 180_000, false],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '', 180_000, false],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '240000', 240_000, false],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '5', 30_000, true],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '900000', 600_000, true],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', 200000, 180_000, true],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '12abc', 180_000, true],
    ['CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS', '0', 1, true],
    ['CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS', ' 60000 ', 60_000, false],
  ] as const)('reads %s = %p as %p (problem: %p)', (key, raw, value, problem) => {
    const effective = effectiveCodexNumber(key, raw);
    expect(effective.value).toBe(value);
    expect(effective.problem !== null).toBe(problem);
  });

  it('falls back to the runtime defaults', () => {
    const runtime: Record<CodexNumberKey, number> = {
      CLAUDE_MEM_CODEX_TIMEOUT_MS: CODEX_CONFIG_BOUNDS.timeoutMs.fallback,
      CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: CODEX_CONFIG_BOUNDS.maxConversationChars.fallback,
      CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: CODEX_CONFIG_BOUNDS.batchMaxObservations.fallback,
    };
    for (const key of Object.keys(CODEX_NUMBER_BOUNDS) as CodexNumberKey[]) {
      expect(effectiveCodexNumber(key, 'not a number').value).toBe(runtime[key]);
    }
  });
});

describe('codexNumberError', () => {
  it.each(Object.keys(CODEX_NUMBER_BOUNDS) as CodexNumberKey[])('accepts %s at both bounds and refuses one past them', key => {
    const { min, max } = CODEX_NUMBER_BOUNDS[key];
    expect(codexNumberError(key, String(min), 'x')).toBeNull();
    expect(codexNumberError(key, String(max), 'x')).toBeNull();
    expect(codexNumberError(key, String(min - 1), 'x')).not.toBeNull();
    expect(codexNumberError(key, String(max + 1), 'x')).not.toBeNull();
    expect(codexNumberError(key, `${min}.5`, 'x')).not.toBeNull();
    expect(codexNumberError(key, 'abc', 'x')).not.toBeNull();
  });

  it.each(['300k', '12abc', '-', '2e', '1.5e4'])('refuses the partial or non-numeric entry %p', value => {
    // What a text field hands over verbatim, where a number input would have
    // reported '' and let it pass as "use the default".
    expect(codexNumberError('CLAUDE_MEM_CODEX_TIMEOUT_MS', value, '180000')).not.toBeNull();
  });

  it('accepts an empty value and the value already persisted, even out of range', () => {
    expect(codexNumberError('CLAUDE_MEM_CODEX_TIMEOUT_MS', '', '180000')).toBeNull();
    expect(codexNumberError('CLAUDE_MEM_CODEX_TIMEOUT_MS', '5', '5')).toBeNull();
    expect(codexNumberError('CLAUDE_MEM_CODEX_TIMEOUT_MS', '6', '5')).toContain('30,000');
  });
});

describe('describeCodexExecCap', () => {
  it.each([
    [undefined, 0, false],
    ['', 0, false],
    ['0', 0, false],
    [' 150 ', 150, false],
    ['200', 200, false],
    ['-4', 0, true],
    ['abc', 0, true],
    ['2.5', 0, true],
    [200, 0, true],
  ])('reads %p as a limit of %p (problem: %p)', (raw, limit, problem) => {
    const described = describeCodexExecCap(raw);
    expect(described.limit).toBe(limit);
    expect(described.problem !== null).toBe(problem);
    expect(described.text).toBe(limit === 0 ? 'No local cap (0)' : `${limit} Codex calls per 5 hours`);
  });

  it('never goes below the runtime minimum', () => {
    expect(CODEX_CONFIG_BOUNDS.maxExecsPer5h.min).toBe(0);
    expect(describeCodexExecCap('-1').limit).toBe(CODEX_CONFIG_BOUNDS.maxExecsPer5h.min);
  });
});

describe('describeCodexQueueCap', () => {
  it.each([
    [undefined, 500, false],
    ['', 500, false],
    ['0', 0, false],
    ['50', 50, false],
    [' 800 ', 800, false],
    ['100000', 100_000, false],
    ['10', 50, true],
    ['-4', 0, true],
    ['250000', 100_000, true],
    ['abc', 500, true],
    ['2.5', 500, true],
    [300, 500, true],
  ])('reads %p as a cap of %p (problem: %p)', (raw, limit, problem) => {
    const described = describeCodexQueueCap(raw);
    expect(described.limit).toBe(limit);
    expect(described.problem !== null).toBe(problem);
    expect(described.text).toBe(limit === 0 ? 'No cap (0)' : `${limit.toLocaleString('en-US')} waiting observations per session`);
  });

  it('uses the runtime default and the lowest cap', () => {
    expect(describeCodexQueueCap(undefined).limit).toBe(CODEX_CONFIG_BOUNDS.maxQueuedObservations.fallback);
    expect(describeCodexQueueCap('1').limit).toBe(CODEX_CONFIG_BOUNDS.maxQueuedObservations.minCap);
  });
});
