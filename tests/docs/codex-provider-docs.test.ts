import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CODEX_CONFIG_BOUNDS } from '../../src/services/worker/CodexProvider.js';
import { CLAIM_MATCHING_LOOKAHEAD } from '../../src/services/worker/SessionMessageBuffer.js';
import { QUEUE_CAP_WARN_EVERY } from '../../src/services/worker/SessionManager.js';
import { SUBAGENT_EVENTS_MODES, SUBAGENT_WRITE_TOOLS } from '../../src/services/worker/http/shared.js';
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
import { buildSettingsSaveBody } from '../../src/ui/viewer/constants/codex';

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

/** CLAUDE_MEM_SUBAGENT_EVENTS's default from the DEFAULTS literal. */
function subagentEventsDefault(): string {
  const match = read('src/shared/SettingsDefaultsManager.ts').match(/^\s*CLAUDE_MEM_SUBAGENT_EVENTS:\s*'([^']*)',/m);
  expect(match).not.toBeNull();
  return match![1];
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
    expect(defaults.size).toBe(18);
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
    // 0 (no cap), or minCap..max.
    const { minCap, max } = CODEX_CONFIG_BOUNDS.maxQueuedObservations;
    const [, , queueCapValues, queueCapWhat] = tableRow(codexPage, 'CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS');
    expect(queueCapValues).toBe(`\`0\`, or \`${minCap}\`–\`${max}\``);
    // The runtime clamps a negative value to min 0, which is no cap, not minCap.
    expect(CODEX_CONFIG_BOUNDS.maxQueuedObservations.min).toBe(0);
    expect(queueCapWhat).toContain('and so does a negative value (read as `0`)');
  });

  it('documents the batching rules and the waiting-observation cap', () => {
    expect(codexPage).toContain('### How batching works');
    expect(codexPage).toContain('**One group per call.**');
    expect(codexPage).toContain('**A summary request is a barrier.**');
    expect(codexPage).toContain(`A call looks at most ${CLAIM_MATCHING_LOOKAHEAD} waiting tool uses ahead.`);
    expect(codexPage).not.toContain('Consecutive tool uses');
    // The drain takes the oldest waiting tool use next, which may be another group's.
    expect(codexPage).toContain("that tool use is sent first in its group's next call");
    expect(codexPage).toContain('and so does a negative value (read as `0`); any positive value is at least `50`');
    expect(codexPage).toContain('### The waiting-observation cap');
    expect(codexPage).toContain('`ai.codex.metrics.queuedObservationsDropped`');
    expect(codexPage).toContain(`then once per ${QUEUE_CAP_WARN_EVERY} drops`);
  });

  it('documents CLAUDE_MEM_SUBAGENT_EVENTS: what each mode keeps, the index, the metric, file/env only', () => {
    const [, defaultCell, effect] = tableRow(codexPage, 'CLAUDE_MEM_SUBAGENT_EVENTS');
    expect(documentedDefault(defaultCell)).toBe(subagentEventsDefault());
    for (const mode of SUBAGENT_EVENTS_MODES) expect(effect).toContain(`\`${mode}\``);
    expect(effect).toContain('File/env only');

    expect(codexPage).toContain('**Keep subagents to their file writes.**');
    expect(codexPage).toContain('- `all` (default): every one, as before.');
    const writesItem = codexPage.split('\n').find(line => line.startsWith('- `writes`:'));
    expect(writesItem).toBeDefined();
    for (const tool of SUBAGENT_WRITE_TOOLS) expect(writesItem).toContain(`\`${tool}\``);
    expect(writesItem).toContain('including its Bash commands, so a `git commit` made by a subagent is not remembered');
    expect(codexPage).toContain('- `none`: none.');
    expect(codexPage).toContain('Tool uses of the main session are never affected.');
    expect(codexPage).toContain('still stored in the tool-use index (the `get_tool_uses` MCP tool finds it)');
    expect(codexPage).toContain('`ai.codex.metrics.subagentEventsSkipped`');
    expect(codexPage).toContain('(`subagentEventsSkipped`)');
    expect(codexPage).toContain('"CLAUDE_MEM_SUBAGENT_EVENTS": "writes"');

    // File/env only: off the route's write allowlist, and named in the file/env-only bullet.
    expect(routeWriteAllowlist().has('CLAUDE_MEM_SUBAGENT_EVENTS')).toBe(false);
    const bullet = codexPage.split('\n').find(line => line.startsWith('- **File or environment only:**'));
    expect(bullet).toContain('`CLAUDE_MEM_SUBAGENT_EVENTS`');

    // "The viewer never sends them" holds for every key the bullet names (the
    // provider is the viewer's own select, sent only when changed).
    expect(bullet).toContain('the viewer never sends them');
    const named = [...bullet!.matchAll(/`(CLAUDE_MEM_[A-Z0-9_]+)`/g)].map(match => match[1]).filter(key => key !== 'CLAUDE_MEM_PROVIDER');
    expect(named).toContain('CLAUDE_MEM_SUBAGENT_EVENTS');
    for (const key of named) {
      expect(key in buildSettingsSaveBody({ [key]: 'changed' }, { [key]: 'stored' })).toBe(false);
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
      'CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS',
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

describe('docs/public/configuration.mdx CLAUDE_MEM_SUBAGENT_EVENTS row', () => {
  it('states the default, every mode, the write tools, the index and file/env only', () => {
    const [, defaultCell, description] = tableRow(configurationPage, 'CLAUDE_MEM_SUBAGENT_EVENTS');
    expect(documentedDefault(defaultCell)).toBe(subagentEventsDefault());
    for (const mode of SUBAGENT_EVENTS_MODES) expect(description).toContain(`\`${mode}\``);
    for (const tool of SUBAGENT_WRITE_TOOLS) expect(description).toContain(`\`${tool}\``);
    expect(description).toContain('Main-session tool uses are never affected');
    expect(description).toContain('`get_tool_uses`');
    expect(description).toContain('**File/env only**');
  });
});

describe('CLAUDE_MEM_DATA_DIR is documented as file/env only', () => {
  it('is off the route write allowlist and named in the file/env-only bullet', () => {
    expect(routeWriteAllowlist().has('CLAUDE_MEM_DATA_DIR')).toBe(false);
    // The viewer-never-sends check in the CLAUDE_MEM_SUBAGENT_EVENTS test above covers this key too.
    const bullet = codexPage.split('\n').find(line => line.startsWith('- **File or environment only:**'));
    expect(bullet).toContain('`CLAUDE_MEM_DATA_DIR`');
    expect(bullet).toContain('for `CLAUDE_MEM_DATA_DIR` it refuses every other value');
    expect(codexPage).toContain('relax a check, or move the data directory.');
  });

  it('says so in every configuration.mdx row and in Custom Data Directory', () => {
    const rows = configurationPage.split('\n').filter(line => line.startsWith('| `CLAUDE_MEM_DATA_DIR`'));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain('**File/env only**');
    const section = configurationPage.slice(configurationPage.indexOf('### Custom Data Directory'));
    expect(section).toContain('The data directory is **file/env only**');
    expect(section).toContain('refuses any value other than the one already stored');
  });
});

describe('CLAUDE_CODE_PATH and CLAUDE_MEM_CLAUDE_CONFIG_DIR are documented as file/env only', () => {
  const CLAUDE_KEYS = ['CLAUDE_CODE_PATH', 'CLAUDE_MEM_CLAUDE_CONFIG_DIR'];

  it('are off the route write allowlist, never sent by the viewer, and named in the file/env-only bullet', () => {
    const bullet = codexPage.split('\n').find(line => line.startsWith('- **File or environment only:**'));
    for (const key of CLAUDE_KEYS) {
      expect(routeWriteAllowlist().has(key)).toBe(false);
      expect(key in buildSettingsSaveBody({ [key]: 'changed' }, { [key]: 'stored' })).toBe(false);
      expect(bullet).toContain(`\`${key}\``);
    }
    expect(bullet).toContain('and so it does for `CLAUDE_CODE_PATH` and `CLAUDE_MEM_CLAUDE_CONFIG_DIR`');
    expect(bullet).toContain('the Claude binary and login also serve the knowledge agent, whatever the provider');
    expect(codexPage).toContain('change the Codex or Claude binary or login, relax a check, or move the data directory.');
  });

  it('say so, with the reason, in their configuration.mdx rows', () => {
    const [, , codePath] = tableRow(configurationPage, 'CLAUDE_CODE_PATH');
    expect(codePath).toContain('**File/env only**: claude-mem runs this binary');
    const [, , configDir] = tableRow(configurationPage, 'CLAUDE_MEM_CLAUDE_CONFIG_DIR');
    expect(configDir).toContain('**File/env only**: it decides which Claude login the SDK uses');
    for (const cell of [codePath, configDir]) {
      expect(cell).toContain('refuses any value other than the one already stored');
    }
  });
});

describe('the provider rule covers empty and non-string values', () => {
  it('says so under "Who can change what"', () => {
    const section = codexPage.slice(codexPage.indexOf('### Who can change what'), codexPage.indexOf('## The lockdown'));
    expect(section).toContain('The provider rule covers every value the API is sent, not only `codex`.');
    expect(section).toContain('an empty string, `null`, a number, `false`, an array or an object is refused and nothing is written, unless it is exactly the value already stored.');
    // The route accepts a body value equal to the stored one even when that is
    // '' or null (settings-routes-presence.test.ts), so the doc must not claim
    // such values are refused whatever is stored.
    expect(section).not.toContain('whatever provider is stored');
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
