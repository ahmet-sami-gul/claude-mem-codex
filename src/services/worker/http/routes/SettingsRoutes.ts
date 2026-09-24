
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { ModeManager } from '../../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { snapshotDependencyHealth } from '../../../../shared/dependency-health.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../../../shared/atomic-json.js';
import { CODEX_MODEL_ALLOWLIST, MODEL_ID_RE } from '../../codex/codex-invocation.js';
import { SUBAGENT_EVENTS_MODES } from '../shared.js';

const toggleMcpSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

// GET /api/settings has no auth. Mask known secrets before they leave the
// process. Explicit allowlist — a /API_KEY|_TOKEN|SECRET/i regex also matches
// CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS / SHOW_WORK_TOKENS (boolean display
// prefs) and corrupts them on every GET (#3680 / #3861).
const SECRET_SETTING_KEYS = new Set([
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_CHROMA_API_KEY',
  'CLAUDE_MEM_CLOUD_SYNC_TOKEN',
  'CLAUDE_MEM_TELEGRAM_BOT_TOKEN',
  'CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES',
  'CLAUDE_MEM_SERVER_API_KEY',
  'CLAUDE_MEM_SERVER_BETA_API_KEY',
  'CLAUDE_MEM_TV_TOKEN',
  'CLAUDE_MEM_PRO_MEMORY_KEY',
  'CLAUDE_MEM_REDIS_URL',
]);

function maskSecretValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

// Viewer save posts the GET body back unchanged. Treat a secret as untouched
// only when the submitted value equals the mask of the currently stored
// secret — not "any string starting with *", which would silently drop a
// legitimate replacement key that happens to begin with '*'.
function isUnchangedMaskedSecret(incoming: unknown, stored: unknown): boolean {
  return typeof incoming === 'string' && incoming === maskSecretValue(stored);
}

function redactSecretSettings<T extends object>(settings: T): T {
  const redacted: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const key of SECRET_SETTING_KEYS) {
    if (key in redacted) {
      redacted[key] = maskSecretValue(redacted[key]);
    }
  }
  return redacted as T;
}

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));
    app.get('/api/settings/dependency-health', this.handleGetDependencyHealth.bind(this));

    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', validateBody(toggleMcpSchema), this.handleToggleMcp.bind(this));
  }

  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(redactSecretSettings(settings));
  });

  private handleGetDependencyHealth = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(snapshotDependencyHealth());
  });

  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    // express.json() leaves req.body undefined for a body that is not
    // application/json (a page can POST text/plain without a CORS preflight),
    // and hands a JSON array through as is. Neither is a settings object.
    // Refused before validateSettings, whose read of settings.json creates the
    // file when it is missing.
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      res.status(400).json({
        success: false,
        error: 'The request body must be a JSON object of settings',
      });
      return;
    }

    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    let settings: any = {};

    if (existsSync(settingsPath)) {
      const settingsData = readFileSync(settingsPath, 'utf-8');
      try {
        settings = parseJsonWithBom(settingsData);
      } catch (parseError) {
        const normalizedParseError = parseError instanceof Error ? parseError : new Error(String(parseError));
        logger.error('HTTP', 'Failed to parse settings file', { settingsPath }, normalizedParseError);
        res.status(500).json({
          success: false,
          error: `Settings file is corrupted. Delete ${settingsPath} to reset.`
        });
        return;
      }
    }

    // Write whitelist. Secrets are deliberately absent: the Observation TV token,
    // and the Chroma / Telegram / CloudSync keys. POST /api/settings has no
    // authentication, so any page the user visits could set one of its choosing.
    // Keeping them off this list means only the filesystem or the env can set them.
    //
    // The same reasoning now covers the Codex COST levers, which are absent for
    // a sharper reason than secrecy: an unauthenticated local page could
    // otherwise spend the user's ChatGPT plan. CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H
    // could be set to 0 (unlimited), CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS to
    // 50 (discarding nearly every waiting observation) or 0 (an unbounded
    // backlog), CLAUDE_MEM_CODEX_PATH / _HOME could point the observer at
    // another binary or another login, and _TRANSPORT, _QUOTA_RESERVE_PERCENT,
    // _RATE_LIMIT_PROBE_MS and _ALLOW_UNTESTED_VERSION all relax a guard. Those
    // eight are file/env only. What remains writable is
    // the tuning a viewer legitimately offers — effort, verbosity, the timeout,
    // the conversation and batch budgets, field compression, and the two model
    // keys, which validateSettings additionally pins to CODEX_MODEL_ALLOWLIST
    // (or the value already persisted, so the viewer round-trip still works).
    //
    // CLAUDE_MEM_SUBAGENT_EVENTS is file/env only for the same reason: from
    // 'writes' or 'none', a page could set 'all' and send every subagent tool
    // use to the observer again.
    //
    // CLAUDE_MEM_DATA_DIR is file/env only because it undoes all of the above
    // at once. resolveDataDir reads it from ~/.claude-mem/settings.json, so a
    // page that wrote '/tmp/x' here would start the next worker on
    // /tmp/x/settings.json, seeded with defaults: every file/env-only key
    // above would be back at its default (no exec cap, subagent events 'all')
    // and CLAUDE_MEM_PROVIDER at 'claude'. validateSettings refuses any value
    // other than the one already stored.
    //
    // CLAUDE_CODE_PATH and CLAUDE_MEM_CLAUDE_CONFIG_DIR are file/env only for
    // the reason CLAUDE_MEM_CODEX_PATH / _HOME are. findClaudeExecutable runs
    // the binary CLAUDE_CODE_PATH names (its version probe) and every Claude
    // SDK spawn then uses it, KnowledgeAgent's too whatever the provider; the
    // config dir picks which local Claude login those spawns use. The viewer
    // has no field for either. validateSettings refuses any value other than
    // the one already stored, as for CLAUDE_MEM_DATA_DIR.
    const settingKeys = [
      'CLAUDE_MEM_MODEL',
      'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
      'CLAUDE_MEM_WORKER_PORT',
      'CLAUDE_MEM_WORKER_HOST',
      'CLAUDE_MEM_PROVIDER',
      'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
      'CLAUDE_MEM_GEMINI_API_KEY',
      'CLAUDE_MEM_GEMINI_MODEL',
      'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
      'CLAUDE_MEM_OPENROUTER_API_KEY',
      'CLAUDE_MEM_OPENROUTER_BASE_URL',
      'CLAUDE_MEM_OPENROUTER_MODEL',
      'CLAUDE_MEM_OPENROUTER_SITE_URL',
      'CLAUDE_MEM_OPENROUTER_APP_NAME',
      'CLAUDE_MEM_LOG_LEVEL',
      'CLAUDE_MEM_PYTHON_VERSION',
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
      'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
      'CLAUDE_MEM_CONTEXT_FULL_COUNT',
      'CLAUDE_MEM_CONTEXT_FULL_FIELD',
      'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
      'CLAUDE_MEM_CODEX_MODEL',
      'CLAUDE_MEM_CODEX_SUMMARY_MODEL',
      'CLAUDE_MEM_CODEX_REASONING_EFFORT',
      'CLAUDE_MEM_CODEX_VERBOSITY',
      'CLAUDE_MEM_CODEX_TIMEOUT_MS',
      'CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS',
      'CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS',
      'CLAUDE_MEM_CODEX_BATCH_MAX_CHARS',
      'CLAUDE_MEM_CODEX_BATCH_LINGER_MS',
      'CLAUDE_MEM_CODEX_FIELD_COMPRESSION',
    ];

    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        if (SECRET_SETTING_KEYS.has(key) && isUnchangedMaskedSecret(req.body[key], settings[key])) {
          continue;
        }
        settings[key] = req.body[key];
      }
    }

    writeJsonFileAtomic(settingsPath, settings);

    clearPortCache();

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body as z.infer<typeof toggleMcpSchema>;

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  private validateSettings(settings: any): { valid: boolean; error?: string } {
    // The values already on disk (with env overrides applied, i.e. what
    // dispatch itself reads). Several codex rules accept "unchanged" so the
    // viewer's round-trip — POST the whole GET body back — keeps working for a
    // key this route will not actually write.
    const persisted = this.loadPersistedSettings();

    /**
     * The body carries `key` with a value other than the one already stored.
     *
     * Presence, not truthiness, for the keys that select a provider, a login
     * or the worker's bind: the write loop persists every value that is not
     * undefined, so a `''`, `null`, `0` or `false` that skipped a truthy check
     * was written as is. Over a persisted 'codex' that switched observation to
     * Claude at once (dispatch checks === 'codex'), and an empty or non-string
     * CLAUDE_MEM_WORKER_HOST makes listen() bind every interface. The value
     * already stored is accepted unchanged, so a client posting the GET body
     * back keeps saving whatever the file holds.
     */
    const changed = (key: string): boolean =>
      settings[key] !== undefined && settings[key] !== persisted[key];

    if (changed('CLAUDE_MEM_PROVIDER')) {
      const validProviders = ['claude', 'gemini', 'openrouter', 'codex'];
      if (typeof settings.CLAUDE_MEM_PROVIDER !== 'string' || !validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
        return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", "openrouter", or "codex"' };
      }
      // Switching TO codex is file/env only. This endpoint is unauthenticated
      // and reachable from any page the user has open (middleware.ts allows
      // every localhost origin), so accepting the switch here would let a web
      // page redirect memory onto the user's paid ChatGPT plan. Accepting the
      // value when it is ALREADY the persisted one costs nothing and keeps the
      // viewer round-trip working for a codex user.
      if (settings.CLAUDE_MEM_PROVIDER === 'codex' && persisted.CLAUDE_MEM_PROVIDER !== 'codex') {
        return {
          valid: false,
          error: 'CLAUDE_MEM_PROVIDER can only be switched to "codex" in settings.json or the environment, not over the API',
        };
      }
      // ...and symmetrically OFF it. A one-directional gate is a trapdoor: the
      // same unauthenticated page could POST 'claude' over a persisted 'codex'
      // and the rule above would then refuse to put it back, permanently
      // moving observation onto another provider and plan with no way to undo
      // it from the API. The shipped viewer makes that reachable by accident
      // too — its provider <select> has no codex option, so a codex install
      // shows an unmatched value and the first save after touching the
      // dropdown would flip it. The file owns the codex choice in BOTH
      // directions.
      if (persisted.CLAUDE_MEM_PROVIDER === 'codex' && settings.CLAUDE_MEM_PROVIDER !== 'codex') {
        return {
          valid: false,
          error: 'CLAUDE_MEM_PROVIDER can only be switched away from "codex" in settings.json or the environment, not over the API',
        };
      }
    }

    const codexError = this.validateCodexSettings(settings, persisted);
    if (codexError) {
      return { valid: false, error: codexError };
    }

    // File/env only (never written here), but validated like the codex cost
    // levers: the value already stored is accepted, so a client posting the
    // GET body back keeps working whatever the file holds.
    const subagentEvents = settings.CLAUDE_MEM_SUBAGENT_EVENTS;
    if (
      subagentEvents !== undefined && subagentEvents !== null && subagentEvents !== ''
      && subagentEvents !== persisted.CLAUDE_MEM_SUBAGENT_EVENTS
      && !(SUBAGENT_EVENTS_MODES as readonly unknown[]).includes(subagentEvents)
    ) {
      return { valid: false, error: `CLAUDE_MEM_SUBAGENT_EVENTS must be one of: ${SUBAGENT_EVENTS_MODES.join(', ')}` };
    }

    // File/env only (never written here). Unlike the keys above, no other
    // value is valid over the API: there is no safe data directory to accept
    // and drop, and a caller that asked to move it should hear that it did
    // not. The value already stored (what GET returned) is accepted, so a
    // client posting the GET body back keeps working.
    if (
      settings.CLAUDE_MEM_DATA_DIR !== undefined
      && settings.CLAUDE_MEM_DATA_DIR !== persisted.CLAUDE_MEM_DATA_DIR
    ) {
      return {
        valid: false,
        error: 'CLAUDE_MEM_DATA_DIR can only be changed in settings.json or the environment, not over the API',
      };
    }

    // File/env only (never written here), refused like CLAUDE_MEM_DATA_DIR:
    // one names the binary every Claude SDK spawn runs, the other which local
    // Claude login those spawns use (see the write allowlist). The value
    // already stored is accepted, so a client posting the GET body back keeps
    // working.
    for (const key of ['CLAUDE_CODE_PATH', 'CLAUDE_MEM_CLAUDE_CONFIG_DIR'] as const) {
      if (changed(key)) {
        return {
          valid: false,
          error: `${key} can only be changed in settings.json or the environment, not over the API`,
        };
      }
    }

    // Part of the provider choice, and empty is not one of its values.
    if (changed('CLAUDE_MEM_CLAUDE_AUTH_METHOD')) {
      const validClaudeAuthMethods = ['subscription', 'api-key', 'gateway', 'cli'];
      if (!validClaudeAuthMethods.includes(settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD)) {
        return { valid: false, error: 'CLAUDE_MEM_CLAUDE_AUTH_METHOD must be "subscription", "api-key", "gateway", or "cli"' };
      }
    }

    if (settings.CLAUDE_MEM_GEMINI_MODEL) {
      const validGeminiModels = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
      if (!validGeminiModels.includes(settings.CLAUDE_MEM_GEMINI_MODEL)) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    // An empty port is not "the default": getWorkerPort's parseInt makes it
    // NaN, which listen() refuses, and 0 would bind a random port.
    if (changed('CLAUDE_MEM_WORKER_PORT')) {
      const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    if (changed('CLAUDE_MEM_WORKER_HOST')) {
      const host = settings.CLAUDE_MEM_WORKER_HOST;
      // Loopback, plus the documented bind-all addresses used by Observation TV
      // and Docker (docs/public/configuration.mdx). Arbitrary IPv4 used to be
      // accepted and would expose the unauthenticated worker API on that NIC.
      // A string only: RegExp.test coerces, so ['127.0.0.1'] would match, and
      // listen() ignores a host that is not a non-empty string and binds every
      // interface.
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|::1|::|localhost)$/;
      if (typeof host !== 'string' || !validHostPattern.test(host)) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_HOST must be a loopback address (127.0.0.1, ::1, localhost) or a bind-all address (0.0.0.0, ::) for Observation TV / Docker' };
      }
    }

    if (settings.CLAUDE_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'CLAUDE_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    if (settings.CLAUDE_MEM_PYTHON_VERSION) {
      const pythonVersionRegex = /^3\.\d{1,2}$/;
      if (!pythonVersionRegex.test(settings.CLAUDE_MEM_PYTHON_VERSION)) {
        return { valid: false, error: 'CLAUDE_MEM_PYTHON_VERSION must be in format "3.X" or "3.XX" (e.g., "3.13")' };
      }
    }

    const booleanSettings = [
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_SITE_URL) {
      try {
        new URL(settings.CLAUDE_MEM_OPENROUTER_SITE_URL);
      } catch (error) {
        logger.debug('SETTINGS', 'Invalid URL format', { url: settings.CLAUDE_MEM_OPENROUTER_SITE_URL, error: error instanceof Error ? error.message : String(error) });
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_SITE_URL must be a valid URL' };
      }
    }

    if (settings.CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE) {
      const batch = parseInt(settings.CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE, 10);
      if (isNaN(batch) || batch < 1 || batch > 500) {
        return { valid: false, error: 'CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE must be between 1 and 500' };
      }
    }

    if (settings.CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS) {
      const timeoutMs = parseInt(settings.CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS, 10);
      if (isNaN(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180000) {
        return { valid: false, error: 'CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS must be between 5000 and 180000' };
      }
    }

    return { valid: true };
  }

  /** Effective settings as dispatch reads them; never throws (validation must not 500). */
  private loadPersistedSettings(): Record<string, string> {
    try {
      return SettingsDefaultsManager.loadFromFile(paths.settings()) as unknown as Record<string, string>;
    } catch (error: unknown) {
      logger.debug('SETTINGS', 'Could not read persisted settings while validating', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * Plan 3.1 validators for the CLAUDE_MEM_CODEX_* keys. Runs over the WHOLE
   * body, including keys this route will not write, because the viewer posts
   * back everything GET returned — so each rule must accept the current value.
   */
  private validateCodexSettings(settings: any, persisted: Record<string, string>): string | undefined {
    const present = (key: string): boolean =>
      settings[key] !== undefined && settings[key] !== null && settings[key] !== '';

    /**
     * The value in the body is the value already on disk, so this save changes
     * nothing about it. Every rule below accepts that case, for two reasons:
     * the viewer posts the WHOLE GET body back, so one out-of-range value in
     * settings.json would otherwise 400 every save — including saves of
     * completely unrelated settings — and eight of these keys are file/env
     * only, so this route could not repair a value it refuses. The runtime is
     * already the lenient half of this pair: CodexProvider.getConfig warns and
     * clamps (or falls back), it does not reject.
     */
    const unchanged = (key: string): boolean => settings[key] === persisted[key];

    /**
     * Every codex setting is a STRING. settings.json is hand-editable and this
     * route is unauthenticated, so a JSON number/boolean/array must be refused
     * here rather than written verbatim into the file — `Number(value)` alone
     * accepts all three. (getConfig is hardened against one arriving by some
     * other route as well, but it degrades to the default there, which is not
     * what the user asked for.)
     */
    const mustBeString = (key: string): string | undefined =>
      typeof settings[key] === 'string' ? undefined : `${key} must be a string`;

    // Models: over HTTP only an allowlisted id (or the value already
    // persisted). The file/env path is looser — MODEL_ID_RE — because a new
    // catalogue entry should not require a claude-mem release; only the
    // unauthenticated route is pinned to the list.
    for (const key of ['CLAUDE_MEM_CODEX_MODEL', 'CLAUDE_MEM_CODEX_SUMMARY_MODEL'] as const) {
      if (!present(key) || unchanged(key)) continue;
      const value = settings[key];
      if (typeof value !== 'string') {
        return `${key} must be a string`;
      }
      if (!(CODEX_MODEL_ALLOWLIST as readonly string[]).includes(value)) {
        return `${key} must be one of: ${CODEX_MODEL_ALLOWLIST.join(', ')} (other ids can be set in settings.json, where ${MODEL_ID_RE.source} applies)`;
      }
    }

    for (const key of ['CLAUDE_MEM_CODEX_REASONING_EFFORT', 'CLAUDE_MEM_CODEX_VERBOSITY'] as const) {
      if (!present(key) || unchanged(key)) continue;
      if (!['low', 'medium', 'high'].includes(settings[key])) {
        return `${key} must be "low", "medium", or "high"`;
      }
    }

    const ranges: Array<[string, number, number]> = [
      ['CLAUDE_MEM_CODEX_TIMEOUT_MS', 30000, 600000],
      ['CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS', 40000, 400000],
      ['CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS', 1, 12],
      ['CLAUDE_MEM_CODEX_BATCH_MAX_CHARS', 8000, 96000],
      ['CLAUDE_MEM_CODEX_BATCH_LINGER_MS', 0, 30000],
      ['CLAUDE_MEM_CODEX_QUOTA_RESERVE_PERCENT', 0, 50],
      ['CLAUDE_MEM_CODEX_RATE_LIMIT_PROBE_MS', 60000, 3600000],
    ];
    for (const [key, min, max] of ranges) {
      if (!present(key) || unchanged(key)) continue;
      const typeError = mustBeString(key);
      if (typeError) return typeError;
      const value = Number(settings[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        return `${key} must be an integer between ${min} and ${max}`;
      }
    }

    // 0 means "no local cap", so this one has no upper bound.
    if (present('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H') && !unchanged('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H')) {
      const typeError = mustBeString('CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H');
      if (typeError) return typeError;
      const value = Number(settings.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H);
      if (!Number.isInteger(value) || value < 0) {
        return 'CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H must be an integer of 0 or more (0 = no local cap)';
      }
    }

    // 0 turns the queue cap off; any other cap is at least 50.
    if (present('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS') && !unchanged('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS')) {
      const typeError = mustBeString('CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS');
      if (typeError) return typeError;
      const value = Number(settings.CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS);
      if (!Number.isInteger(value) || (value !== 0 && (value < 50 || value > 100000))) {
        return 'CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS must be 0 (no cap) or an integer between 50 and 100000';
      }
    }

    for (const key of ['CLAUDE_MEM_CODEX_FIELD_COMPRESSION', 'CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION'] as const) {
      if (!present(key) || unchanged(key)) continue;
      if (!['true', 'false'].includes(settings[key])) {
        return `${key} must be "true" or "false"`;
      }
    }

    if (
      present('CLAUDE_MEM_CODEX_TRANSPORT')
      && !unchanged('CLAUDE_MEM_CODEX_TRANSPORT')
      && settings.CLAUDE_MEM_CODEX_TRANSPORT !== 'exec'
    ) {
      return 'CLAUDE_MEM_CODEX_TRANSPORT must be "exec" (exec-resume and app-server are reserved for a later phase)';
    }

    // Both feed spawn/auth identity (the binary that runs, and which login it
    // reads), so a type-confused payload must not reach path handling.
    for (const key of ['CLAUDE_MEM_CODEX_PATH', 'CLAUDE_MEM_CODEX_HOME'] as const) {
      if (settings[key] === undefined || settings[key] === '') continue;
      if (typeof settings[key] !== 'string' || !settings[key].trim() || settings[key].includes('\0')) {
        return `${key} must be a non-empty path string without NUL bytes, or "" to use the default`;
      }
    }

    return undefined;
  }

  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeJsonFileAtomic(settingsPath, defaults);
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
