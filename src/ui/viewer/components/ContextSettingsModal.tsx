import React, { useState, useCallback, useEffect, useId } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';
import { DEFAULT_SETTINGS } from '../constants/settings';
import {
  CODEX_LEVEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_NUMBER_BOUNDS,
  CODEX_SMALL_ALLOWANCE_MODELS,
  PROVIDER_OPTIONS,
  buildSettingsSaveBody,
  codexNumberError,
  describeCodexExecCap,
  effectiveCodexLevel,
  effectiveCodexModel,
  effectiveCodexNumber,
  isProviderOptionSelectable,
  withPersistedOption,
  type CodexNumberKey,
} from '../constants/codex';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The last GET /api/settings result: what the worker holds. */
  settings: Settings;
  /** Re-read GET /api/settings; called every time the modal opens. */
  onReload: () => void | Promise<void>;
  /** True while a GET is in flight; `settings` may be stale meanwhile. */
  settingsLoading: boolean;
  /** Why the last GET failed, or null; `settings` may be stale or the defaults. */
  settingsLoadError: string | null;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

/**
 * A labelled form row. Pass `children` as a function to have the label name
 * its control: it receives a generated id to put on the control (the label's
 * `htmlFor`) and to derive ids for hints and errors (aria-describedby).
 */
function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode | ((controlId: string) => React.ReactNode);
}) {
  const controlId = useId();
  const labelsControl = typeof children === 'function';
  return (
    <div className="form-field">
      <label className="form-field-label" htmlFor={labelsControl ? controlId : undefined}>
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {labelsControl ? children(controlId) : children}
    </div>
  );
}

/** Space-separated ids for aria-describedby, or undefined when there are none. */
function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length > 0 ? present.join(' ') : undefined;
}

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

/**
 * The Codex CLI observer block (plan 3.7). Rendered only while codex is the
 * selected provider, which the provider select allows only when codex is
 * already persisted.
 *
 * Offers exactly what POST /api/settings will write for codex: the allowlisted
 * models, the two levels, and three ranged numbers. The 5-hour exec cap is
 * shown read-only (file/env only), and there is deliberately no field for the
 * binary path: a page that can point the observer at a binary could run
 * anything. Under each field it says when the worker would not use the value
 * as written (effectiveCodex* in constants/codex.ts).
 *
 * Exported for tests/viewer/context-settings-modal-codex.test.tsx.
 */
export function CodexProviderFields({
  formState,
  persisted,
  updateSetting,
  errors,
}: {
  formState: Settings;
  /** The GET result: the only non-listed values a save may carry are these. */
  persisted: Settings;
  updateSetting: (key: keyof Settings, value: string) => void;
  errors: Partial<Record<CodexNumberKey, string>>;
}) {
  const model = formState.CLAUDE_MEM_CODEX_MODEL || DEFAULT_SETTINGS.CLAUDE_MEM_CODEX_MODEL;
  // What the worker would actually run with (CodexProvider.getConfig), which
  // can differ from what the field shows for a value set outside this page.
  const effectiveModel = effectiveCodexModel(formState.CLAUDE_MEM_CODEX_MODEL);
  const execCap = describeCodexExecCap(formState.CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H);

  // A text field, not type="number": a number input reports '' for text it
  // cannot parse ("300k", "2e") while still showing that text, so the entry
  // would pass as "use the default" with no error. The raw text reaches
  // codexNumberError instead, which refuses anything but a whole number in
  // range. An empty field is valid (the worker then uses the default), so it
  // stays empty while the user types instead of snapping back to the default.
  const numberField = (key: CodexNumberKey, label: string, tooltip: string) => (
    <FormField label={label} tooltip={tooltip}>
      {(id) => {
        const error = errors[key];
        // Only for a value the route accepts as it is: an unchanged value
        // from settings.json or the environment that the worker clamps or
        // ignores.
        const problem = error ? null : effectiveCodexNumber(key, formState[key]).problem;
        const errorId = `${id}-error`;
        const problemId = `${id}-problem`;
        return (
          <>
            <input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={formState[key] ?? ''}
              placeholder={`${DEFAULT_SETTINGS[key]} (default)`}
              aria-invalid={error || problem ? true : undefined}
              aria-describedby={describedBy(error && errorId, problem && problemId)}
              onChange={(e) => updateSetting(key, e.target.value)}
            />
            {error && <p id={errorId} className="form-field-error" role="alert">{error}</p>}
            {problem && <p id={problemId} className="form-field-warning">{problem}</p>}
          </>
        );
      }}
    </FormField>
  );

  const levelField = (
    key: 'CLAUDE_MEM_CODEX_REASONING_EFFORT' | 'CLAUDE_MEM_CODEX_VERBOSITY',
    label: string,
    tooltip: string,
  ) => (
    <FormField label={label} tooltip={tooltip}>
      {(id) => {
        const problem = effectiveCodexLevel(formState[key]).problem;
        const problemId = `${id}-problem`;
        return (
          <>
            <select
              id={id}
              value={formState[key] || DEFAULT_SETTINGS[key]}
              aria-invalid={problem ? true : undefined}
              aria-describedby={describedBy(problem && problemId)}
              onChange={(e) => updateSetting(key, e.target.value)}
            >
              {withPersistedOption(CODEX_LEVEL_OPTIONS, persisted[key]).map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {problem && <p id={problemId} className="form-field-warning">{problem}</p>}
          </>
        );
      }}
    </FormField>
  );

  return (
    <>
      <p className="form-field-note">
        Every observer call runs your local Codex CLI and counts against your ChatGPT plan. The
        plan's 5-hour and weekly limits are shared with your own interactive Codex use, so memory
        work and your coding sessions draw from the same allowance.
      </p>
      <FormField
        label="Codex Model"
        tooltip="Model for observations, and for summaries unless CLAUDE_MEM_CODEX_SUMMARY_MODEL is set in settings.json. Only these models can be chosen here."
      >
        {(id) => {
          const problemId = `${id}-problem`;
          const allowanceId = `${id}-allowance`;
          // The model the worker runs, not the raw text: " gpt-5.6-sol " runs
          // sol, and an id the worker refuses runs the default instead.
          const smallAllowance = CODEX_SMALL_ALLOWANCE_MODELS.has(effectiveModel.value);
          return (
            <>
              <select
                id={id}
                value={model}
                aria-invalid={effectiveModel.problem ? true : undefined}
                aria-describedby={describedBy(effectiveModel.problem && problemId, smallAllowance && allowanceId)}
                onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_MODEL', e.target.value)}
              >
                {withPersistedOption(CODEX_MODEL_OPTIONS, persisted.CLAUDE_MEM_CODEX_MODEL).map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              {effectiveModel.problem && (
                <p id={problemId} className="form-field-warning">{effectiveModel.problem}</p>
              )}
              {smallAllowance && (
                <p id={allowanceId} className="form-field-warning">
                  {effectiveModel.value} has a much smaller allowance on ChatGPT Plus than gpt-5.6-luna. As
                  the observer model it can use up the limit your own Codex work depends on within hours.
                </p>
              )}
            </>
          );
        }}
      </FormField>
      {levelField(
        'CLAUDE_MEM_CODEX_REASONING_EFFORT',
        'Reasoning Effort',
        'Sent with every call (your own Codex config is ignored). Higher effort spends more of your plan per observation.',
      )}
      {levelField(
        'CLAUDE_MEM_CODEX_VERBOSITY',
        'Verbosity',
        "How long the model's replies are; the only output-length setting Codex offers.",
      )}
      {numberField(
        'CLAUDE_MEM_CODEX_MAX_CONVERSATION_CHARS',
        'Conversation Budget (characters)',
        'How much observer conversation is re-sent with each call before it is recycled into a fresh one (40,000-400,000). Smaller means fewer input tokens per call.',
      )}
      {numberField(
        'CLAUDE_MEM_CODEX_BATCH_MAX_OBSERVATIONS',
        'Batch Size',
        'Consecutive tool uses from the same prompt sent in one Codex call (1-12). Each call is one plan message; 1 turns batching off.',
      )}
      {numberField(
        'CLAUDE_MEM_CODEX_TIMEOUT_MS',
        'Timeout (ms)',
        'Deadline for one Codex call (30,000-600,000 ms). A call that passes it is interrupted and its observations are kept for a retry.',
      )}
      <FormField
        label="Max Codex Calls per 5 Hours"
        tooltip="A local cap on how many Codex calls the observer may make in any 5-hour window. When it is reached the observer pauses and resumes on its own."
      >
        <div className="form-field-readonly">{execCap.text}</div>
        {execCap.problem && <p className="form-field-warning">{execCap.problem}</p>}
        <p className="form-field-hint">
          Read-only here: set CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H in ~/.claude-mem/settings.json or the
          worker's environment. This page cannot change it, so no web page can lift the cap.
        </p>
      </FormField>
    </>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onReload,
  settingsLoading,
  settingsLoadError,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  // Re-read the settings every time the modal opens. The provider options
  // below are decided by the PERSISTED provider, and settings.json can have
  // changed since the page loaded (enabling Codex is a file edit plus a worker
  // restart this tab survives). A stale 'claude' would keep Codex disabled and
  // post 'claude' over a persisted 'codex', which the route refuses.
  useEffect(() => {
    if (isOpen) void onReload();
  }, [isOpen, onReload]);

  // Save stays off until the settings above are the worker's current ones: a
  // stale or default provider must never be posted.
  const settingsReady = !settingsLoading && settingsLoadError === null;

  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  // The provider that is PERSISTED (the GET result), not the form's value: it
  // decides which switches the settings route will accept.
  const persistedProvider = settings.CLAUDE_MEM_PROVIDER;
  const codexPersisted = persistedProvider === 'codex';

  // Numeric codex fields the route would refuse. Checked here so the modal can
  // say why, and so Save is not offered for a body that can only earn a 400.
  const codexErrors = (Object.keys(CODEX_NUMBER_BOUNDS) as CodexNumberKey[]).reduce<Partial<Record<CodexNumberKey, string>>>(
    (errors, key) => {
      const error = codexNumberError(key, formState[key], settings[key]);
      if (error) errors[key] = error;
      return errors;
    },
    {},
  );
  const hasCodexErrors = Object.keys(codexErrors).length > 0;
  const canSave = settingsReady && !isSaving && !hasCodexErrors;

  // Why Save is off, shown next to it (a disabled button's `title` never
  // reaches keyboard users, and a collapsed Advanced section hides the field
  // errors themselves).
  const saveBlocker: { text: string; isError: boolean } | null = settingsLoadError !== null && !settingsLoading
    ? {
      text: `Could not load the current settings (${settingsLoadError}), so Save is off. Close and reopen Settings to try again.`,
      isError: true,
    }
    : settingsLoading
      ? { text: 'Loading the current settings...', isError: false }
      : hasCodexErrors
        ? { text: 'Fix the Codex settings marked under Advanced before saving.', isError: true }
        : null;
  // A save's own status wins over the brief reload that follows it.
  const visibleBlocker = saveBlocker && !(saveStatus && settingsLoading) ? saveBlocker : null;
  const saveStatusId = useId();

  const handleSave = useCallback(() => {
    if (!canSave) return;
    // Not the whole form: buildSettingsSaveBody leaves out the file/env-only
    // codex keys and any provider or codex value the user did not change, so
    // a value GET read from the environment is never written into the file.
    onSave(buildSettingsSaveBody(formState, settings));
  }, [canSave, formState, settings, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="header-controls">
            <label className="preview-selector">
              Source:
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              Project:
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="Close (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="Loading"
              description="How many observations to inject"
            >
              <FormField
                label="Observations"
                tooltip="Number of recent observations to include in context (1-200)"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="Sessions"
                tooltip="Number of recent sessions to pull observations from (1-50)"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="Display"
              description="What to show in context tables"
            >
              <div className="display-subsection">
                <span className="subsection-label">Full Observations</span>
                <FormField
                  label="Count"
                  tooltip="How many observations show expanded details (0-20)"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Field"
                  tooltip="Which field to expand for full observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">Narrative</option>
                    <option value="facts">Facts</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token Economics</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="Read cost"
                    description="Tokens to read this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="Work investment"
                    description="Tokens spent creating this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="Savings"
                    description="Total tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title="Advanced"
              description="AI provider and model selection"
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="Choose the provider that generates observations: Claude (via Agent SDK), Gemini (via REST API), OpenRouter — also used by the claude-mem observer — or the Codex CLI on your ChatGPT plan, which is switched on and off in settings.json or the environment only"
              >
                {(id) => (
                  <>
                    <select
                      id={id}
                      value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                      aria-describedby={`${id}-hint`}
                      onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                    >
                      {PROVIDER_OPTIONS.map(option => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={!isProviderOptionSelectable(option.value, persistedProvider)}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p id={`${id}-hint`} className="form-field-hint">
                      {codexPersisted
                        ? 'Codex is selected in ~/.claude-mem/settings.json or the worker environment (CLAUDE_MEM_PROVIDER). To use another provider, change it there; this page cannot switch away from Codex, so the other providers are disabled.'
                        : 'Codex CLI is disabled here: it can only be turned on in ~/.claude-mem/settings.json ("CLAUDE_MEM_PROVIDER": "codex") or the worker environment. This page has no login, so it is not allowed to move memory onto your ChatGPT plan.'}
                    </p>
                  </>
                )}
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label="Claude Model"
                  tooltip="Claude model used for generating observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">haiku (fastest)</option>
                    <option value="sonnet">sonnet (balanced)</option>
                    <option value="opus">opus (highest quality)</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label="Gemini API Key"
                    tooltip="Your Google AI Studio API key (or set GEMINI_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder="Enter Gemini API key..."
                    />
                  </FormField>
                  <FormField
                    label="Gemini Model"
                    tooltip="Gemini model used for generating observations"
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-flash-latest'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-flash-latest">gemini-flash-latest (default, latest GA Flash)</option>
                      <option value="gemini-flash-lite-latest">gemini-flash-lite-latest (latest GA Flash-Lite)</option>
                      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                      <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (preview)</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label="Rate Limiting"
                      description="Enable for free tier (10-30 RPM). Disable if you have billing set up (1000+ RPM)."
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label="OpenRouter API Key"
                    tooltip="Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder="Enter OpenRouter API key..."
                    />
                  </FormField>
                  <FormField
                    label="OpenRouter Model"
                    tooltip="Model identifier from OpenRouter (e.g., anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-thinking-exp)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label="Site URL (Optional)"
                    tooltip="Your site URL for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label="App Name (Optional)"
                    tooltip="Your app name for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'codex' && (
                <CodexProviderFields
                  formState={formState}
                  persisted={settings}
                  updateSetting={updateSetting}
                  errors={codexErrors}
                />
              )}

              <FormField
                label="Worker Port"
                tooltip="Port for the background worker service"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label="Include last summary"
                  description="Add previous session's summary to context"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label="Include last message"
                  description="Add previous session's final message"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status" id={saveStatusId} role="status" aria-live="polite">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
            {visibleBlocker && (
              <span className={`save-blocker${visibleBlocker.isError ? ' error' : ''}`}>{visibleBlocker.text}</span>
            )}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={!canSave}
            aria-describedby={visibleBlocker ? saveStatusId : undefined}
            title={visibleBlocker ? visibleBlocker.text : undefined}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
