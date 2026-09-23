import { useState, useEffect, useCallback, useRef } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

/**
 * The settings the worker holds, re-read on demand.
 *
 * `settings` is the last GET /api/settings result. The settings modal decides
 * which provider switches to offer from it (the route refuses some), so it
 * must be current: settings.json can change while a viewer tab stays open
 * (enabling Codex is a file edit plus a worker restart the tab survives), and
 * a failed GET leaves only DEFAULT_SETTINGS. The modal calls `reload()` every
 * time it opens and keeps Save off until `isLoading` is false and `loadError`
 * is null, so a stale or default provider is never posted.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  // Only the newest load may write state: an older response arriving late
  // must not overwrite a newer one.
  const latestLoad = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const loadId = latestLoad.current + 1;
    latestLoad.current = loadId;
    setIsLoading(true);
    try {
      const res = await fetch(API_ENDPOINTS.SETTINGS);
      if (!res.ok) {
        throw new Error(`Failed to load settings (${res.status})`);
      }
      const data = await res.json();
      if (loadId !== latestLoad.current) return;
      setSettings({ ...DEFAULT_SETTINGS, ...data });
      setLoadError(null);
    } catch (error) {
      if (loadId !== latestLoad.current) return;
      console.error('Failed to load settings:', error);
      setLoadError(error instanceof Error ? error.message : 'Network error');
    } finally {
      if (loadId === latestLoad.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submitSettings = async (newSettings: Settings) => {
    const response = await fetch(API_ENDPOINTS.SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });

    if (!response.ok) {
      // The route explains a refusal in its JSON body ("CLAUDE_MEM_PROVIDER can
      // only be switched away from ..."); the status text alone ("Bad Request")
      // tells the user nothing.
      let detail = response.status === 401 ? 'Unauthorized' : (response.statusText || `HTTP ${response.status}`);
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string' && body.error.trim() !== '') {
          detail = body.error;
        }
      } catch {
        // [ANTI-PATTERN IGNORED]: a non-JSON error body; the status text above is the fallback.
      }
      setSaveStatus(`✗ Error: ${detail}`);
      return;
    }

    const result = await response.json();

    if (result.success) {
      // The body may leave keys out (constants/codex.ts buildSettingsSaveBody),
      // so merge rather than replace, then read back what the worker now holds.
      setSettings(previous => ({ ...previous, ...newSettings }));
      void reload();
      setSaveStatus('✓ Saved');
      setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
    } else {
      setSaveStatus(`✗ Error: ${result.error}`);
    }
  };

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    try {
      await submitSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus, reload, isLoading, loadError };
}
