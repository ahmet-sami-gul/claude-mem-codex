import { describe, it, expect } from 'bun:test';
import {
  buildCodexExecArgs,
  buildCodexProbeArgs,
  assertCodexProbeArgvSafe,
  CodexArgvViolationError,
  CODEX_DISABLED_FEATURES,
  CODEX_MODEL_ALLOWLIST,
  CODEX_PROBE_CANARY,
  type CodexProbeKind,
} from '../../../src/services/worker/codex/codex-invocation.js';

const KINDS: CodexProbeKind[] = ['version', 'login_status', 'features_list', 'prompt_input'];
const JAIL = '/tmp/claude-mem-test/observer-sessions/codex-selfcheck';

function configTokens(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') out.push(args[i + 1]);
  }
  return out;
}

function disableTokens(args: string[]): string[] {
  return args.filter((token) => token.startsWith('--disable='));
}

describe('buildCodexProbeArgs: fixed argv', () => {
  it('version probe is exactly --version', () => {
    expect(buildCodexProbeArgs('version', { model: 'gpt-5.6-luna' })).toEqual(['--version']);
  });

  it('login probe is exactly `login status` (never bare login)', () => {
    expect(buildCodexProbeArgs('login_status', { model: 'gpt-5.6-luna' })).toEqual(['login', 'status']);
  });

  it('features probe is `features list` with exactly the exec pins and disables', () => {
    const exec = buildCodexExecArgs({ model: 'gpt-5.6-luna', effort: 'low', verbosity: 'low', jailDir: JAIL });
    const probe = buildCodexProbeArgs('features_list', { model: 'gpt-5.6-luna' });
    expect(probe.slice(0, 2)).toEqual(['features', 'list']);
    expect(configTokens(probe)).toEqual(configTokens(exec));
    expect(disableTokens(probe)).toEqual(disableTokens(exec));
    expect(disableTokens(probe).length).toBe(CODEX_DISABLED_FEATURES.length);
  });

  it('prompt-input probe passes the model with -c model=, then the exec pins, disables and canary', () => {
    const exec = buildCodexExecArgs({ model: 'gpt-5.6-luna', effort: 'low', verbosity: 'low', jailDir: JAIL });
    const probe = buildCodexProbeArgs('prompt_input', { model: 'gpt-5.6-luna' });
    expect(probe.slice(0, 4)).toEqual(['debug', 'prompt-input', '-c', 'model="gpt-5.6-luna"']);
    expect(probe[probe.length - 1]).toBe(CODEX_PROBE_CANARY);
    // Every exec pin (sandbox_mode, approval_policy, developer_instructions included) is present, in order.
    expect(configTokens(probe).slice(1)).toEqual(configTokens(exec));
    expect(configTokens(probe)).toContain('sandbox_mode="read-only"');
    expect(configTokens(probe)).toContain('approval_policy="never"');
    expect(configTokens(probe).some((pin) => pin.startsWith('developer_instructions='))).toBe(true);
    expect(disableTokens(probe)).toEqual(disableTokens(exec));
  });

  it('prompt-input never carries flags the subcommand does not accept', () => {
    const probe = buildCodexProbeArgs('prompt_input', { model: 'gpt-5.6-sol' });
    for (const token of probe) {
      for (const flag of ['--model', '--sandbox', '--cd', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--color']) {
        expect(token === flag || token.startsWith(`${flag}=`)).toBe(false);
      }
    }
    expect(probe).not.toContain('exec');
    expect(probe).not.toContain('-');
  });

  it('effort and verbosity only change the pin values (default low/low)', () => {
    const lowPins = configTokens(buildCodexProbeArgs('features_list', { model: 'gpt-5.6-luna' }));
    expect(lowPins).toContain('model_reasoning_effort="low"');
    expect(lowPins).toContain('model_verbosity="low"');
    const highPins = configTokens(
      buildCodexProbeArgs('features_list', { model: 'gpt-5.6-luna', effort: 'high', verbosity: 'medium' }),
    );
    expect(highPins).toContain('model_reasoning_effort="high"');
    expect(highPins).toContain('model_verbosity="medium"');
    expect(highPins.length).toBe(lowPins.length);
  });

  it('probe pins track the exec pins for every allowlisted model (v2 hint pins included)', () => {
    for (const model of CODEX_MODEL_ALLOWLIST) {
      const exec = buildCodexExecArgs({ model, effort: 'low', verbosity: 'low', jailDir: JAIL });
      expect(configTokens(buildCodexProbeArgs('features_list', { model }))).toEqual(configTokens(exec));
      expect(configTokens(buildCodexProbeArgs('prompt_input', { model })).slice(1)).toEqual(configTokens(exec));
    }
  });

  it('rejects an invalid model for pin-carrying probes', () => {
    expect(() => buildCodexProbeArgs('prompt_input', { model: '-x' })).toThrow(CodexArgvViolationError);
    expect(() => buildCodexProbeArgs('features_list', { model: 'bad model' })).toThrow(CodexArgvViolationError);
  });
});

describe('probe subcommand rules', () => {
  it('login is always followed by status and features always by list; no write subcommands', () => {
    for (const model of CODEX_MODEL_ALLOWLIST) {
      for (const kind of KINDS) {
        const args = buildCodexProbeArgs(kind, { model });
        expect(() => assertCodexProbeArgvSafe(args)).not.toThrow();
        const loginAt = args.indexOf('login');
        if (loginAt !== -1) expect(args[loginAt + 1]).toBe('status');
        const featuresAt = args.indexOf('features');
        if (featuresAt !== -1) expect(args[featuresAt + 1]).toBe('list');
        expect(args).not.toContain('logout');
        expect(args).not.toContain('--with-api-key');
        expect(args).not.toContain('enable');
        expect(args).not.toContain('exec');
        expect(args.some((token) => token === '--enable' || token.startsWith('--enable='))).toBe(false);
      }
    }
  });

  it('assertCodexProbeArgvSafe rejects write and model-calling subcommands', () => {
    const bad: string[][] = [
      ['login'],
      ['login', '--with-api-key'],
      ['login', 'status', 'extra'],
      ['logout'],
      ['features'],
      ['features', 'enable', 'hooks'],
      ['features', 'disable', 'hooks'],
      ['debug', 'prompt-input', '--model=gpt-5.6-luna', 'x'],
      ['debug', 'prompt-input', '--cd=/tmp', 'x'],
      ['debug', 'prompt-input', '--ephemeral', 'x'],
      ['debug', 'prompt-input', '--ignore-user-config', 'x'],
      ['debug', 'something-else'],
      ['exec', '--json', '-'],
      ['--version', 'extra'],
      ['review'],
    ];
    for (const args of bad) {
      expect(() => assertCodexProbeArgvSafe(args)).toThrow(CodexArgvViolationError);
    }
  });
});
