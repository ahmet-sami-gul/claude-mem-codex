import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isPluginDisabledInClaudeSettings } from '../../src/shared/plugin-state.js';

let tempDir: string;
let originalClaudeConfigDir: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `plugin-disabled-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalClaudeConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('isPluginDisabledInClaudeSettings (#781)', () => {
  it('should return false when settings.json does not exist', () => {
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });

  it('should return false when plugin is explicitly enabled', () => {
    const settings = {
      enabledPlugins: {
        'claude-mem@claude-mem-codex': true
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });

  it('should return true when plugin is explicitly disabled', () => {
    const settings = {
      enabledPlugins: {
        'claude-mem@claude-mem-codex': false
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInClaudeSettings()).toBe(true);
  });

  it('should return false when enabledPlugins key is missing', () => {
    const settings = {
      permissions: { allow: [] }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });

  it('should return false when plugin key is absent from enabledPlugins', () => {
    const settings = {
      enabledPlugins: {
        'other-plugin@marketplace': true
      }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });

  it('should return false when settings.json contains invalid JSON', () => {
    writeFileSync(join(tempDir, 'settings.json'), '{ invalid json }}}');
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });

  it('should return false when settings.json is empty', () => {
    writeFileSync(join(tempDir, 'settings.json'), '');
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });
});

// plugin/scripts/bun-runner.js is a hand-maintained, dependency-free launcher
// with its own copy of the enabledPlugins check; keep its key in step with
// src/shared/plugin-state.ts (claude-mem-codex fork: claude-mem@claude-mem-codex).
describe('bun-runner.js enabledPlugins key', () => {
  it('matches the key plugin-state.ts checks', () => {
    const root = join(import.meta.dir, '..', '..');
    const pluginState = readFileSync(join(root, 'src', 'shared', 'plugin-state.ts'), 'utf-8');
    const bunRunner = readFileSync(join(root, 'plugin', 'scripts', 'bun-runner.js'), 'utf-8');
    const key = pluginState.match(/PLUGIN_SETTINGS_KEY = '([^']+)'/)?.[1];

    expect(key).toBe('claude-mem@claude-mem-codex');
    expect(bunRunner).toContain(`settings.enabledPlugins['${key}'] === false`);
    expect(bunRunner).not.toContain('claude-mem@thedotmack');
  });
});
