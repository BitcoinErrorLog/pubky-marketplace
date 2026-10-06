import type { Session } from '@synonymdev/pubky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApplication } from '@/application/auth/auth';
import { AuthController } from '@/controllers/auth/auth';
import { AUTH_EPOCH_KEY } from '@/controllers/auth/auth-epoch';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { HttpMethod } from '@/libs/http/http.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { asOpaque } from '@/test-utils/type-assertions';
import { CommerceHomeserverService } from './commerce/commerce';
import { HomeserverService } from './homeserver';
import { installHomeserverWriteRetryDependenciesForTests } from './write-retry';

const mockState = vi.hoisted(() => ({
  putJson: vi.fn(),
  putBytes: vi.fn(),
  delete: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@synonymdev/pubky', () => {
  const createSdk = () => ({
    client: { fetch: (...args: unknown[]) => mockState.fetch(...args) },
    publicStorage: { get: vi.fn(), exists: vi.fn(), list: vi.fn() },
  });
  const MockPubky = vi.fn().mockImplementation(createSdk);
  // @ts-expect-error testnet is a static constructor on the SDK class
  MockPubky.testnet = vi.fn().mockImplementation(createSdk);
  // @ts-expect-error withClient is a static constructor on the SDK class
  MockPubky.withClient = vi.fn().mockImplementation(createSdk);
  return { Pubky: MockPubky, Client: vi.fn(), resolvePubky: (url: string) => url };
});

const LISTING_URL = 'pubky://user/pub/pubky.app/marketplace/v1/listings/boots';
const PROFILE_URL = 'pubky://user/pub/pubky.app/profile.json';
const MUTE_URL = 'pubky://user/pub/pubky.app/mutes/mutee';

function session(): Session {
  return asOpaque<Session>({
    info: { publicKey: { z32: () => 'user' } },
    storage: {
      putJson: (...args: unknown[]) => mockState.putJson(...args),
      putBytes: (...args: unknown[]) => mockState.putBytes(...args),
      delete: (...args: unknown[]) => mockState.delete(...args),
      get: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  });
}

function requestError(statusCode: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Request failed: Server responded with an error: ${statusCode}`), {
    name: 'RequestError',
    data: { statusCode, ...extra },
  });
}

describe('homeserver writes route through the shared retry policy', () => {
  beforeEach(() => {
    // The SDK client is a process-wide singleton. A previous test can leave a
    // client whose fetch is not this file's mock.
    Reflect.set(HomeserverService, 'pubkySdk', null);
    localStorage.removeItem(AUTH_EPOCH_KEY);
    useAuthStore.setState({
      session: session(),
      currentUserPubky: 'user',
      sessionExport: null,
      grantSessionRecordId: null,
      isLoggingOut: false,
    });
    mockState.putJson.mockReset().mockResolvedValue(undefined);
    mockState.putBytes.mockReset().mockResolvedValue(undefined);
    mockState.delete.mockReset().mockResolvedValue(undefined);
    mockState.fetch.mockReset();
    installHomeserverWriteRetryDependenciesForTests({ sleep: async () => {}, random: () => 0, now: () => 0 });
  });

  afterEach(() => {
    installHomeserverWriteRetryDependenciesForTests(null);
    useAuthStore.setState({ session: null, currentUserPubky: null, isLoggingOut: false });
    vi.restoreAllMocks();
  });

  it('retries a listing PUT on 429 with Retry-After and replays the same JSON', async () => {
    const body = { name: 'boots', price: 1 };
    mockState.putJson
      .mockRejectedValueOnce(requestError(429, { headers: new Headers({ 'retry-after': '2' }) }))
      .mockImplementationOnce(async () => {
        body.price = 9;
      });

    await CommerceHomeserverService.putJson(LISTING_URL, body);

    expect(mockState.putJson).toHaveBeenCalledTimes(2);
    expect(mockState.putJson).toHaveBeenNthCalledWith(1, '/pub/pubky.app/marketplace/v1/listings/boots', {
      name: 'boots',
      price: 1,
    });
    expect(mockState.putJson).toHaveBeenNthCalledWith(2, '/pub/pubky.app/marketplace/v1/listings/boots', {
      name: 'boots',
      price: 1,
    });
  });

  it('revert-fail: aborts a retry while real logout is in progress before the auth epoch advances', async () => {
    mockState.putJson.mockRejectedValueOnce(requestError(500)).mockResolvedValueOnce(undefined);
    let releaseRetry!: () => void;
    const retryHeld = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    installHomeserverWriteRetryDependenciesForTests({
      sleep: async () => await retryHeld,
      random: () => 0,
      now: () => 0,
    });

    let releaseLogout!: () => void;
    const logoutHeld = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    vi.spyOn(AuthApplication, 'logout').mockImplementation(async () => await logoutHeld);
    vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);

    const write = HomeserverService.request({
      method: HttpMethod.PUT,
      url: PROFILE_URL,
      bodyJson: { name: 'Ada' },
    });
    await vi.waitFor(() => expect(mockState.putJson).toHaveBeenCalledOnce());

    const logout = AuthController.logout();
    await vi.waitFor(() => expect(useAuthStore.getState().isLoggingOut).toBe(true));
    expect(localStorage.getItem(AUTH_EPOCH_KEY)).toBeNull();

    releaseRetry();
    await expect(write).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED });

    expect(mockState.putJson).toHaveBeenCalledOnce();

    releaseLogout();
    await logout;
  });

  it('aborts a retry when the current session object is replaced during backoff', async () => {
    mockState.putJson.mockRejectedValueOnce(requestError(500)).mockResolvedValueOnce(undefined);
    installHomeserverWriteRetryDependenciesForTests({
      sleep: async () => {
        useAuthStore.setState({ session: session() });
      },
      random: () => 0,
      now: () => 0,
    });

    await expect(
      HomeserverService.request({
        method: HttpMethod.PUT,
        url: PROFILE_URL,
        bodyJson: { name: 'Ada' },
      }),
    ).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED });

    expect(mockState.putJson).toHaveBeenCalledOnce();
  });

  it('retries a profile PUT after 500 and does not retry a mute DELETE on 400', async () => {
    mockState.putJson.mockRejectedValueOnce(requestError(500)).mockResolvedValueOnce(undefined);
    await HomeserverService.request({
      method: HttpMethod.PUT,
      url: PROFILE_URL,
      bodyJson: { name: 'Ada' },
    });
    expect(mockState.putJson).toHaveBeenCalledTimes(2);

    mockState.delete.mockRejectedValueOnce(requestError(400));
    await expect(HomeserverService.request({ method: HttpMethod.DELETE, url: MUTE_URL })).rejects.toMatchObject({
      context: { statusCode: 400 },
    });
    expect(mockState.delete).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 DELETE and then a media PUT, copying bytes per attempt', async () => {
    mockState.delete.mockRejectedValueOnce(requestError(503)).mockResolvedValueOnce(undefined);
    await CommerceHomeserverService.delete(LISTING_URL);
    expect(mockState.delete).toHaveBeenCalledTimes(2);
    expect(mockState.delete).toHaveBeenNthCalledWith(1, '/pub/pubky.app/marketplace/v1/listings/boots');
    expect(mockState.delete).toHaveBeenNthCalledWith(2, '/pub/pubky.app/marketplace/v1/listings/boots');

    const bytes = new Uint8Array([7, 8, 9]);
    const seen: Uint8Array[] = [];
    mockState.putBytes.mockImplementation(async (_path: string, body: Uint8Array) => {
      seen.push(Uint8Array.from(body));
      if (seen.length === 1) {
        body.fill(0);
        throw requestError(500);
      }
    });

    await CommerceHomeserverService.putMedia(LISTING_URL, bytes);

    expect(seen).toHaveLength(2);
    expect(Array.from(seen[0])).toEqual([7, 8, 9]);
    expect(Array.from(seen[1])).toEqual([7, 8, 9]);
    expect(seen[0]).not.toBe(seen[1]);
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it('retries a non-owned PUT when the fetch response is 429 and stops on 400', async () => {
    useAuthStore.setState({ session: null });
    const url = 'https://homeserver.example/pub/file.json';
    mockState.fetch
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await HomeserverService.request({ method: HttpMethod.PUT, url, bodyJson: { ok: true } });
    expect(mockState.fetch).toHaveBeenCalledTimes(2);

    mockState.fetch.mockReset().mockResolvedValue(new Response(null, { status: 400 }));
    await expect(HomeserverService.request({ method: HttpMethod.DELETE, url })).rejects.toMatchObject({
      context: { statusCode: 400 },
    });
    expect(mockState.fetch).toHaveBeenCalledTimes(1);
  });
});
