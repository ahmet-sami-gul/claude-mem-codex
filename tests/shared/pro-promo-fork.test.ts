import { describe, expect, it } from 'bun:test';

import { PRO_PROMO_ENABLED, proTrialLine, type ProPromoSource } from '../../src/shared/pro-promo.js';

// claude-mem-codex fork: an unofficial fork must not advertise upstream's
// commercial cmem.ai service on the hook and welcome-hint surfaces.
describe('pro promo in the claude-mem-codex fork', () => {
  it('is switched off', () => {
    expect(PRO_PROMO_ENABLED).toBe(false);
  });

  it('renders no trial line on any surface', () => {
    const sources: ProPromoSource[] = ['installer', 'session-start', 'context-banner', 'welcome-hint', 'viewer', 'fallback', 'docs'];
    for (const source of sources) {
      expect(proTrialLine(source)).toBe('');
    }
  });
});
