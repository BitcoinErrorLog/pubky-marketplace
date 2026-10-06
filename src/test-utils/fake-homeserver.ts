import { vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import type {
  THomeserverGetJsonIfFoundParams,
  THomeserverListParams,
  THomeserverRequestParams,
} from '@/services/homeserver/homeserver.types';

/**
 * An HTTP failure shaped like the real client's: the message may echo the
 * request path, and the context carries `endpoint` (the log URL when given).
 */
export function homeserverHttpError(statusCode: number, url?: string, logUrl?: string): AppError {
  return new AppError({
    category: ErrorCategory.Client,
    code: statusCode === 404 ? ClientErrorCode.NOT_FOUND : ClientErrorCode.BAD_REQUEST,
    message: url === undefined ? `HTTP ${statusCode}` : `HTTP ${statusCode} for ${url}`,
    service: ErrorService.Homeserver,
    operation: 'test',
    context: { statusCode, ...(url === undefined ? {} : { endpoint: logUrl ?? url }) },
  });
}

export type FakeHomeserver = {
  /** Stored JSON bodies by full `pubky://` URL. */
  files: Map<string, unknown>;
  /** Every request in order, as `METHOD url`. */
  log: string[];
  /** Requests to a `/priv/` path made without a redacted `logUrl`, as `METHOD url`. */
  unredacted: string[];
  /** Makes the next request matching `method` and `url` fail with `statusCode`. */
  failNext: (method: HttpMethod, url: string | RegExp, statusCode: number) => void;
  /** Stores `transform(body)` instead of the body for the next PUT to a matching URL. */
  corruptNextPut: (url: string | RegExp, transform: (body: unknown) => unknown) => void;
  /**
   * Parks the next request matching `method` and `url` before it takes
   * effect. `reached` resolves when it arrives; `release` lets it proceed.
   */
  holdNext: (method: HttpMethod, url: string | RegExp) => { reached: Promise<void>; release: () => void };
  /**
   * Called before each request or list takes effect and again after it has
   * settled (resolved or thrown), with the `METHOD url` entry. Tests use it to change state at every await
   * boundary of a flow.
   */
  onRequest: ((event: { entry: string; phase: 'before' | 'after' }) => void) | null;
  /** Parks every list call (after it has read the directory) until {@link releaseLists}. */
  holdLists: () => void;
  releaseLists: () => void;
};

/**
 * An in-memory homeserver behind `HomeserverService.request`,
 * `HomeserverService.getJsonIfFound` and `HomeserverService.list`, so
 * application code runs its real service calls
 * (and real crypto) against stored bytes the test can inspect.
 */
export function installFakeHomeserver(): FakeHomeserver {
  const files = new Map<string, unknown>();
  const log: string[] = [];
  const unredacted: string[] = [];
  const failures: { method: HttpMethod; url: string | RegExp; statusCode: number }[] = [];
  const corruptions: { url: string | RegExp; transform: (body: unknown) => unknown }[] = [];
  const holds: { method: HttpMethod; url: string | RegExp; arrive: () => void; proceed: Promise<void> }[] = [];
  let held: (() => void)[] | null = null;
  const matches = (pattern: string | RegExp, url: string) =>
    typeof pattern === 'string' ? pattern === url : pattern.test(url);

  const fake = {} as FakeHomeserver;
  const notify = (entry: string, phase: 'before' | 'after') => fake.onRequest?.({ entry, phase });

  vi.spyOn(HomeserverService, 'request').mockImplementation(async (params: THomeserverRequestParams) => {
    const entry = `${params.method} ${params.url}`;
    notify(entry, 'before');
    try {
      return (await perform(params)) as never;
    } finally {
      notify(entry, 'after');
    }
  });

  const perform = async (params: THomeserverRequestParams): Promise<unknown> => {
    const { method, url, bodyJson, logUrl } = params;
    log.push(`${method} ${url}`);
    if (url.includes('/priv/') && logUrl === undefined) unredacted.push(`${method} ${url}`);
    const failure = failures.findIndex((entry) => entry.method === method && matches(entry.url, url));
    if (failure >= 0) {
      const [{ statusCode }] = failures.splice(failure, 1);
      throw homeserverHttpError(statusCode, url, logUrl);
    }
    const hold = holds.findIndex((entry) => entry.method === method && matches(entry.url, url));
    if (hold >= 0) {
      const [{ arrive, proceed }] = holds.splice(hold, 1);
      arrive();
      await proceed;
    }
    if (method === HttpMethod.GET) {
      if (!files.has(url)) throw homeserverHttpError(404);
      return structuredClone(files.get(url));
    }
    if (method === HttpMethod.PUT) {
      const corruption = corruptions.findIndex((entry) => matches(entry.url, url));
      const body = structuredClone(bodyJson);
      files.set(url, corruption >= 0 ? corruptions.splice(corruption, 1)[0].transform(body) : body);
      return undefined;
    }
    if (method === HttpMethod.DELETE) {
      files.delete(url);
      return undefined;
    }
    throw homeserverHttpError(405);
  };

  vi.spyOn(HomeserverService, 'getJsonIfFound').mockImplementation(async (params: THomeserverGetJsonIfFoundParams) => {
    const entry = `${HttpMethod.GET} ${params.url}`;
    notify(entry, 'before');
    try {
      return { found: true, json: (await perform({ method: HttpMethod.GET, ...params })) as never };
    } catch (error) {
      if (error instanceof AppError && error.context?.statusCode === 404) return { found: false };
      throw error;
    } finally {
      notify(entry, 'after');
    }
  });

  vi.spyOn(HomeserverService, 'list').mockImplementation(async (params: THomeserverListParams) => {
    notify(`LIST ${params.baseDirectory}`, 'before');
    try {
      return await performList(params);
    } finally {
      notify(`LIST ${params.baseDirectory}`, 'after');
    }
  });

  const performList = async (params: THomeserverListParams): Promise<string[]> => {
    const { baseDirectory, limit, logUrl, cursor } = params;
    log.push(`LIST ${baseDirectory}`);
    if (baseDirectory.includes('/priv/') && logUrl === undefined) unredacted.push(`LIST ${baseDirectory}`);
    const failure = failures.findIndex((entry) => entry.method === HttpMethod.GET && matches(entry.url, baseDirectory));
    if (failure >= 0) {
      const [{ statusCode }] = failures.splice(failure, 1);
      throw homeserverHttpError(statusCode, baseDirectory, logUrl);
    }
    // Like the homeserver: sorted, and a cursor starts after that URL.
    const result = [...files.keys()]
      .filter((url) => url.startsWith(baseDirectory) && (cursor === undefined || url > cursor))
      .sort()
      .slice(0, limit);
    if (held) await new Promise<void>((release) => held?.push(release));
    return result;
  };

  const api: FakeHomeserver = {
    onRequest: null,
    files,
    log,
    unredacted,
    failNext: (method, url, statusCode) => failures.push({ method, url, statusCode }),
    corruptNextPut: (url, transform) => corruptions.push({ url, transform }),
    holdNext: (method, url) => {
      let arrive = () => {};
      let release = () => {};
      const reached = new Promise<void>((resolve) => (arrive = resolve));
      const proceed = new Promise<void>((resolve) => (release = resolve));
      holds.push({ method, url, arrive, proceed });
      return { reached, release };
    },
    holdLists: () => {
      held = [];
    },
    releaseLists: () => {
      const waiting = held ?? [];
      held = null;
      for (const release of waiting) release();
    },
  };
  return Object.assign(fake, api);
}
