import { Env } from '@/libs/env/env';
import { toSocialHostUrl } from '@/libs/social-host/social-host';

/**
 * Social link-out switch for components (see `@/libs/social-host/social-host`).
 * Read per call rather than captured at import, so one artifact holds a single
 * baked value and tests can exercise both states.
 */
export function getSocialHost(): string | undefined {
  return Env.NEXT_PUBLIC_SOCIAL_HOST;
}

export function isSocialLinkOutEnabled(): boolean {
  return getSocialHost() !== undefined;
}

/** Absolute social-host URL for a social route path, or `null` while link-out is off. */
export function getSocialHostUrl(path: string): string | null {
  const host = getSocialHost();
  return host ? toSocialHostUrl(host, path) : null;
}
