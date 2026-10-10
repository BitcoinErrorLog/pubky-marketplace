import { describe, expect, it, vi } from 'vitest';
import { buildInfoToEnv, readBuildInfo, resolveBuildInfo } from './build-info';

const NOW = new Date('2026-10-10T12:34:56.000Z');
const base = { packageName: 'pubky-marketplace', packageVersion: '1.5.0', now: NOW };

describe('resolveBuildInfo', () => {
  it('prefers the Vercel commit, then GIT_SHA, then git', () => {
    const git = vi.fn((args: string[]) => (args[0] === 'status' ? undefined : 'fromgit'));
    expect(resolveBuildInfo({ ...base, env: { VERCEL_GIT_COMMIT_SHA: 'vercel', GIT_SHA: 'docker' }, git }).commit).toBe(
      'vercel',
    );
    expect(resolveBuildInfo({ ...base, env: { GIT_SHA: 'docker' }, git }).commit).toBe('docker');
    expect(resolveBuildInfo({ ...base, env: { GIT_SHA: ' ' }, git }).commit).toBe('fromgit');
    expect(git).toHaveBeenCalledWith(['rev-parse', 'HEAD']);
  });

  it('marks a git-derived commit with uncommitted changes as dirty, and leaves CI-provided shas alone', () => {
    const dirtyGit = (args: string[]) => (args[0] === 'status' ? ' M src/app/layout.tsx' : 'fromgit');
    expect(resolveBuildInfo({ ...base, env: {}, git: dirtyGit }).commit).toBe('fromgit-dirty');
    expect(resolveBuildInfo({ ...base, env: { GIT_SHA: 'docker' }, git: dirtyGit }).commit).toBe('docker');
  });

  it('reports the release tag from SHOP_VERSION, then the git tag, then the package version', () => {
    const gitTag = (args: string[]) => (args[0] === 'describe' ? 'shop-v0.6.49-10-g73cec61' : undefined);
    expect(resolveBuildInfo({ ...base, env: { SHOP_VERSION: 'shop-v0.6.50' }, git: gitTag }).version).toBe(
      'shop-v0.6.50',
    );
    expect(resolveBuildInfo({ ...base, env: {}, git: gitTag }).version).toBe('shop-v0.6.49-10-g73cec61');
    expect(resolveBuildInfo({ ...base, env: {}, git: () => undefined }).version).toBe('1.5.0');
  });

  it('falls back to unknown without a commit source and stamps the build time as RFC 3339', () => {
    const info = resolveBuildInfo({ ...base, env: {}, git: () => undefined });
    expect(info).toEqual({
      name: 'pubky-marketplace',
      version: '1.5.0',
      commit: 'unknown',
      built_at: '2026-10-10T12:34:56.000Z',
    });
  });
});

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
