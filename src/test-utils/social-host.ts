import { Env } from '@/libs/env/env';

/**
 * Sets the baked `NEXT_PUBLIC_SOCIAL_HOST` for the current test. `@/config/social`
 * reads it per call, so components rendered afterwards see the new state.
 * Call `setSocialHost(undefined)` in `afterEach` to restore the default (off).
 */
export function setSocialHost(host: string | undefined): void {
  Env.NEXT_PUBLIC_SOCIAL_HOST = host;
}
