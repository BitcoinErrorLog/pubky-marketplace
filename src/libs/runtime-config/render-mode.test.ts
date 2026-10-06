import { connection } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPerRequestOutsideVercel } from './render-mode';

vi.mock('next/server', () => ({
  connection: vi.fn(async () => {}),
}));

describe('renderPerRequestOutsideVercel', () => {
  beforeEach(() => {
    vi.mocked(connection).mockClear();
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('NEXT_STANDALONE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders per request for a plain build reused with a different runtime env (CI launch-e2e)', async () => {
    await renderPerRequestOutsideVercel();

    expect(connection).toHaveBeenCalledOnce();
  });

  it('renders per request for a Docker standalone build', async () => {
    vi.stubEnv('NEXT_STANDALONE', 'true');

    await renderPerRequestOutsideVercel();

    expect(connection).toHaveBeenCalledOnce();
  });

  it('lets routes prerender on Vercel, whose build shares the deployment env', async () => {
    vi.stubEnv('VERCEL', '1');

    await renderPerRequestOutsideVercel();

    expect(connection).not.toHaveBeenCalled();
  });
});
