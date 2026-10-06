import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateDropBucket, fetchDropsStream, type NexusDropStreamEntry } from './drops-stream';

vi.mock('@/config/nexus', () => ({
  getMarketplaceNexusUrl: () => 'https://nexus.example',
}));

const SELLER = 's'.repeat(52);

function makeEntry(overrides: Partial<NexusDropStreamEntry> = {}): NexusDropStreamEntry {
  return {
    id: 'drop1',
    owner_id: SELLER,
    title: 'Vol 1',
    description: '',
    media_urls: [],
    format: 'fcfs',
    starts_at: '2026-09-01T17:00:00.000Z',
    ends_at: null,
    ...overrides,
  };
}

describe('fetchDropsStream', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null on 404 — the honest "not indexed on this deployment" outcome', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(fetchDropsStream()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nexus.example/v0/stream/drops',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('parses valid entries and drops malformed ones instead of failing the page', async () => {
    const valid = makeEntry();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([valid, { id: '', broken: true }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const entries = await fetchDropsStream({ limit: 30 });
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({ id: 'drop1', owner_id: SELLER, format: 'fcfs' });
    expect(fetchMock).toHaveBeenCalledWith('https://nexus.example/v0/stream/drops?limit=30', expect.anything());
  });

  it('throws on non-404 failures and non-array bodies', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(fetchDropsStream()).rejects.toThrow('status 500');

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ nope: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(fetchDropsStream()).rejects.toThrow('non-array');
  });
});

describe('estimateDropBucket', () => {
  const now = Date.parse('2026-09-01T17:00:00.000Z');

  it('buckets by indexed times relative to the device clock — estimates only', () => {
    expect(estimateDropBucket(makeEntry({ starts_at: '2026-09-02T00:00:00.000Z' }), now)).toBe('upcoming');
    expect(estimateDropBucket(makeEntry({ starts_at: '2026-09-01T00:00:00.000Z', ends_at: null }), now)).toBe('live');
    expect(
      estimateDropBucket(
        makeEntry({ starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-08-02T00:00:00.000Z' }),
        now,
      ),
    ).toBe('ended');
  });

  it('treats an unparseable start as upcoming rather than claiming live', () => {
    expect(estimateDropBucket(makeEntry({ starts_at: 'not-a-date' }), now)).toBe('upcoming');
  });
});
