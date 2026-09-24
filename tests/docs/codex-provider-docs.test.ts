import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CODEX_CONFIG_BOUNDS } from '../../src/services/worker/CodexProvider.js';
import {
  CODEX_CONFIG_PINS,
  CODEX_DEFAULT_MODEL,
  CODEX_DISABLED_FEATURES,
  CODEX_FORCED_ENABLED_FEATURES,
  CODEX_MODEL_ALLOWLIST,
  CODEX_MODEL_MIN_CLI_VERSION,
  MODEL_ID_RE,
  buildCodexProbeArgs,
  type CodexProbeKind,
} from '../../src/services/worker/codex/codex-invocation.js';
import { CODEX_ENV_FORCED } from '../../src/services/worker/codex/codex-env.js';
import { classifyCodexFailure } from '../../src/services/worker/codex/codex-errors.js';
import {
  CODEX_ACCEPTED_EXPERIMENTAL_TOOLS,
  CODEX_PROBE_ORDER,
  CODEX_PROBE_TIMEOUTS_MS,
  CODEX_TESTED_VERSION_RANGE,
} from '../../src/services/worker/codex/codex-self-check.js';

/**
 * The Codex provider docs (plan 3.11) against the code they describe.
 *
 * The settings table is the part users copy from, so every key, default and
 * range in it is checked here against SettingsDefaultsManager, the runtime
 * bounds, and the settings route's write allowlist. Both sources are read as
 * text on purpose: SettingsDefaultsManager is mock.module'd with stubs by
 * other test files in the same bun process, and the route's allowlist is a
 * local array.
 */

const ROOT = join(import.meta.dir, '../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf-8');

const codexPage = read('docs/public/usage/codex-provider.mdx');
const configurationPage = read('docs/public/configuration.mdx');

/** CLAUDE_MEM_CODEX_* defaults from the DEFAULTS literal, minus the unrelated host-integration key. */
function serverCodexDefaults(): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const match of read('src/shared/SettingsDefaultsManager.ts').matchAll(/^\s*(CLAUDE_MEM_CODEX_[A-Z0-9_]+):\s*'([^']*)',/gm)) {
    if (match[1] === 'CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION') continue;
    defaults.set(match[1], match[2]);
  }
  return defaults;
}

/** The keys POST /api/settings writes (the `settingKeys` array in SettingsRoutes). */
function routeWriteAllowlist(): Set<string> {
  const source = read('src/services/worker/http/routes/SettingsRoutes.ts');
  const block = source.slice(source.indexOf('const settingKeys = ['), source.indexOf('];', source.indexOf('const settingKeys = [')));
  return new Set([...block.matchAll(/'([A-Z0-9_]+)'/g)].map(match => match[1]));
}

/** Cells of the markdown table row whose first cell is `key`. */
function tableRow(page: string, key: string): string[] {
  const line = page.split('\n').find(row => row.startsWith(`| \`${key}\``));
  expect(line).toBeDefined();
  return line!.split('|').slice(1, -1).map(cell => cell.trim());
}

function documentedDefault(cell: string): string {
  return cell === 'empty' || cell === '—' ? '' : cell.replace(/^`|`$/g, '');
}

const RANGED: Record<string, { min: number; max: number }> = {
  CLAUDE_MEM_CODEX_TIMEOUT_MS: CODEX_CONFIG_BOUNDS.timeoutMs,
  CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: CODEX_CONFIG_BOUNDS.maxConversationChars,
  CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: CODEX_CONFIG_BOUNDS.batchMaxObservations,
  CLAUDE_MEM_CODEX_BATCH_MAX_CHARS: CODEX_CONFIG_BOUNDS.batchMaxChars,
  CLAUDE_MEM_CODEX_BATCH_LINGER_MS: CODEX_CONFIG_BOUNDS.batchLingerMs,
  CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT: CODEX_CONFIG_BOUNDS.quotaReservePercent,
  CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS: CODEX_CONFIG_BOUNDS.rateLimitProbeMs,
};

describe('docs/public/usage/codex-provider.mdx', () => {
  const defaults = serverCodexDefaults();

  it('documents every codex setting with its exact default', () => {
    expect(defaults.size).toBe(17);
    for (const [key, value] of defaults) {
      const [, defaultCell] = tableRow(codexPage, key);
      expect(documentedDefault(defaultCell)).toBe(value);
    }
  });

  it('documents the exact range of every ranged setting', () => {
    for (const [key, { min, max }] of Object.entries(RANGED)) {
      const [, , values] = tableRow(codexPage, key);
      expect(values).toContain(`\`${min}\`–\`${max}\``);
    }
  });

  it('lists the allowlisted models and the file/env model pattern', () => {
    const [, , values] = tableRow(codexPage, 'CLAUDE_MEM_CODEX_MODEL');
    for (const model of CODEX_MODEL_ALLOWLIST) {
      expect(values).toContain(`\`${model}\``);
    }
    expect(values).toContain(`\`${MODEL_ID_RE.source}\``);
  });

  it('names exactly the file/env-only keys the settings route refuses to write', () => {
    const writable = routeWriteAllowlist();
    const fileOnly = [...defaults.keys()].filter(key => !writable.has(key)).sort();
    expect(fileOnly).toEqual([
      'CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION',
      'CLAUDE_MEM_CODEX_HOME',
      'CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H',
      'CLAUDE_MEM_CODEX_PATH',
      'CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT',
      'CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS',
      'CLAUDE_MEM_CODEX_TRANSPORT',
    ]);

    const bullet = codexPage.split('\n').find(line => line.startsWith('- **File or environment only:**'));
    expect(bullet).toBeDefined();
    const listed = [...bullet!.matchAll(/`(CLAUDE_MEM_CODEX_[A-Z0-9_]+)`/g)].map(match => match[1]).sort();
    expect(listed).toEqual(fileOnly);

    // And the not-in-the-viewer bullet names exactly the writable keys the viewer does not show.
    const apiBullet = codexPage.split('\n').find(line => line.startsWith('- **In `settings.json` or through the API, not in the viewer:**'));
    expect(apiBullet).toBeDefined();
    const apiOnly = [...apiBullet!.matchAll(/`(CLAUDE_MEM_CODEX_[A-Z0-9_]+)`/g)].map(match => match[1]).sort();
    expect(apiOnly).toEqual([
      'CLAUDE_MEM_CODEX_BATCH_LINGER_MS',
      'CLAUDE_MEM_CODEX_BATCH_MAX_CHARS',
      'CLAUDE_MEM_CODEX_FIELD_COMPRESSION',
      'CLAUDE_MEM_CODEX_SUMMARY_MODEL',
    ]);
    for (const key of apiOnly) expect(writable.has(key)).toBe(true);
  });

  it('counts the disabled Codex features correctly', () => {
    expect(codexPage).toContain(`${CODEX_DISABLED_FEATURES.length} Codex features turned off`);
  });

  it('states the tested codex-cli range', () => {
    expect(codexPage).toContain(`${CODEX_TESTED_VERSION_RANGE.minInclusive.join('.')} up to (not including) ${CODEX_TESTED_VERSION_RANGE.maxExclusive.slice(0, 2).join('.')}`);
  });

  it('shows the exec argv with --strict-config, the 0.156 pins and the forced exec-server env', () => {
    expect(codexPage).toContain('codex exec --strict-config --json');
    for (const key of ['agents.enabled', 'tools.update_plan.enabled', 'tools.experimental_request_user_input.enabled', 'skills.bundled.enabled']) {
      expect(codexPage).toContain(`\`${key}=${CODEX_CONFIG_PINS[key]}\``);
    }
    expect(codexPage).toContain(`\`CODEX_EXEC_SERVER_URL=${CODEX_ENV_FORCED.CODEX_EXEC_SERVER_URL}\``);
    for (const feature of CODEX_FORCED_ENABLED_FEATURES) {
      expect(codexPage).toContain(`**\`${feature}\` stays on.**`);
    }
  });

  it('lists every self-check probe, in order, with the catalog probe and its accepted tools', () => {
    // The numbered list follows the order the self-check runs the probes in.
    expect([...CODEX_PROBE_ORDER].sort()).toEqual((Object.keys(CODEX_PROBE_TIMEOUTS_MS) as CodexProbeKind[]).sort());
    const commands = CODEX_PROBE_ORDER.map(kind => `codex ${buildCodexProbeArgs(kind, { model: CODEX_DEFAULT_MODEL }).slice(0, 2).join(' ')}`);
    const documented = [...codexPage.matchAll(/^\d\. `(codex [^`]+)`/gm)].map(match => match[1]);
    expect(documented).toEqual(commands);
    expect(codexPage).toContain('the worker runs five probes');
    expect(codexPage).not.toContain('four probes');

    const catalogItem = codexPage.split('\n').find(line => line.startsWith('3. `codex debug models`'));
    expect(catalogItem).toBeDefined();
    for (const tool of CODEX_ACCEPTED_EXPERIMENTAL_TOOLS) {
      expect(catalogItem).toContain(`\`${tool}\``);
    }

    const longest = Math.max(...Object.values(CODEX_PROBE_TIMEOUTS_MS)) / 1000;
    expect(codexPage).toContain(`(5–${longest} s limit)`);
  });

  it('states the minimum codex-cli version of each model that has one, and how the gate fails', () => {
    const versionItem = codexPage.split('\n').find(line => line.startsWith('1. `codex --version`'));
    expect(versionItem).toBeDefined();
    for (const [model, [major, minor]] of Object.entries(CODEX_MODEL_MIN_CLI_VERSION)) {
      expect(versionItem).toContain(`\`${model}\``);
      expect(versionItem).toContain(`${major}.${minor}`);
    }

    const outcome = classifyCodexFailure({ condition: 'model_needs_newer_cli' });
    if (outcome.type !== 'error') throw new Error('model_needs_newer_cli must classify as an error');
    expect(outcome.error.code).toBe('codex_model_needs_newer_cli');
    expect(tableRow(codexPage, 'version`, `codex_model_needs_newer_cli')[0]).toBe('`version`, `codex_model_needs_newer_cli`');
    expect(tableRow(codexPage, 'models_catalog')[0]).toStartWith('`models_catalog`');
  });
});

describe('docs/public/configuration.mdx codex table', () => {
  it('uses the same defaults as the code', () => {
    for (const [key, value] of serverCodexDefaults()) {
      const [, defaultCell] = tableRow(configurationPage, key);
      expect(documentedDefault(defaultCell)).toBe(value);
    }
  });
});

describe('docs navigation', () => {
  it('lists the codex page right after the gemini page', () => {
    const pages: string[] = JSON.parse(read('docs/public/docs.json')).navigation.groups
      .flatMap((group: { pages: unknown[] }) => group.pages.filter((page): page is string => typeof page === 'string'));
    const gemini = pages.indexOf('usage/gemini-provider');
    expect(gemini).toBeGreaterThanOrEqual(0);
    expect(pages[gemini + 1]).toBe('usage/codex-provider');
  });
});
