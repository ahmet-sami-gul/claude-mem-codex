import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

/**
 * claude-mem-codex fork: the SessionStart systemMessage and the per-message
 * context banner must not carry upstream's cmem.ai Pro pitch or Discord invite.
 *
 * Snapshot the real namespaces EAGERLY, before the mock.module calls below
 * (see tests/cli/handlers/context-session-start.test.ts for why).
 */
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true', CLAUDE_MEM_PRO_FALLBACK_AT: '' }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: 'repo-project',
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => 'context from worker',
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('fork banners carry no upstream promo', () => {
  it('ends the SessionStart systemMessage at the viewer link', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-fork-banner',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.systemMessage).toBe('context from worker\n\nView Observations Live @ http://localhost:37777');
  });

  it('drops the Discord invite and the Pro pitch from the context banner', async () => {
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const result = await userMessageHandler.execute({
      sessionId: 'session-fork-banner',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    const banner = result.systemMessage ?? '';
    expect(banner).toContain('context from worker');
    expect(banner).not.toContain('discord.gg');
    expect(banner).not.toContain('cmem.ai');
    expect(banner.endsWith('Watch live in browser http://localhost:37777/\n')).toBe(true);
  });
});
