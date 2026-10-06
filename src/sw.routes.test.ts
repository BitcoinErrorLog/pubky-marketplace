import { Serwist } from 'serwist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asOpaque } from '@/test-utils/type-assertions';
import { buildRuntimeCaching } from './sw.routes';

class TestExtendableEvent extends Event {
  readonly lifetime: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>) {
    this.lifetime.push(promise);
  }
}

class TestFetchEvent extends TestExtendableEvent {
  constructor(
    readonly request: Request,
    readonly preloadResponse: Promise<Response | undefined>,
  ) {
    super('fetch');
  }
}

function requestWithMode(path: string, mode: RequestMode): Request {
  const request = new Request(new URL(path, window.location.origin));
  Object.defineProperty(request, 'mode', { value: mode });
  return request;
}

function handle(serwist: Serwist, request: Request, preload?: Response) {
  const event = new TestFetchEvent(request, Promise.resolve(preload));
  return serwist.handleRequest({ request, event: asOpaque<FetchEvent>(event) });
}

describe('service worker runtime routes', () => {
  let serwist: Serwist;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('ExtendableEvent', TestExtendableEvent);
    vi.stubGlobal('FetchEvent', TestFetchEvent);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('from network', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    serwist = new Serwist({ runtimeCaching: buildRuntimeCaching(), disableDevLogs: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a navigation with the navigation-preload response and sends no second request', async () => {
    const preload = new Response('preloaded page', { status: 200 });

    const response = await handle(serwist, requestWithMode('/marketplace', 'navigate'), preload);

    expect(response).toBe(preload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a navigation from the network when the browser supplied no preload', async () => {
    const request = requestWithMode('/marketplace', 'navigate');

    const response = await handle(serwist, request);

    expect(await response?.text()).toBe('from network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe(request.url);
  });

  it('leaves same-origin subresource requests to the browser', () => {
    expect(handle(serwist, requestWithMode('/_next/static/chunks/main.js', 'no-cors'))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
