type ResolveMedia = (uri: string | null | undefined) => string | null;

function defaultResolve(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  const path = uri.slice(uri.indexOf('/pub/'));
  const owner = uri.slice('pubky://'.length, uri.indexOf('/pub/'));
  return `https://homeserver.example${path}?pubky-host=${owner}`;
}

export function createMarketplaceMediaHooks(resolve: ResolveMedia = defaultResolve) {
  return {
    useMarketplaceMediaUrl: (uri: string | null | undefined): string | null => resolve(uri),
    resolveMarketplaceMediaUrlAsync: async (uri: string): Promise<string | null> => resolve(uri),
    useMarketplaceFirstMediaUrl: (uris: readonly string[]): string | null =>
      uris.map(resolve).find((url): url is string => url !== null) ?? null,
    useMarketplaceMediaUrls: (uris: readonly string[]): readonly (string | null)[] => uris.map(resolve),
    useMarketplaceFirstMediaUrls: (uris: readonly (readonly string[])[]): readonly (string | null)[] =>
      uris.map((group) => group.map(resolve).find((url): url is string => url !== null) ?? null),
  };
}

export const marketplaceMediaHooks = createMarketplaceMediaHooks();

export const useMarketplaceMediaUrl = marketplaceMediaHooks.useMarketplaceMediaUrl;
export const resolveMarketplaceMediaUrlAsync = marketplaceMediaHooks.resolveMarketplaceMediaUrlAsync;
export const useMarketplaceFirstMediaUrl = marketplaceMediaHooks.useMarketplaceFirstMediaUrl;
export const useMarketplaceMediaUrls = marketplaceMediaHooks.useMarketplaceMediaUrls;
export const useMarketplaceFirstMediaUrls = marketplaceMediaHooks.useMarketplaceFirstMediaUrls;
