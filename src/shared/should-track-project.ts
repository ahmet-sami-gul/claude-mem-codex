
import { relative, isAbsolute, join, normalize } from 'path';
import { isProjectExcluded } from '../utils/project-filter.js';
import { loadFromFileOnce } from './hook-settings.js';
import {
  CLAUDE_CONFIG_DIR,
  MARKETPLACE_ROOT,
  OBSERVER_SESSIONS_DIR,
  OBSERVER_SESSIONS_PROJECT,
} from './paths.js';

const PLUGINS_DIR_NAME = 'plugins';
const PLUGIN_CACHE_DIR_NAME = 'cache';
const CLAUDE_MEM_PLUGIN_OWNER = 'claude-mem-codex';
const CLAUDE_MEM_PLUGIN_NAME = 'claude-mem';
const PLUGIN_RUNTIME_DIR_NAME = 'plugin';
const PLUGIN_CACHE_ROOT = join(
  CLAUDE_CONFIG_DIR,
  PLUGINS_DIR_NAME,
  PLUGIN_CACHE_DIR_NAME,
  CLAUDE_MEM_PLUGIN_OWNER,
  CLAUDE_MEM_PLUGIN_NAME,
);
const PLUGIN_MARKETPLACE_PLUGIN_ROOT = join(MARKETPLACE_ROOT, PLUGIN_RUNTIME_DIR_NAME);

function isWithin(child: string, parent: string): boolean {
  const normChild = normalize(child);
  const normParent = normalize(parent);
  if (normChild === normParent) return true;
  const rel = relative(normParent, normChild);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Whether `cwd` is claude-mem's own observer jail (OBSERVER_SESSIONS_DIR or
 * anything under it) — where the memory observer itself runs (the Claude SDK
 * observer and every `codex exec`). Nothing that happens there is the user's
 * work, so it must never be captured as an observation: that would be the
 * observer observing itself, and on Codex every such observation would cost
 * another paid exec.
 */
export function isObserverSessionCwd(cwd: string): boolean {
  return Boolean(cwd) && isWithin(cwd, OBSERVER_SESSIONS_DIR);
}

export function shouldTrackProject(cwd: string): boolean {
  if (process.env.CLAUDE_MEM_INTERNAL === '1') return false;
  if (!cwd) return true;
  if (isObserverSessionCwd(cwd)) {
    return false;
  }
  if (isWithin(cwd, PLUGIN_CACHE_ROOT) || isWithin(cwd, PLUGIN_MARKETPLACE_PLUGIN_ROOT)) {
    return false;
  }
  const settings = loadFromFileOnce();
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}

export function shouldEmitProjectRow(project: string | null | undefined): boolean {
  if (!project) return true;
  return project !== OBSERVER_SESSIONS_PROJECT;
}
