import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';

/**
 * POST /api/settings for the CLAUDE_MEM_CODEX_* keys (plan 3.1).
 *
 * This route is UNAUTHENTICATED and reachable from any page the user has open,
 * and the settings behind it now decide how much of a paid ChatGPT plan the
 * observer may spend. So the coverage here is mostly about what must NOT be
 * writable: the provider switch itself, and the seven cost levers. The viewer
 * posts the whole GET body back unchanged, so the same rules also have to
 * accept every value the GET returned.
 *
 * paths.settings() resolves under the per-run temp DATA_DIR that
 * tests/preload.ts pins, so no real ~/.claude-mem file is touched.
 */

function createMockReqRes(body: unknown): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/api/settings', params: {}, query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

type Handler = (req: Request, res: Response) => void;

function captureHandlers(routes: SettingsRoutes): { post: Handler; get: Handler } {
  let post!: Handler;
  let get!: Handler;
  const app: any = {
    get: mock((path: string, handler: Handler) => {
      if (path === '/api/settings') get = handler;
    }),
    post: mock((path: string, ...handlers: Handler[]) => {
      if (path === '/api/settings') post = handlers[handlers.length - 1];
    }),
  };
  routes.setupRoutes(app);
  return { post, get };
}

describe('SettingsRoutes — CLAUDE_MEM_CODEX_* (plan 3.1)', () => {
  const settingsPath = paths.settings();
  let priorSettingsContent: string | undefined;
  let priorProviderEnv: string | undefined;
  let handlers: { post: Handler; get: Handler };

  // The codex baseline is spelled out rather than read from getAllDefaults():
  // another file in the same `bun test` process mock.module's
  // SettingsDefaultsManager with a four-key stub and never restores it (bun's
  // mock.module is process-global), so "the defaults" are not dependable here.
  // What these tests need is a settings.json whose codex values are known.
  const CODEX_BASELINE: Record<string, string> = {
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_CODEX_PATH: '',
    CLAUDE_MEM_CODEX_HOME: '',
    CLAUDE_MEM_CODEX_MODEL: 'gpt-5.6-luna',
    CLAUDE_MEM_CODEX_SUMMARY_MODEL: '',
    CLAUDE_MEM_CODEX_REASONING_EFFORT: 'low',
    CLAUDE_MEM_CODEX_VERBOSITY: 'low',
    CLAUDE_MEM_CODEX_TIMEOUT_MS: '180000',
    CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: '120000',
    CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: '4',
    CLAUDE_MEM_CODEX_BATCH_MAX_CHARS: '48000',
    CLAUDE_MEM_CODEX_BATCH_LINGER_MS: '2000',
    CLAUDE_MEM_CODEX_FIELD_COMPRESSION: 'false',
    CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '0',
    CLAUDE_MEM_CODEX_TRANSPORT: 'exec',
    CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT: '0',
    CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS: '300000',
    CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION: 'false',
  };

  function persist(overrides: Record<string, string>): void {
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...SettingsDefaultsManager.getAllDefaults(), ...CODEX_BASELINE, ...overrides }, null, 2),
      'utf-8',
    );
  }

  function persisted(): Record<string, string> {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }

  function post(body: Record<string, unknown>): ReturnType<typeof createMockReqRes> {
    const mocks = createMockReqRes(body);
    handlers.post(mocks.req as Request, mocks.res as Response);
    return mocks;
  }

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    // loadFromFile applies env overrides last, and "what is persisted" is what
    // the codex rules compare against — pin it to the file for these tests.
    priorProviderEnv = process.env.CLAUDE_MEM_PROVIDER;
    delete process.env.CLAUDE_MEM_PROVIDER;
    persist({});
    handlers = captureHandlers(new SettingsRoutes({} as any));
  });

  afterEach(() => {
    if (priorProviderEnv === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
    else process.env.CLAUDE_MEM_PROVIDER = priorProviderEnv;
    if (priorSettingsContent === undefined) {
      try {
        rmSync(settingsPath, { force: true });
      } catch {
        // best effort
      }
    } else {
      writeFileSync(settingsPath, priorSettingsContent, 'utf-8');
    }
  });

  it('keeps the viewer round-trip working for a codex install (GET body posted back unchanged)', () => {
    persist({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_PATH: '/opt/codex/bin/codex' });
    const read = createMockReqRes({});
    handlers.get(read.req as Request, read.res as Response);
    const body = read.jsonSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(body.CLAUDE_MEM_PROVIDER).toBe('codex');

    const { jsonSpy } = post(body);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted().CLAUDE_MEM_PROVIDER).toBe('codex');
    expect(persisted().CLAUDE_MEM_CODEX_PATH).toBe('/opt/codex/bin/codex');
  });

  it('refuses to SWITCH the provider to codex over the API', () => {
    persist({ CLAUDE_MEM_PROVIDER: 'claude' });

    const { statusSpy, jsonSpy } = post({ CLAUDE_MEM_PROVIDER: 'codex' });

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.stringContaining('settings.json'),
    }));
    expect(persisted().CLAUDE_MEM_PROVIDER).toBe('claude');
  });

  it('still accepts the other providers over the API', () => {
    const { jsonSpy } = post({ CLAUDE_MEM_PROVIDER: 'gemini' });

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted().CLAUDE_MEM_PROVIDER).toBe('gemini');
  });

  it('writes the tuning levers a viewer legitimately offers', () => {
    const { jsonSpy } = post({
      CLAUDE_MEM_CODEX_MODEL: 'gpt-5.6-terra',
      CLAUDE_MEM_CODEX_SUMMARY_MODEL: 'gpt-5.5',
      CLAUDE_MEM_CODEX_REASONING_EFFORT: 'medium',
      CLAUDE_MEM_CODEX_VERBOSITY: 'high',
      CLAUDE_MEM_CODEX_TIMEOUT_MS: '240000',
      CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS: '150000',
      CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: '6',
      CLAUDE_MEM_CODEX_BATCH_MAX_CHARS: '60000',
      CLAUDE_MEM_CODEX_BATCH_LINGER_MS: '1000',
      CLAUDE_MEM_CODEX_FIELD_COMPRESSION: 'true',
    });

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted()).toMatchObject({
      CLAUDE_MEM_CODEX_MODEL: 'gpt-5.6-terra',
      CLAUDE_MEM_CODEX_SUMMARY_MODEL: 'gpt-5.5',
      CLAUDE_MEM_CODEX_REASONING_EFFORT: 'medium',
      CLAUDE_MEM_CODEX_VERBOSITY: 'high',
      CLAUDE_MEM_CODEX_TIMEOUT_MS: '240000',
      CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: '6',
      CLAUDE_MEM_CODEX_FIELD_COMPRESSION: 'true',
    });
  });

  it.each([
    ['CLAUDE_MEM_CODEX_PATH', '/tmp/attacker-codex'],
    ['CLAUDE_MEM_CODEX_HOME', '/tmp/attacker-codex-home'],
    ['CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H', '0'],
    ['CLAUDE_MEM_CODEX_TRANSPORT', 'exec'],
    ['CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT', '50'],
    ['CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS', '3600000'],
    ['CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION', 'true'],
  ])('accepts but never persists the cost lever %s', (key, value) => {
    persist({ CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '40', [key]: key === 'CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H' ? '40' : '' });
    const before = persisted()[key];

    const { jsonSpy } = post({ [key]: value });

    // Valid, so the round-trip is not broken — just not written.
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted()[key]).toBe(before);
  });

  it('pins a model written over the API to the allowlist', () => {
    const { statusSpy, jsonSpy } = post({ CLAUDE_MEM_CODEX_MODEL: 'gpt-4o-mini' });

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('gpt-5.6-luna'),
    }));
    expect(persisted().CLAUDE_MEM_CODEX_MODEL).toBe('gpt-5.6-luna');
  });

  it('accepts a non-allowlisted model that is already the persisted value', () => {
    // settings.json may carry a newer catalogue id; the viewer must still be
    // able to save the rest of the form.
    persist({ CLAUDE_MEM_CODEX_MODEL: 'gpt-5.7-future' });
    handlers = captureHandlers(new SettingsRoutes({} as any));

    const { jsonSpy } = post({ CLAUDE_MEM_CODEX_MODEL: 'gpt-5.7-future', CLAUDE_MEM_CODEX_VERBOSITY: 'medium' });

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted().CLAUDE_MEM_CODEX_MODEL).toBe('gpt-5.7-future');
    expect(persisted().CLAUDE_MEM_CODEX_VERBOSITY).toBe('medium');
  });

  it.each([
    ['CLAUDE_MEM_CODEX_REASONING_EFFORT', 'extreme'],
    ['CLAUDE_MEM_CODEX_VERBOSITY', 'loud'],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '5'],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', '900000'],
    ['CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS', '10000'],
    ['CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS', '40'],
    ['CLAUDE_MEM_CODEX_BATCH_MAX_CHARS', '500'],
    ['CLAUDE_MEM_CODEX_BATCH_LINGER_MS', '60000'],
    ['CLAUDE_MEM_CODEX_FIELD_COMPRESSION', 'yes'],
    ['CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H', '-1'],
    ['CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT', '80'],
    ['CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS', '1000'],
    ['CLAUDE_MEM_CODEX_TRANSPORT', 'app-server'],
    ['CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION', 'maybe'],
  ])('rejects %s = %s with 400 and writes nothing', (key, value) => {
    const before = readFileSync(settingsPath, 'utf-8');

    const { statusSpy } = post({ [key]: value });

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('rejects a type-confused codex path instead of letting it reach path handling', () => {
    const { statusSpy } = post({ CLAUDE_MEM_CODEX_PATH: 42 });
    expect(statusSpy).toHaveBeenCalledWith(400);

    const whitespace = post({ CLAUDE_MEM_CODEX_HOME: '   ' });
    expect(whitespace.statusSpy).toHaveBeenCalledWith(400);
  });

  /**
   * The numeric keys are the type-confusion hole the PATH/HOME guard above was
   * written to close: five of them ARE on the write allowlist, `Number(value)`
   * accepts a JSON number, boolean and one-element array alike, and the write
   * loop then assigns req.body[key] verbatim. A single unauthenticated local
   * POST would leave settings.json holding a non-string that every codex path
   * has to cope with.
   */
  it.each([
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', 240000],
    ['CLAUDE_MEM_CODEX_TIMEOUT_MS', [240000]],
    ['CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS', 150000],
    ['CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS', 6],
    ['CLAUDE_MEM_CODEX_BATCH_MAX_CHARS', [20000]],
    ['CLAUDE_MEM_CODEX_BATCH_LINGER_MS', true],
    ['CLAUDE_MEM_CODEX_FIELD_COMPRESSION', true],
    ['CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H', 40],
  ])('rejects the non-string %s = %p and writes nothing', (key, value) => {
    const before = readFileSync(settingsPath, 'utf-8');

    const { statusSpy } = post({ [key]: value });

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  /**
   * Validation runs over the WHOLE body and the viewer posts the whole GET body
   * back, so a value the route will not even write must not be able to 400
   * every future save. These seven levers are file/env only — there is no form
   * field for them and no write path — and the runtime is the lenient half of
   * the pair (getConfig warns and clamps). A user who set one outside its
   * bounds must still be able to save unrelated settings from the viewer.
   */
  it.each([
    ['CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT', '60'],
    ['CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS', '30000'],
    ['CLAUDE_MEM_CODEX_TRANSPORT', 'exec-resume'],
    ['CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H', '-4'],
    ['CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION', 'yes'],
  ])('keeps the viewer round-trip working when %s is out of bounds in settings.json', (key, value) => {
    persist({ [key]: value });
    handlers = captureHandlers(new SettingsRoutes({} as any));
    const read = createMockReqRes({});
    handlers.get(read.req as Request, read.res as Response);
    const body = read.jsonSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(body[key]).toBe(value);

    // The same body back, plus one setting the user actually changed.
    const { jsonSpy, statusSpy } = post({ ...body, CLAUDE_MEM_CODEX_VERBOSITY: 'medium' });

    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(persisted().CLAUDE_MEM_CODEX_VERBOSITY).toBe('medium');
    // Still file/env only: accepted, never written.
    expect(persisted()[key]).toBe(value);
  });

  /**
   * The gate is symmetric or it is a trapdoor: an unauthenticated POST that
   * moved a codex install onto Claude could never be undone over the API,
   * which is exactly the silent fall-back the dispatch rule exists to prevent.
   * The shipped viewer makes it reachable by accident — its provider select has
   * no codex option, so a codex install shows an unmatched value.
   */
  it.each(['claude', 'gemini', 'openrouter'])('refuses to switch a codex install to %s over the API', provider => {
    persist({ CLAUDE_MEM_PROVIDER: 'codex' });
    handlers = captureHandlers(new SettingsRoutes({} as any));

    const { statusSpy, jsonSpy } = post({ CLAUDE_MEM_PROVIDER: provider });

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.stringContaining('settings.json'),
    }));
    expect(persisted().CLAUDE_MEM_PROVIDER).toBe('codex');
  });
});
