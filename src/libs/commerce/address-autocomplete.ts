import { z } from 'zod';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';

export type ResolvedPostalAddress = {
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
};

export type AddressSuggestion = {
  id: string;
  primary: string;
  secondary: string;
  /** `house` when OpenStreetMap knows the house number; `street` when only the street matched. */
  precision: 'house' | 'street';
  address: ResolvedPostalAddress;
};

export type AddressSuggestResult = { status: 'ok'; suggestions: AddressSuggestion[] } | { status: 'unavailable' };

export type AddressSuggestOptions = {
  countryCode: string;
  signal?: AbortSignal;
};

export type AddressAutocompleteProvider = {
  suggest: (input: string, options: AddressSuggestOptions) => Promise<AddressSuggestResult>;
};

export const ADDRESS_ATTRIBUTION = {
  text: '© OpenStreetMap contributors',
  href: 'https://www.openstreetmap.org/copyright',
} as const;

export const ADDRESS_SUGGEST_MIN_CHARS = 4;
const ADDRESS_SUGGEST_MAX_CHARS = 120;
/** Longer than the service's 6-second upstream budget, so a slow OpenStreetMap answer still arrives. */
const REQUEST_TIMEOUT_MS = 8_000;
const CLIENT_CACHE_ENTRIES = 50;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MS = 5_000;

const suggestionSchema = z.looseObject({
  id: z.string().min(1).max(64),
  primary: z.string().min(1).max(200),
  secondary: z.string().max(400),
  precision: z.enum(['house', 'street']),
  address: z.looseObject({
    line1: z.string().min(1).max(200),
    city: z.string().max(200),
    region: z.string().max(200),
    postalCode: z.string().max(64),
    countryCode: z.string().length(2),
  }),
});

const responseSchema = z.looseObject({ suggestions: z.array(z.unknown()) });

/** Only a well-formed two-letter country code is ever sent to the service. */
function normalizeCountry(countryCode: string): string | null {
  const upper = countryCode.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function normalizeQuery(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
}

/**
 * Address suggestions through the marketplace service's OpenStreetMap proxy
 * (`POST /v0/address/suggest`). The browser never contacts the geocoder. Any
 * failure is `unavailable` and never throws: the address form keeps working
 * by hand. After a 429 or 503 the provider stays quiet for the service's
 * `Retry-After`, and it remembers recent answers so retyping costs nothing.
 */
export function createMarketplaceAddressProvider(baseUrl: string): AddressAutocompleteProvider {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v0/address/suggest`;
  const cache = new Map<string, AddressSuggestion[]>();
  let quietUntil = 0;

  return {
    async suggest(input, options) {
      const query = normalizeQuery(input);
      const country = normalizeCountry(options.countryCode);
      if (query.length < ADDRESS_SUGGEST_MIN_CHARS || query.length > ADDRESS_SUGGEST_MAX_CHARS || !country) {
        return { status: 'ok', suggestions: [] };
      }
      const cacheKey = `${country}|${query.toLowerCase()}`;
      const cached = cache.get(cacheKey);
      if (cached) return { status: 'ok', suggestions: cached };
      if (Date.now() < quietUntil) return { status: 'unavailable' };

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, country }),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal,
        });
        if (response.status === 429 || response.status === 503) {
          quietUntil = Date.now() + retryAfterMs(response);
          return { status: 'unavailable' };
        }
        if (!response.ok) return { status: 'unavailable' };
        const parsed = responseSchema.safeParse(toCamelCaseWire(await response.json()));
        if (!parsed.success) return { status: 'unavailable' };
        const suggestions = parsed.data.suggestions.flatMap((item) => {
          const row = suggestionSchema.safeParse(item);
          return row.success ? [row.data as AddressSuggestion] : [];
        });
        if (cache.size >= CLIENT_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(cacheKey, suggestions);
        return { status: 'ok', suggestions };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
