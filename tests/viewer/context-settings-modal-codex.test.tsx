import { describe, it, expect } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextSettingsModal, CodexProviderFields } from '../../src/ui/viewer/components/ContextSettingsModal';
import { DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings';
import type { CodexNumberKey } from '../../src/ui/viewer/constants/codex';
import type { Settings } from '../../src/ui/viewer/types';

/**
 * The settings modal as rendered markup (plan 3.7): how Save is gated on a
 * fresh settings read, and that every Codex control is named by its label and
 * linked to its error or warning. Effects do not run in a static render, so
 * each case is the first paint for the given props.
 */

function settingsWith(overrides: Record<string, unknown>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides } as Settings;
}

function renderModal(overrides: Record<string, unknown>, props: {
  settingsLoading?: boolean;
  settingsLoadError?: string | null;
} = {}): string {
  return renderToStaticMarkup(
    <ContextSettingsModal
      isOpen
      onClose={() => {}}
      settings={settingsWith(overrides)}
      onReload={() => {}}
      settingsLoading={props.settingsLoading ?? false}
      settingsLoadError={props.settingsLoadError ?? null}
      onSave={() => {}}
      isSaving={false}
      saveStatus=""
    />,
  );
}

function renderCodexFields(
  overrides: Record<string, unknown>,
  errors: Partial<Record<CodexNumberKey, string>> = {},
): string {
  const settings = settingsWith({ CLAUDE_MEM_PROVIDER: 'codex', ...overrides });
  return renderToStaticMarkup(
    <CodexProviderFields formState={settings} persisted={settings} updateSetting={() => {}} errors={errors} />,
  );
}

/** The first element matching `marker`. */
function tag(html: string, marker: RegExp): string {
  const match = html.match(marker);
  expect(match).not.toBeNull();
  return match![0];
}

function attr(element: string, name: string): string | null {
  const match = element.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/** The control the <label> with this text names, via its htmlFor. */
function controlFor(html: string, labelText: string): string {
  const label = tag(html, new RegExp(`<label class="form-field-label" for="[^"]+">${labelText.replace(/[()]/g, '\\$&')}`));
  const id = attr(label, 'for')!;
  return tag(html, new RegExp(`<(?:input|select)[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`));
}

/** Text of the element whose id is `id`. */
function textOf(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`id="${escaped}"[^>]*>([^<]*)<`));
  expect(match).not.toBeNull();
  return match![1];
}

function saveButton(html: string): string {
  return tag(html, /<button class="save-btn"[^>]*>/);
}

describe('ContextSettingsModal — Save waits for a fresh settings read', () => {
  it('offers Save once the settings are loaded', () => {
    const html = renderModal({ CLAUDE_MEM_PROVIDER: 'claude' });
    expect(attr(saveButton(html), 'disabled')).toBeNull();
    expect(html).not.toContain('save-blocker');
  });

  it('keeps Save off, and says so next to it, while the settings are loading', () => {
    const html = renderModal({ CLAUDE_MEM_PROVIDER: 'claude' }, { settingsLoading: true });
    const button = saveButton(html);
    expect(attr(button, 'disabled')).not.toBeNull();
    expect(html).toContain('Loading the current settings');
    // Linked to the button, not only in a title a disabled button never shows.
    const status = tag(html, /<div class="save-status"[^>]*>/);
    expect(attr(button, 'aria-describedby')).toBe(attr(status, 'id'));
    expect(attr(status, 'aria-live')).toBe('polite');
  });

  it('keeps Save off, and says why, when the settings could not be read', () => {
    // A failed GET leaves the defaults (provider claude): posting them could
    // switch a codex install, which the route refuses with a bare 400.
    const html = renderModal({}, { settingsLoadError: 'Failed to load settings (500)' });
    expect(attr(saveButton(html), 'disabled')).not.toBeNull();
    expect(html).toContain('Could not load the current settings (Failed to load settings (500))');
  });
});

describe('CodexProviderFields — labels, hints and what the worker really uses', () => {
  it('names every control by its label', () => {
    const html = renderCodexFields({});
    expect(controlFor(html, 'Codex Model')).toStartWith('<select');
    expect(controlFor(html, 'Reasoning Effort')).toStartWith('<select');
    expect(controlFor(html, 'Verbosity')).toStartWith('<select');
    for (const label of ['Conversation Budget (characters)', 'Batch Size', 'Timeout (ms)']) {
      const input = controlFor(html, label);
      // Text, so a partial entry like "300k" reaches validation instead of
      // being reported as '' by a number input.
      expect(attr(input, 'type')).toBe('text');
      expect(attr(input, 'inputMode')).toBe('numeric');
      expect(attr(input, 'aria-invalid')).toBeNull();
    }
    // Defaults: no warnings at all.
    expect(html).not.toContain('form-field-warning');
  });

  it('describes batching as grouped by prompt, agent and cwd, not as consecutive tool uses', () => {
    const html = renderCodexFields({});
    expect(html).toContain('Tool uses from the same prompt, agent and working directory sent in one Codex call, oldest first');
    expect(html).not.toContain('Consecutive tool uses');
  });

  it('shows no binary-path field and the exec cap read-only', () => {
    const html = renderCodexFields({ CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H: '150' });
    expect(html).not.toContain('CLAUDE_MEM_CODEX_PATH');
    expect(html).toContain('150 Codex calls per 5 hours');
    expect(html).toContain('settings.json or the');
  });

  it('shows the waiting-observation cap read-only, and what the worker uses for a bad value', () => {
    const html = renderCodexFields({ CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS: '800' });
    expect(html).toContain('Max Waiting Observations per Session');
    expect(html).toContain('800 waiting observations per session');
    expect(html).toContain('set CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS in ~/.claude-mem/settings.json');
    expect(html).not.toContain('form-field-warning');
    // A bound, not a promise of few calls: 500 waiting can still be 125+ calls.
    expect(html).toContain('at most this many tool uses per session are left to send');
    expect(html).not.toContain('cannot turn into hundreds of Codex calls');

    const tooLow = renderCodexFields({ CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS: '10' });
    expect(tooLow).toContain('50 waiting observations per session');
    expect(tooLow).toContain('the lowest cap is 50');
  });

  it('links a number error to its field', () => {
    const html = renderCodexFields({}, { CLAUDE_MEM_CODEX_TIMEOUT_MS: 'Must be a whole number from 30,000 to 600,000.' });
    const input = controlFor(html, 'Timeout (ms)');
    expect(attr(input, 'aria-invalid')).toBe('true');
    expect(textOf(html, attr(input, 'aria-describedby')!)).toContain('Must be a whole number');
  });

  it('says when a stored number is clamped or ignored by the worker', () => {
    const clamped = renderCodexFields({ CLAUDE_MEM_CODEX_TIMEOUT_MS: '5' });
    const timeout = controlFor(clamped, 'Timeout (ms)');
    expect(attr(timeout, 'aria-invalid')).toBe('true');
    expect(textOf(clamped, attr(timeout, 'aria-describedby')!)).toContain('so the worker uses 30,000');

    const jsonNumber = renderCodexFields({ CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS: 6 });
    const batch = controlFor(jsonNumber, 'Batch Size');
    expect(textOf(jsonNumber, attr(batch, 'aria-describedby')!)).toContain('not a string');
  });

  it('warns about the small-allowance model as the worker reads it', () => {
    const spaced = renderCodexFields({ CLAUDE_MEM_CODEX_MODEL: ' gpt-5.6-sol ' });
    const spacedSelect = controlFor(spaced, 'Codex Model');
    expect(textOf(spaced, attr(spacedSelect, 'aria-describedby')!)).toContain('gpt-5.6-sol has a much smaller allowance');

    for (const model of ['gpt-6-sol', 'gpt-6-astra']) {
      const html = renderCodexFields({ CLAUDE_MEM_CODEX_MODEL: model });
      expect(textOf(html, attr(controlFor(html, 'Codex Model'), 'aria-describedby')!)).toContain(`${model} has a much smaller allowance`);
    }
    expect(renderCodexFields({ CLAUDE_MEM_CODEX_MODEL: 'gpt-6-luna' })).not.toContain('much smaller allowance');

    // Upper case is not a valid id: the worker runs the default, not sol.
    const upper = renderCodexFields({ CLAUDE_MEM_CODEX_MODEL: 'GPT-5.6-SOL' });
    expect(upper).not.toContain('much smaller allowance');
    const upperSelect = controlFor(upper, 'Codex Model');
    expect(attr(upperSelect, 'aria-invalid')).toBe('true');
    expect(textOf(upper, attr(upperSelect, 'aria-describedby')!)).toContain('the worker uses gpt-5.6-luna instead');
  });

  it('says when a stored level is not one the worker knows', () => {
    const html = renderCodexFields({ CLAUDE_MEM_CODEX_REASONING_EFFORT: 'extreme' });
    const select = controlFor(html, 'Reasoning Effort');
    expect(textOf(html, attr(select, 'aria-describedby')!)).toContain('the worker uses low instead');
    expect(html).toContain('extreme (set in settings.json or the environment)');
  });
});
