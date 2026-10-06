import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { GET } from './route';

const indexLine = (body: string) => body.split('\n').find((line) => line.startsWith('INDEX = '));

// The guide as it was served from public/llms.txt, with its fixed INDEX host.
const STATIC_GUIDE = readFileSync(
  path.join(process.cwd(), 'src/test/fixtures/agent-guide/llms-static-95a0.txt'),
  'utf8',
);
const STATIC_INDEX_LINE = 'INDEX = https://nexusd-production-95a0.up.railway.app';

describe('GET /llms.txt', () => {
  beforeEach(() => {
    resetRuntimeConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it('names the marketplace Nexus the Shop reads as INDEX', async () => {
    vi.stubEnv('PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL', 'https://index.runtime.example.com');

    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(indexLine(body)).toBe('INDEX = https://index.runtime.example.com');
    expect(body).not.toMatch(/nexusd-production-[0-9a-f]+/);
  });

  it('caches like the static file it replaces', () => {
    vi.stubEnv('PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL', 'https://index.runtime.example.com');

    expect(GET().headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('serves the static guide byte for byte except the INDEX line', async () => {
    vi.stubEnv('PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL', 'https://index.runtime.example.com');
    expect(STATIC_GUIDE.split(STATIC_INDEX_LINE)).toHaveLength(2);

    const body = await GET().text();

    expect(body).toBe(STATIC_GUIDE.replace(STATIC_INDEX_LINE, 'INDEX = https://index.runtime.example.com'));
  });

  it('strips a trailing slash so INDEX + path stays a valid URL', async () => {
    vi.stubEnv('PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL', 'https://index.runtime.example.com/');

    const body = await GET().text();

    expect(indexLine(body)).toBe('INDEX = https://index.runtime.example.com');
  });

  it('falls back to the main Nexus when no marketplace Nexus is configured, like the app', async () => {
    vi.stubEnv('PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL', '');
    vi.stubEnv('PUBKY_RUNTIME_NEXUS_URL', 'https://nexus.runtime.example.com');

    const body = await GET().text();

    expect(indexLine(body)).toBe('INDEX = https://nexus.runtime.example.com');
  });

  it('is not shadowed by a static public/llms.txt with a fixed host', () => {
    expect(existsSync(path.join(process.cwd(), 'public', 'llms.txt'))).toBe(false);
  });
});
