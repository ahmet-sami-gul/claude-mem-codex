
import { logger } from '../../../utils/logger.js';
import type { SessionManager } from '../SessionManager.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { stripMemoryTags } from '../../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { isObserverSessionCwd } from '../../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { PrivacyCheckValidator } from '../validation/PrivacyCheckValidator.js';
import { captureEvent } from '../../telemetry/telemetry.js';
import { classifySkillId, skillNameFromToolInput } from '../../telemetry/skill-id.js';
import { codexMetrics } from '../codex/codex-metrics.js';

interface IngestContext {
  sessionManager: SessionManager;
  dbManager: DatabaseManager;
  eventBroadcaster: SessionEventBroadcaster;
  ensureGeneratorRunning?: (sessionDbId: number, source: string) => void | Promise<void>;
}

let ctx: IngestContext | null = null;

export function setIngestContext(next: IngestContext): void {
  ctx = next;
}

export function attachIngestGeneratorStarter(
  ensureGeneratorRunning: (sessionDbId: number, source: string) => void | Promise<void>,
): void {
  requireContext().ensureGeneratorRunning = ensureGeneratorRunning;
}

function requireContext(): IngestContext {
  if (!ctx) {
    throw new Error('ingest helpers used before setIngestContext() — wiring bug');
  }
  return ctx;
}

export type IngestResult =
  | { ok: true; sessionDbId: number; messageId?: number }
  | { ok: true; status: 'skipped'; reason: string }
  | { ok: false; reason: string; status?: number };

export interface ObservationPayload {
  contentSessionId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string;
  platformSource?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
  /**
   * Receipt join keys (frozen 2026-09-06). Both nullable and both pass-through:
   * Claude-Mem never derives them, it only echoes what a stamper supplied, so
   * `tool_uses` can be joined to an OpenRouter spend line. No cost field here —
   * dollars stay on the OR stamp / spend log.
   */
  orGenerationId?: string;
  orSessionId?: string;
}

/**
 * CLAUDE_MEM_SUBAGENT_EVENTS: which of a subagent's tool uses (an event with a
 * non-empty agentId) are sent to the observer. `all` sends every one, as
 * before the setting existed; `writes` only the file writes below; `none`
 * none. Main-session events are never filtered. File/env only: the settings
 * POST route validates it but never writes it.
 */
export const SUBAGENT_EVENTS_MODES = ['all', 'writes', 'none'] as const;
export type SubagentEventsMode = typeof SUBAGENT_EVENTS_MODES[number];
const DEFAULT_SUBAGENT_EVENTS_MODE: SubagentEventsMode = 'all';

/** The subagent tool uses CLAUDE_MEM_SUBAGENT_EVENTS=writes still sends to the observer. */
export const SUBAGENT_WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** One warning per distinct bad value, so a wrong setting is not logged per event. */
const warnedSubagentEventsValues = new Set<string>();

/**
 * CLAUDE_MEM_SUBAGENT_EVENTS as loaded (settings.json, then the environment).
 * Empty means the default; anything else it cannot use — an unknown word, or
 * a JSON non-string from a hand-edited file — falls back to `all` with one
 * warning per distinct value. Never throws.
 */
export function resolveSubagentEventsMode(raw: unknown): SubagentEventsMode {
  if (raw === undefined || raw === null) return DEFAULT_SUBAGENT_EVENTS_MODE;
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  if (text === '') return DEFAULT_SUBAGENT_EVENTS_MODE;
  if (text !== null && (SUBAGENT_EVENTS_MODES as readonly string[]).includes(text)) {
    return text as SubagentEventsMode;
  }
  const configured = text ?? (JSON.stringify(raw) ?? String(raw));
  if (!warnedSubagentEventsValues.has(configured)) {
    warnedSubagentEventsValues.add(configured);
    logger.warn('INGEST', `Invalid CLAUDE_MEM_SUBAGENT_EVENTS; using ${DEFAULT_SUBAGENT_EVENTS_MODE} instead`, { configured });
  }
  return DEFAULT_SUBAGENT_EVENTS_MODE;
}

export async function ingestObservation(payload: ObservationPayload): Promise<IngestResult> {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireContext();

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  // The observer's own jail (M4, plan 3.10): a tool event from inside
  // OBSERVER_SESSIONS_DIR is the memory observer's activity, not the user's.
  // Hooks already skip it (shouldTrackProject), but this is the one choke
  // point every ingest path shares — the PostToolUse route AND the transcript
  // processor's direct call — so the guard lives here too, before anything is
  // created, stored or queued.
  if (cwd && isObserverSessionCwd(cwd)) {
    return { ok: true, status: 'skipped', reason: 'observer_session' };
  }

  const project = cwd.trim() ? getProjectContext(cwd).primary : '';

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { ok: true, status: 'skipped', reason: 'project_excluded' };
  }

  const skipTools = new Set(
    settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean)
  );
  if (skipTools.has(payload.toolName)) {
    if (payload.toolName === 'Skill') {
      const { skill_id, skill_source } = classifySkillId(
        skillNameFromToolInput(payload.toolName, payload.toolInput),
      );
      captureEvent('skill_invoked', {
        skill_id,
        skill_source,
        skill_trigger: 'tool',
        ide: platformSource,
      });
    }
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
  }

  const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
  if (fileOperationTools.has(payload.toolName) && payload.toolInput && typeof payload.toolInput === 'object') {
    const input = payload.toolInput as { file_path?: string; notebook_path?: string };
    const filePath = input.file_path || input.notebook_path;
    if (filePath && filePath.includes('session-memory')) {
      return { ok: true, status: 'skipped', reason: 'session_memory_meta' };
    }
  }

  const store = dbManager.getSessionStore();

  let sessionDbId: number;
  let promptNumber: number;
  try {
    sessionDbId = store.createSDKSession(payload.contentSessionId, project, '', undefined, platformSource);
    promptNumber = store.getPromptNumberFromUserPrompts(payload.contentSessionId, sessionDbId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('INGEST', 'Observation session resolution failed', {
      contentSessionId: payload.contentSessionId,
      toolName: payload.toolName,
    }, error instanceof Error ? error : new Error(message));
    return { ok: false, reason: message, status: 500 };
  }

  const privacy = PrivacyCheckValidator.checkUserPromptPrivacy(
    store,
    payload.contentSessionId,
    promptNumber,
    'observation',
    sessionDbId,
    { tool_name: payload.toolName }
  );
  if (!privacy.allow) {
    return { ok: true, status: 'skipped', reason: 'private' };
  }

  const cleanedToolInput = payload.toolInput !== undefined
    ? stripMemoryTags(JSON.stringify(payload.toolInput))
    : '{}';
  const cleanedToolResponse = payload.toolResponse !== undefined
    ? stripMemoryTags(JSON.stringify(payload.toolResponse))
    : '{}';

  // Dual-write: the durable `tool_uses` side index (v51) alongside — never
  // instead of — the pending_messages → generator queue below. This is the one
  // choke point both the PostToolUse hook route and the transcript-watch
  // processor already funnel through, so the JSONL spine keeps its own path and
  // no second capture surface exists to drift.
  //
  // Best-effort by construction: an observation must still be generated if the
  // backup index write fails, so a throw here is logged and swallowed. Rows
  // without a tool_use_id are skipped by upsertToolUse (nothing to de-dupe on).
  if (payload.toolUseId) {
    try {
      store.upsertToolUse({
        toolUseId: payload.toolUseId,
        contentSessionId: payload.contentSessionId,
        sessionDbId,
        project,
        platformSource,
        toolName: payload.toolName,
        toolInput: cleanedToolInput,
        toolResponse: cleanedToolResponse,
        cwd: cwd || null,
        promptNumber,
        agentType: typeof payload.agentType === 'string' ? payload.agentType : null,
        agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
        orGenerationId: typeof payload.orGenerationId === 'string' ? payload.orGenerationId : null,
        orSessionId: typeof payload.orSessionId === 'string' ? payload.orSessionId : null,
      });
    } catch (error) {
      logger.warn('INGEST', 'tool_uses backup write failed (observation still queued)', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
        toolUseId: payload.toolUseId,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // CLAUDE_MEM_SUBAGENT_EVENTS. Deliberately after the dual-write and before
  // the queue: a filtered subagent tool use keeps its raw tool_uses row (the
  // durable index loses nothing), but it is never queued, never starts a
  // generator and never costs an observer call. Main-session events (no
  // agentId) are never filtered, and the setting is read only for subagents.
  if (typeof payload.agentId === 'string' && payload.agentId.length > 0) {
    const mode = resolveSubagentEventsMode(settings.CLAUDE_MEM_SUBAGENT_EVENTS);
    if (mode === 'none' || (mode === 'writes' && !SUBAGENT_WRITE_TOOLS.includes(payload.toolName))) {
      codexMetrics.recordSubagentEventSkipped();
      logger.debug('INGEST', 'Subagent tool use kept out of the observer (CLAUDE_MEM_SUBAGENT_EVENTS)', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
        agentType: payload.agentType,
        mode,
      });
      return { ok: true, status: 'skipped', reason: 'subagent_filtered' };
    }
  }

  await sessionManager.queueObservation(sessionDbId, {
    tool_name: payload.toolName,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    cwd: cwd || (() => {
      logger.error('INGEST', 'Missing cwd when ingesting observation', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
      });
      return '';
    })(),
    agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
    agentType: typeof payload.agentType === 'string' ? payload.agentType : undefined,
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
  });

  await ensureGeneratorRunning?.(sessionDbId, 'observation');
  eventBroadcaster.broadcastObservationQueued(sessionDbId);

  return { ok: true, sessionDbId };
}
