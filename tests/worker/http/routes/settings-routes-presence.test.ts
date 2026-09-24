import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';
import { DEFAULT_SETTINGS } from '../../../../src/ui/viewer/constants/settings';
import { OTHER_FILE_ONLY_KEYS, buildSettingsSaveBody } from '../../../../src/ui/viewer/constants/codex';

/**
 * POST /api/settings over real HTTP, against an in-process express app with
 * the worker's JSON body parser in front of SettingsRoutes. paths.settings()
 * resolves under the per-run temp DATA_DIR that tests/preload.ts pins, so the
 * real ~/.claude-mem is never touched, and no request reaches a live worker.
 *
 * The route has no authentication, and every key it writes is written as
 * sent unless validation refuses it. What this file pins down:
 *
 *   - keys that select the provider, the Claude auth mode or the worker's bind
 *     are validated when PRESENT, not when truthy: '' / null / 0 / false used
 *     to skip the check and be written, which over a stored 'codex' switched
 *     observation to Claude at once (dispatch checks === 'codex') and left the
 *     API unable to switch back;
 *   - CLAUDE_CODE_PATH and CLAUDE_MEM_CLAUDE_CONFIG_DIR (the Claude binary and
 *     login) are file/env only;
 *   - a body that is not a JSON object is a 400, not a 500, and writes nothing;
 *   - the viewer's save keeps working through all of it.
 */

const PINNED_ENV = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
  'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_WORKER_PORT',
  'CLAUDE_CODE_PATH',
  'CLAUDE_MEM_CLAUDE_CONFIG_DIR',
];

// Spelled out rather than trusted to getAllDefaults(): other files in the same
// bun process mock.module SettingsDefaultsManager (see
// settings-routes-codex.test.ts).
const BASELINE: Record<string, string> = {
  CLAUDE_MEM_PROVIDER: 'claude',
  CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
  CLAUDE_MEM_WORKER_PORT: '37777',
  CLAUDE_CODE_PATH: '',
  CLAUDE_MEM_CLAUDE_CONFIG_DIR: '',
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
};

const OK = { success: true, message: 'Settings updated successfully' };
const PROVIDER_ERROR = 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", "openrouter", or "codex"';
const EMPTY_AND_NON_STRING: unknown[] = ['', null, 0, false, [], {}];

describe('POST /api/settings — presence validation, Claude keys, body shape', () => {
  const settingsPath = paths.settings();
  let server: Server;
  let base: string;
  let priorSettingsContent: string | undefined;
  const priorEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const app = express();
    // What createMiddleware() (src/services/worker/http/middleware.ts) mounts
    // in front of every worker route.
    app.use(express.json({ limit: '5mb' }));
    new SettingsRoutes({} as any).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    // loadFromFile applies env overrides last; "what is stored" must be the file here.
    for (const key of PINNED_ENV) {
      priorEnv[key] = process.env[key];
      delete process.env[key];
    }
    persist({});
  });

  afterEach(() => {
    for (const key of PINNED_ENV) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
    if (priorSettingsContent === undefined) {
      rmSync(settingsPath, { force: true });
    } else {
      writeFileSync(settingsPath, priorSettingsContent, 'utf-8');
    }
  });

  function persist(overrides: Record<string, unknown>): void {
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...SettingsDefaultsManager.getAllDefaults(), ...BASELINE, ...overrides }, null, 2),
      'utf-8',
    );
  }

  function stored(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }

  async function post(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function getSettings(): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(200);
    return await res.json() as Record<string, unknown>;
  }

  /** What the modal posts: the GET result merged as useSettings does, plus the user's edits. */
  async function viewerSave(edits: Record<string, unknown>): Promise<{ status: number; json: any; body: Record<string, unknown> }> {
    const fromGet = { ...DEFAULT_SETTINGS, ...(await getSettings()) } as Record<string, unknown>;
    const body = buildSettingsSaveBody({ ...fromGet, ...edits }, fromGet);
    return { ...(await post(body)), body };
  }

  /** 400 with `error`, and settings.json byte for byte as it was. */
  async function expectRefused(body: unknown, error: string | ((message: string) => boolean)): Promise<void> {
    const before = readFileSync(settingsPath, 'utf-8');
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(json.success).toBe(false);
    if (typeof error === 'string') expect(json.error).toBe(error);
    else expect(error(json.error)).toBe(true);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  }

  // -------------------------------------------------------------------------
  // A. CLAUDE_MEM_PROVIDER
  // -------------------------------------------------------------------------

  describe('CLAUDE_MEM_PROVIDER is validated on presence', () => {
    for (const storedProvider of ['codex', 'claude']) {
      it.each(EMPTY_AND_NON_STRING.map(value => [value]))(
        `refuses %p over a stored ${storedProvider} and writes nothing`,
        async value => {
          persist({ CLAUDE_MEM_PROVIDER: storedProvider });
          // An unrelated edit in the same request is refused with it.
          await expectRefused({ CLAUDE_MEM_PROVIDER: value, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' }, PROVIDER_ERROR);
          expect(stored().CLAUDE_MEM_PROVIDER).toBe(storedProvider);
        },
      );
    }

    it.each([
      ['claude', 'gemini'],
      ['claude', 'openrouter'],
      ['gemini', 'claude'],
      ['gemini', 'openrouter'],
      ['openrouter', 'claude'],
      ['openrouter', 'gemini'],
    ])('still switches %s to %s', async (from, to) => {
      persist({ CLAUDE_MEM_PROVIDER: from });
      const { status, json } = await post({ CLAUDE_MEM_PROVIDER: to });
      expect(status).toBe(200);
      expect(json).toEqual(OK);
      expect(stored().CLAUDE_MEM_PROVIDER).toBe(to);
    });

    it.each(['claude', 'gemini', 'openrouter'])('still refuses to switch %s to codex', async from => {
      persist({ CLAUDE_MEM_PROVIDER: from });
      await expectRefused(
        { CLAUDE_MEM_PROVIDER: 'codex' },
        'CLAUDE_MEM_PROVIDER can only be switched to "codex" in settings.json or the environment, not over the API',
      );
    });

    it.each(['claude', 'gemini', 'openrouter'])('still refuses to switch codex to %s', async to => {
      persist({ CLAUDE_MEM_PROVIDER: 'codex' });
      await expectRefused(
        { CLAUDE_MEM_PROVIDER: to },
        'CLAUDE_MEM_PROVIDER can only be switched away from "codex" in settings.json or the environment, not over the API',
      );
    });

    it.each(['codex', 'claude', 'gemini', 'openrouter'])('accepts the stored %s back', async provider => {
      persist({ CLAUDE_MEM_PROVIDER: provider });
      const { status } = await post({ CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
      expect(status).toBe(200);
      expect(stored()).toMatchObject({ CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
    });

    it('accepts a hand-edited empty provider back unchanged, and nothing but a listed one over it', async () => {
      persist({ CLAUDE_MEM_PROVIDER: '' });
      expect((await post({ CLAUDE_MEM_PROVIDER: '', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' })).status).toBe(200);
      expect(stored()).toMatchObject({ CLAUDE_MEM_PROVIDER: '', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });

      await expectRefused({ CLAUDE_MEM_PROVIDER: null }, PROVIDER_ERROR);
      await expectRefused({ CLAUDE_MEM_PROVIDER: 'anthropic' }, PROVIDER_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // B. The other truthy-gated validators whose empty value reaches the
  //    provider/auth choice or the worker's bind.
  // -------------------------------------------------------------------------

  describe('the worker bind and the Claude auth mode are validated on presence', () => {
    const B_KEYS = ['CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_CLAUDE_AUTH_METHOD'];

    for (const key of B_KEYS) {
      it.each(EMPTY_AND_NON_STRING.map(value => [value]))(`refuses ${key} = %p and writes nothing`, async value => {
        await expectRefused({ [key]: value, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' }, message => message.startsWith(`${key} must be`));
        expect(stored()[key]).toBe(BASELINE[key]);
      });
    }

    it('refuses a host that only matches once coerced to a string', async () => {
      // RegExp.test(['127.0.0.1']) is true, and listen() ignores a non-string
      // host and binds every interface.
      await expectRefused({ CLAUDE_MEM_WORKER_HOST: ['127.0.0.1'] }, message => message.startsWith('CLAUDE_MEM_WORKER_HOST must be'));
    });

    it.each([
      ['CLAUDE_MEM_WORKER_HOST', 'localhost'],
      ['CLAUDE_MEM_WORKER_HOST', '::1'],
      ['CLAUDE_MEM_WORKER_PORT', '38000'],
      ['CLAUDE_MEM_CLAUDE_AUTH_METHOD', 'api-key'],
      ['CLAUDE_MEM_CLAUDE_AUTH_METHOD', 'gateway'],
    ])('still writes a valid %s (%s)', async (key, value) => {
      const { status } = await post({ [key]: value });
      expect(status).toBe(200);
      expect(stored()[key]).toBe(value);
    });

    it.each(B_KEYS)('accepts a hand-edited empty %s back unchanged', async key => {
      persist({ [key]: '' });
      const { status } = await post({ [key]: '', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
      expect(status).toBe(200);
      expect(stored()).toMatchObject({ [key]: '', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
    });
  });

  // -------------------------------------------------------------------------
  // C. CLAUDE_CODE_PATH and CLAUDE_MEM_CLAUDE_CONFIG_DIR are file/env only.
  // -------------------------------------------------------------------------

  describe('CLAUDE_CODE_PATH and CLAUDE_MEM_CLAUDE_CONFIG_DIR are file/env only', () => {
    const CLAUDE_KEYS = ['CLAUDE_CODE_PATH', 'CLAUDE_MEM_CLAUDE_CONFIG_DIR'] as const;
    const FILE_VALUES: Record<string, string> = {
      CLAUDE_CODE_PATH: '/opt/claude/bin/claude',
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/Users/someone/.claude-profiles/work',
    };
    const refusal = (key: string): string =>
      `${key} can only be changed in settings.json or the environment, not over the API`;

    for (const key of CLAUDE_KEYS) {
      it.each([['/tmp/attacker'], ...EMPTY_AND_NON_STRING.map(value => [value]), [42]])(
        `refuses ${key} = %p over a stored value and writes nothing`,
        async value => {
          persist({ [key]: FILE_VALUES[key] });
          await expectRefused({ [key]: value, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' }, refusal(key));
        },
      );

      it(`refuses to set ${key} over the default ""`, async () => {
        await expectRefused({ [key]: FILE_VALUES[key] }, refusal(key));
      });
    }

    it('accepts the stored values back and never writes them, not even to expand a ~', async () => {
      // The route used to rewrite CLAUDE_CODE_PATH with the ~ expanded on every
      // save; findClaudeExecutable expands it when it reads the file.
      persist({ CLAUDE_CODE_PATH: '~/.local/bin/claude', CLAUDE_MEM_CLAUDE_CONFIG_DIR: '~/.claude-profiles/work' });
      const body = await getSettings();
      expect(body.CLAUDE_CODE_PATH).toBe('~/.local/bin/claude');

      const { status } = await post({ ...body, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });

      expect(status).toBe(200);
      expect(stored()).toMatchObject({
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60',
        CLAUDE_CODE_PATH: '~/.local/bin/claude',
        CLAUDE_MEM_CLAUDE_CONFIG_DIR: '~/.claude-profiles/work',
      });
    });

    it('does not copy an environment value into settings.json', async () => {
      persist(FILE_VALUES);
      process.env.CLAUDE_CODE_PATH = '/opt/env/claude';
      process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR = '/Users/someone/.claude-env';
      const body = await getSettings();
      // GET reports the environment's values, and a client posting them back keeps saving...
      expect(body.CLAUDE_CODE_PATH).toBe('/opt/env/claude');
      const { status } = await post({ ...body, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
      expect(status).toBe(200);
      // ...but removing the variables must bring back the file's own values.
      expect(stored()).toMatchObject({ ...FILE_VALUES, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
    });

    it('is never sent by the viewer, even when the form holds another value', async () => {
      persist(FILE_VALUES);
      const { status, body } = await viewerSave({
        CLAUDE_CODE_PATH: '/tmp/attacker',
        CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/tmp/attacker-login',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60',
      });
      for (const key of CLAUDE_KEYS) {
        expect(OTHER_FILE_ONLY_KEYS).toContain(key);
        expect(key in body).toBe(false);
      }
      expect(status).toBe(200);
      expect(stored()).toMatchObject({ ...FILE_VALUES, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
    });

    it('keeps reading both from settings.json', () => {
      persist(FILE_VALUES);
      const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
      expect(settings.CLAUDE_CODE_PATH).toBe(FILE_VALUES.CLAUDE_CODE_PATH);
      expect(settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe(FILE_VALUES.CLAUDE_MEM_CLAUDE_CONFIG_DIR);
    });
  });

  // -------------------------------------------------------------------------
  // D. The body must be a JSON object.
  // -------------------------------------------------------------------------

  describe('a body that is not a JSON object', () => {
    const BODY_ERROR = { success: false, error: 'The request body must be a JSON object of settings' };

    it('is a 400 for text/plain (no body parser ran), and nothing is written', async () => {
      const before = readFileSync(settingsPath, 'utf-8');
      const res = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ CLAUDE_MEM_PROVIDER: '' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(BODY_ERROR);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    });

    it('is a 400 for a JSON array, and nothing is written', async () => {
      persist({ CLAUDE_MEM_PROVIDER: 'codex' });
      const before = readFileSync(settingsPath, 'utf-8');
      const { status, json } = await post([{ CLAUDE_MEM_PROVIDER: '' }]);
      expect(status).toBe(400);
      expect(json).toEqual(BODY_ERROR);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    });

    it('is a 400 with no body at all', async () => {
      const res = await fetch(`${base}/api/settings`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(BODY_ERROR);
    });

    it('does not even create a missing settings.json', async () => {
      rmSync(settingsPath, { force: true });
      const res = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'CLAUDE_MEM_PROVIDER=',
      });
      expect(res.status).toBe(400);
      expect(existsSync(settingsPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The viewer's save, end to end.
  // -------------------------------------------------------------------------

  describe('the viewer save round trip', () => {
    it.each(['claude', 'gemini', 'openrouter', 'codex'])('saves typical edits with %s stored', async provider => {
      persist({ CLAUDE_MEM_PROVIDER: provider, ...(provider === 'codex' ? { CLAUDE_CODE_PATH: '/opt/claude/bin/claude' } : {}) });

      const { status, json } = await viewerSave({
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60',
        CLAUDE_MEM_WORKER_PORT: '38000',
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true',
      });

      expect(status).toBe(200);
      expect(json).toEqual(OK);
      expect(stored()).toMatchObject({
        CLAUDE_MEM_PROVIDER: provider,
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60',
        CLAUDE_MEM_WORKER_PORT: '38000',
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      });
    });

    it('saves a provider change the modal offers', async () => {
      const { status } = await viewerSave({ CLAUDE_MEM_PROVIDER: 'gemini' });
      expect(status).toBe(200);
      expect(stored().CLAUDE_MEM_PROVIDER).toBe('gemini');
    });

    it('keeps the GET body posted back unchanged working', async () => {
      persist({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_CODE_PATH: '/opt/claude/bin/claude', CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/Users/someone/.claude-profiles/work' });
      const { status } = await post(await getSettings());
      expect(status).toBe(200);
      expect(stored()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_CODE_PATH: '/opt/claude/bin/claude' });
    });

    it('keeps saving while settings.json holds empty or odd values for the presence-checked keys', async () => {
      const handEdited = {
        CLAUDE_MEM_PROVIDER: '',
        CLAUDE_MEM_CLAUDE_AUTH_METHOD: '',
        CLAUDE_MEM_WORKER_HOST: null,
        CLAUDE_MEM_WORKER_PORT: '80',
        CLAUDE_CODE_PATH: null,
        CLAUDE_MEM_CLAUDE_CONFIG_DIR: 42,
      };
      persist(handEdited);

      const viewer = await viewerSave({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
      expect(viewer.status).toBe(200);
      expect(stored()).toMatchObject({ ...handEdited, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });

      const raw = await post({ ...(await getSettings()), CLAUDE_MEM_CONTEXT_OBSERVATIONS: '70' });
      expect(raw.status).toBe(200);
      expect(stored()).toMatchObject({ ...handEdited, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '70' });
    });
  });
});
