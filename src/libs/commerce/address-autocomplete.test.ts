import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import wireFixture from '@/test/fixtures/commerce/address-suggest-response.wire.json';
import { ADDRESS_ATTRIBUTION, createMarketplaceAddressProvider } from './address-autocomplete';

const BASE_URL = 'https://service.example';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(wireFixture));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createMarketplaceAddressProvider', () => {
  it('parses the service response captured from the OpenStreetMap proxy', async () => {
    const provider = createMarketplaceAddressProvider(BASE_URL);
    const result = await provider.suggest('42 Union Street New Bedford', { countryCode: 'us' });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.suggestions).toHaveLength(wireFixture.suggestions.length);
    expect(result.suggestions[0]).toMatchObject({
      id: 'w664957911',
      primary: '42 Union Street',
      secondary: 'New Bedford, Massachusetts 02740',
      precision: 'street',
      address: {
        line1: '42 Union Street',
        city: 'New Bedford',
        region: 'Massachusetts',
        postalCode: '02740',
        countryCode: 'US',
      },
    });
    expect(result.suggestions[1].precision).toBe('house');
  });

  it('sends only the query and the country, without credentials or a referrer', async () => {
    const provider = createMarketplaceAddressProvider(`${BASE_URL}/`);
    await provider.suggest('  42   Union Street ', { countryCode: 'us' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v0/address/suggest`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ q: '42 Union Street', country: 'US' });
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('does not call the service for short input or a malformed country', async () => {
    const provider = createMarketplaceAddressProvider(BASE_URL);
    expect(await provider.suggest('4 U', { countryCode: 'US' })).toEqual({ status: 'ok', suggestions: [] });
    expect(await provider.suggest('42 Union Street', { countryCode: 'USA' })).toEqual({
      status: 'ok',
      suggestions: [],
    });
    expect(await provider.suggest('42 Union Street', { countryCode: '' })).toEqual({
      status: 'ok',
      suggestions: [],
    });
    expect(await provider.suggest('a'.repeat(121), { countryCode: 'US' })).toEqual({
      status: 'ok',
      suggestions: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers answers so retyping the same address costs nothing', async () => {
    const provider = createMarketplaceAddressProvider(BASE_URL);
    await provider.suggest('42 Union Street', { countryCode: 'US' });
    await provider.suggest('42  union street', { countryCode: 'US' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await provider.suggest('42 Union Street', { countryCode: 'CA' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for Retry-After after a rate limit, then asks again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } }));
    const provider = createMarketplaceAddressProvider(BASE_URL);

    expect(await provider.suggest('42 Union Street', { countryCode: 'US' })).toEqual({ status: 'unavailable' });
    expect(await provider.suggest('43 Union Street', { countryCode: 'US' })).toEqual({ status: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T10:00:31Z'));
    const result = await provider.suggest('43 Union Street', { countryCode: 'US' });
    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps a long Retry-After and treats a missing one as a short pause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503, headers: { 'Retry-After': '86400' } }));
    const provider = createMarketplaceAddressProvider(BASE_URL);
    await provider.suggest('42 Union Street', { countryCode: 'US' });

    vi.setSystemTime(new Date('2026-09-29T10:01:01Z'));
    expect((await provider.suggest('43 Union Street', { countryCode: 'US' })).status).toBe('ok');

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    await provider.suggest('44 Union Street', { countryCode: 'US' });
    vi.setSystemTime(new Date('2026-09-29T10:01:07Z'));
    expect((await provider.suggest('45 Union Street', { countryCode: 'US' })).status).toBe('ok');
  });

  it.each([
    ['a 500', () => jsonResponse({}, { status: 500 })],
    ['a 400', () => jsonResponse({}, { status: 400 })],
    ['non-JSON', () => new Response('<html>', { status: 200 })],
    ['a body without suggestions', () => jsonResponse({ ok: true })],
    ['a JSON array', () => jsonResponse([])],
  ])('reports unavailable for %s and never throws', async (_label, respond) => {
    fetchMock.mockImplementationOnce(async () => respond());
    const provider = createMarketplaceAddressProvider(BASE_URL);
    expect(await provider.suggest('42 Union Street', { countryCode: 'US' })).toEqual({ status: 'unavailable' });
  });

  it('reports unavailable when the network fails or the caller aborts', async () => {
    const provider = createMarketplaceAddressProvider(BASE_URL);
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await provider.suggest('42 Union Street', { countryCode: 'US' })).toEqual({ status: 'unavailable' });

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      controller.abort();
      init.signal?.throwIfAborted();
      return jsonResponse(wireFixture);
    });
    expect(await provider.suggest('43 Union Street', { countryCode: 'US', signal: controller.signal })).toEqual({
      status: 'unavailable',
    });
  });

  it('drops a malformed row and keeps the rest', async () => {
    const [first, second] = wireFixture.suggestions;
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        suggestions: [{ ...first, precision: 'rooftop' }, { id: 'x', primary: 'No address' }, second],
      }),
    );
    const provider = createMarketplaceAddressProvider(BASE_URL);
    const result = await provider.suggest('222 Union Street', { countryCode: 'US' });
    expect(result.status === 'ok' && result.suggestions.map((s) => s.id)).toEqual([second.id]);
  });

  it('waits longer than the service gives OpenStreetMap before giving up', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const provider = createMarketplaceAddressProvider(BASE_URL);
    await provider.suggest('42 Union Street', { countryCode: 'US' });

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0][0]).toBeGreaterThan(6_000);
  });

  it('asks again right after a short Retry-After from a single failed lookup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503, headers: { 'Retry-After': '2' } }));
    const provider = createMarketplaceAddressProvider(BASE_URL);
    expect(await provider.suggest('42 Union Street', { countryCode: 'US' })).toEqual({ status: 'unavailable' });

    vi.setSystemTime(new Date('2026-10-01T10:00:02.500Z'));
    expect((await provider.suggest('42 Union Street N', { countryCode: 'US' })).status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache an unavailable answer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    const provider = createMarketplaceAddressProvider(BASE_URL);
    expect((await provider.suggest('42 Union Street', { countryCode: 'US' })).status).toBe('unavailable');
    expect((await provider.suggest('42 Union Street', { countryCode: 'US' })).status).toBe('ok');
  });
});

describe('ADDRESS_ATTRIBUTION', () => {
  it('credits OpenStreetMap and links to its copyright page', () => {
    expect(ADDRESS_ATTRIBUTION.text).toBe('© OpenStreetMap contributors');
    expect(ADDRESS_ATTRIBUTION.href).toBe('https://www.openstreetmap.org/copyright');
  });
});
