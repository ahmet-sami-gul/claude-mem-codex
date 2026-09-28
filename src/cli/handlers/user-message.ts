
import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
} from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { proTrialLine } from '../../shared/pro-promo.js';

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());
    const colorsParam = input.platform === 'claude-code' ? '&colors=true' : '';
    const platformSourceParam = input.platform
      ? `&platformSource=${encodeURIComponent(normalizePlatformSource(input.platform))}`
      : '';

    const result = await executeWithWorkerFallback<string>(
      `/api/context/inject?project=${encodeURIComponent(project)}${colorsParam}${platformSourceParam}`,
      'GET',
    );

    if (isWorkerFallback(result)) {
      return { exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const output = typeof result === 'string' ? result : '';
    // IO discipline: the banner is a USER_HINT. Return it via systemMessage so
    // the platform adapter routes it (claude-code surfaces it inline, exactly
    // like the old stderr write, but inside the HookResult contract). This
    // handler MUST stay pure — no process.stderr.write / console.* / process.exit.
    // claude-mem-codex fork: no upstream Discord invite, and proTrialLine() is
    // '' (no cmem.ai pitch) — this unofficial fork must not read as upstream.
    const proLine = proTrialLine('context-banner');
    const bannerText =
      "\n\n" + String.fromCodePoint(0x1F4DD) + " Claude-Mem Context Loaded\n\n" +
      output +
      "\n\n" + String.fromCodePoint(0x1F4A1) + " Wrap any message with <private> ... </private> to prevent storing sensitive information.\n" +
      "\n" + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n` +
      (proLine ? `${proLine}\n` : '');

    return { exitCode: HOOK_EXIT_CODES.SUCCESS, systemMessage: bannerText };
  },
};
