import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';

/**
 * #2753 added CLAUDE_MEM_CLAUDE_CONFIG_DIR, which picks which Claude login
 * (keychain entry, CLAUDE_CONFIG_DIR) every SDK spawn uses. It is now file/env
 * only, like CLAUDE_MEM_CODEX_HOME: POST /api/settings has no authentication,
 * so it refuses any value other than the one already stored and never writes
 * the key. Setting it in settings.json keeps working (paths.settings()
 * resolves under the per-run temp DATA_DIR that tests/preload.ts pins, so the
 * real ~/.claude-mem is never touched).
 */

function createMockReqRes(body: any): {
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

function captureSettingsPostHandler(routes: SettingsRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

describe('SettingsRoutes — CLAUDE_MEM_CLAUDE_CONFIG_DIR is file/env only (#2753)', () => {
  const settingsPath = paths.settings();
  const STORED = '/Users/matthewdnye/.ccs/instances/iveg50';
  const REFUSED = {
    success: false,
    error: 'CLAUDE_MEM_CLAUDE_CONFIG_DIR can only be changed in settings.json or the environment, not over the API',
  };
  let priorSettingsContent: string | undefined;
  let priorEnv: string | undefined;
  let handler: (req: Request, res: Response) => void;

  function persist(configDir: string): void {
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CLAUDE_CONFIG_DIR: configDir }, null, 2),
      'utf-8',
    );
  }

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    priorEnv = process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
    handler = captureSettingsPostHandler(new SettingsRoutes({} as any));
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR = priorEnv;
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

  it.each([
    ['a path', '/tmp/attacker-login'],
    ['"" (the default)', ''],
    ['a number', 42],
    ['whitespace', '   '],
  ])('refuses %s over a stored value with 400 and writes nothing', (_label, value) => {
    persist(STORED);
    const before = readFileSync(settingsPath, 'utf-8');
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: value });

    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(REFUSED);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('refuses to set a path over the default "" too', () => {
    persist('');
    const before = readFileSync(settingsPath, 'utf-8');
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: STORED });

    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(REFUSED);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('accepts the stored value back, so a client posting the GET body keeps saving', () => {
    persist(STORED);
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: STORED,
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60',
    });

    handler(req as Request, res as Response);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('60');
    expect(persisted.CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe(STORED);
  });

  it('keeps reading the value set in settings.json', () => {
    persist(STORED);
    expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe(STORED);
  });
});
