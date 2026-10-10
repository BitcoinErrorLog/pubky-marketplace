import { describe, expect, it, vi } from 'vitest';
import { buildInfoToEnv, readBuildInfo } from './build-info';

const NOW = new Date('2026-10-10T12:34:56.000Z');

describe('build info env round trip', () => {
  it('serves what next.config inlines', () => {
    const info = { name: 'pubky-marketplace', version: 'shop-v0.6.50', commit: 'abc123', built_at: NOW.toISOString() };
    for (const [key, value] of Object.entries(buildInfoToEnv(info))) vi.stubEnv(key, value);
    try {
      expect(readBuildInfo()).toEqual(info);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
