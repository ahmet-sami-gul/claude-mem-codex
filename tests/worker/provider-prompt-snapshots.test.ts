/**
 * Byte snapshots of what OpenRouter and Gemini send, taken BEFORE the M4 cost
 * hooks existed (commit 86919004) and compared on every run since.
 *
 * M4 added opt-in hooks to OpenAICompatibleProvider (deferred init, fresh
 * generation, observation batching) and refactored src/sdk/prompts.ts
 * (renderObservationEnvelope + OBSERVATION_REPLY_RULES, envelope-tag
 * escaping). Every one of those is supposed to be invisible to a provider
 * that does not opt in, and "the suite still passes" is weaker than that
 * claim. These snapshots pin it down to the byte:
 *
 *   - the prompt builders, on inputs that contain no
 *     `<observed_from_primary_session` / `</observed_from_primary_session`
 *     sequence (on inputs that DO contain one the output changed on purpose —
 *     see tests/sdk/prompt-envelope-escaping.test.ts);
 *   - the exact HTTP request bodies OpenRouter and Gemini put on the wire for
 *     a whole generator run (init, two observations, a summary), driven
 *     through the REAL SessionManager and its in-RAM buffer;
 *   - how many queries were issued, with how many arguments, and which
 *     buffered message ids each confirm removed (the claim/confirm sequence).
 *
 * The fixture is tests/fixtures/provider-prompt-snapshots.json. It is only
 * ever (re)written with CLAUDE_MEM_UPDATE_PROMPT_SNAPSHOTS=1, which must NOT be
 * used to paper over a diff: a changed byte here is a behaviour change for
 * every OpenRouter/Gemini user.
 */

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../../src/services/domain/types.js';
import {
  buildContinuationPrompt,
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  type Observation,
} from '../../src/sdk/prompts.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import * as recycleConversation from '../../src/services/worker/session/recycle-conversation.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

const FIXTURE_URL = new URL('../fixtures/provider-prompt-snapshots.json', import.meta.url);
const UPDATE = process.env.CLAUDE_MEM_UPDATE_PROMPT_SNAPSHOTS === '1';
const FIXED_NOW = Date.parse('2026-09-21T09:00:00.000Z');

interface SnapshotFile {
  generatedFrom: string;
  builders: Record<string, string>;
  providers: Record<string, ProviderSnapshot>;
}

interface ProviderSnapshot {
  queryArgCounts: number[];
  requests: Array<{ url: string; body: unknown }>;
  confirmedIdSets: number[][];
  resetCalls: number;
  storeCalls: number;
  historyRoles: string[];
}

/**
 * Every mode prompt renders as «key», so the snapshot pins the TEMPLATE the
 * builders wrap around the mode text without also pinning the mode JSON,
 * which changes for reasons that have nothing to do with M4.
 */
function snapshotMode(): ModeConfig {
  const prompts = new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' ? `«${key}»` : undefined),
  });
  return {
    name: 'snapshot',
    prompts,
    observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
    observation_concepts: [],
  } as unknown as ModeConfig;
}

const PRIOR_CONTEXT = '# Earlier in this session\n- Read src/parser.ts\n- Ran the parser tests (3 pass)\n';

function observation(overrides: Partial<Observation>): Observation {
  return {
    id: 1,
    tool_name: 'Read',
    tool_input: JSON.stringify({ file_path: 'src/parser.ts' }),
    tool_output: JSON.stringify({ content: 'export function parse() {}' }),
    created_at_epoch: FIXED_NOW,
    cwd: '/work/snap',
    ...overrides,
  };
}

function builderOutputs(): Record<string, string> {
  const mode = snapshotMode();
  const bigField = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
  const base64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(20_000);
  return {
    init_no_context: buildInitPrompt('snap-project', 'content-snap', 'Refactor the parser', mode, ''),
    init_with_context: buildInitPrompt('snap-project', 'content-snap', 'Refactor the parser', mode, PRIOR_CONTEXT),
    init_markup_request: buildInitPrompt(
      'snap-project', 'content-snap', 'Fix <observation> parsing & the </turn> edge case', mode, '',
    ),
    continuation_no_context: buildContinuationPrompt('Now add tests', 2, 'content-snap', mode, ''),
    continuation_with_context: buildContinuationPrompt('Now add tests', 2, 'content-snap', mode, PRIOR_CONTEXT),
    observation_basic: buildObservationPrompt(observation({})),
    observation_no_cwd: buildObservationPrompt(observation({ cwd: undefined })),
    observation_plain_string_fields: buildObservationPrompt(observation({
      tool_name: 'Bash',
      tool_input: 'not json {',
      tool_output: 'plain output\nline 2',
    })),
    observation_oversized_field: buildObservationPrompt(observation({
      tool_output: JSON.stringify({ content: bigField }),
    })),
    observation_image_payload: buildObservationPrompt(observation({
      tool_name: 'mcp__browser__screenshot',
      tool_input: JSON.stringify({ action: 'screenshot' }),
      tool_output: JSON.stringify({
        content: [
          { type: 'text', text: 'Captured the viewport.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
        ],
      }),
    })),
    observation_markup_and_unicode: buildObservationPrompt(observation({
      tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: 'src/ü.ts', old: '<observation>', new: '</turn> &lt; <current_task>' }),
      tool_output: JSON.stringify({ ok: true, note: 'Türkçe karakterler \u{1F600}' }),
    })),
    summary: buildSummaryPrompt({
      id: 1,
      memory_session_id: 'mem-snap',
      project: 'snap-project',
      user_prompt: 'Refactor the parser',
      last_assistant_message: 'Parser refactored and tests pass.',
    }, mode),
  };
}

const OBSERVATION_REPLY = [
  '<observation>',
  '  <type>discovery</type>',
  '  <title>Parser entry point</title>',
  '  <subtitle>parse() lives in src/parser.ts</subtitle>',
  '  <facts><fact>parse is exported</fact></facts>',
  '  <narrative>The parser exposes a single parse() function.</narrative>',
  '  <concepts><concept>how-it-works</concept></concepts>',
  '  <files_read></files_read>',
  '  <files_modified></files_modified>',
  '</observation>',
].join('\n');

const SUMMARY_REPLY = [
  '<summary>',
  '  <request>Refactor the parser</request>',
  '  <investigated>src/parser.ts</investigated>',
  '  <learned>parse() is the only entry point</learned>',
  '  <completed>Refactor done, tests pass</completed>',
  '  <next_steps>None</next_steps>',
  '  <notes></notes>',
  '</summary>',
].join('\n');

function makeDbManager(storeObservations: ReturnType<typeof mock>): DatabaseManager {
  return {
    getSessionById: (id: number) => ({
      id,
      content_session_id: 'content-snap',
      project: 'snap-project',
      platform_source: 'claude',
      user_prompt: 'Refactor the parser',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      getLatestPromptTextFromUserPrompts: () => null,
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => undefined,
      linkToolUsesToObservation: () => 0,
      storeObservations,
    }),
    getChromaSync: () => ({
      syncObservation: () => Promise.resolve(),
      syncSummary: () => Promise.resolve(),
    }),
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
}

type ProviderKind = 'openrouter' | 'gemini';

/**
 * One whole generator run through the real SessionManager: two observations
 * and a summarize request are buffered first, then the provider drains them.
 * The run ends by aborting once the summary is stored, the same way a
 * shutdown ends a live generator.
 */
async function driveProvider(kind: ProviderKind): Promise<ProviderSnapshot> {
  const requests: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  let summaryStored = false;
  const storeObservations = mock((
    _memorySessionId: string, _project: string, observations: unknown[], summary: unknown,
  ) => {
    if (summary) summaryStored = true;
    return {
      observationIds: observations.map((_o, index) => 100 + index),
      summaryId: summary ? 7 : null,
      createdAtEpoch: FIXED_NOW,
    };
  });
  const dbManager = makeDbManager(storeObservations);
  const sessionManager = new SessionManager(dbManager);

  const session = sessionManager.initializeSession(1, 'Refactor the parser', 1);
  await sessionManager.queueObservation(1, {
    tool_name: 'Read',
    tool_input: { file_path: 'src/parser.ts' },
    tool_response: { content: 'export function parse() {}' },
    prompt_number: 1,
    cwd: '/work/snap',
    toolUseId: 'tu-1',
  });
  await sessionManager.queueObservation(1, {
    tool_name: 'Bash',
    tool_input: { command: 'bun test tests/parser.test.ts' },
    tool_response: { stdout: '3 pass\n0 fail', exitCode: 0 },
    prompt_number: 1,
    cwd: '/work/snap',
    toolUseId: 'tu-2',
  });
  await sessionManager.queueSummarize(1, 'Parser refactored and tests pass.');

  const confirmedIdSets: number[][] = [];
  const realConfirm = sessionManager.confirmClaimedMessages.bind(sessionManager);
  spyOn(sessionManager, 'confirmClaimedMessages').mockImplementation(async (sessionDbId: number) => {
    confirmedIdSets.push([...(sessionManager.getSession(sessionDbId)?.claimedMessageIds ?? [])]);
    const confirmed = await realConfirm(sessionDbId);
    if (summaryStored) {
      // The summary is the last buffered message: end the drain like a shutdown.
      queueMicrotask(() => session.abortController.abort());
    }
    return confirmed;
  });
  const reset = spyOn(sessionManager, 'resetProcessingToPending');

  let requestIndex = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? 'null'));
    requests.push({ url, body });
    const isInit = requestIndex === 0;
    const isSummary = requestIndex === 3;
    requestIndex++;
    const text = isInit ? 'Ready to observe.' : isSummary ? SUMMARY_REPLY : OBSERVATION_REPLY;
    const payload = kind === 'openrouter'
      ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = kind === 'openrouter'
      ? new OpenRouterProvider(dbManager, sessionManager)
      : new GeminiProvider(dbManager, sessionManager);
    const config = kind === 'openrouter'
      ? { apiKey: 'snap-key', model: 'snap/model', fallbackModels: [], apiUrl: 'https://gateway.test/v1/chat/completions' }
      : { apiKey: 'snap-key', model: 'gemini-flash-latest', rateLimitingEnabled: false };
    spyOn(provider as any, 'getConfig').mockReturnValue(config);
    const querySpy = spyOn(provider as any, 'query');

    await provider.startSession(session);

    return {
      queryArgCounts: querySpy.mock.calls.map(call => call.length),
      requests,
      confirmedIdSets,
      resetCalls: reset.mock.calls.length,
      storeCalls: storeObservations.mock.calls.length,
      historyRoles: session.conversationHistory.map(message => message.role),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readFixture(): SnapshotFile | null {
  return existsSync(FIXTURE_URL) ? JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as SnapshotFile : null;
}

describe('OpenRouter / Gemini prompt snapshots (tag-free inputs)', () => {
  beforeEach(() => {
    setSystemTime(new Date(FIXED_NOW));
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => snapshotMode(),
      loadMode: () => {},
    } as unknown as ModeManager));
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults());
    spyOn(recycleConversation, 'loadSessionStartContext').mockResolvedValue(PRIOR_CONTEXT);
    for (const level of ['debug', 'info', 'warn', 'error', 'success'] as const) {
      spyOn(logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    setSystemTime();
    mock.restore();
  });

  it('writes the fixture only when explicitly asked to', async () => {
    if (!UPDATE) {
      expect(readFixture()).not.toBeNull();
      return;
    }
    const snapshot: SnapshotFile = {
      generatedFrom: '86919004 (pre-M4 prompts.ts and OpenAICompatibleProvider.ts)',
      builders: builderOutputs(),
      providers: {
        openrouter: await driveProvider('openrouter'),
        gemini: await driveProvider('gemini'),
      },
    };
    writeFileSync(FIXTURE_URL, JSON.stringify(snapshot, null, 2) + '\n');
  });

  it('builds every prompt byte-for-byte as before M4', () => {
    const fixture = readFixture();
    expect(fixture).not.toBeNull();
    const actual = builderOutputs();
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture!.builders).sort());
    for (const [name, expected] of Object.entries(fixture!.builders)) {
      // One assertion per builder so a failure names the prompt that moved.
      expect({ name, prompt: actual[name] }).toEqual({ name, prompt: expected });
    }
  });

  for (const kind of ['openrouter', 'gemini'] as const) {
    it(`${kind}: puts the same request bodies on the wire, with the same query and confirm sequence`, async () => {
      const fixture = readFixture();
      expect(fixture).not.toBeNull();
      const actual = await driveProvider(kind);
      const expected = fixture!.providers[kind];

      // Sanity: the run really covered init + two observations + a summary.
      expect(expected.requests).toHaveLength(4);
      expect(actual.queryArgCounts).toEqual(expected.queryArgCounts);
      expect(actual.confirmedIdSets).toEqual(expected.confirmedIdSets);
      expect(actual.resetCalls).toBe(expected.resetCalls);
      expect(actual.storeCalls).toBe(expected.storeCalls);
      expect(actual.historyRoles).toEqual(expected.historyRoles);
      expect(actual.requests.length).toBe(expected.requests.length);
      for (let i = 0; i < expected.requests.length; i++) {
        expect({ request: i, ...actual.requests[i] }).toEqual({ request: i, ...expected.requests[i] });
      }
    });
  }
});
