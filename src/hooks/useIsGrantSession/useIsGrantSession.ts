'use client';

import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * Whether the signed-in session is grant-backed (Bitkit or Pubky Passport sign-in). Such a
 * session carries no AuthToken and no homeserver cookie, so the Shop's
 * classic Pubky Ring approvals cannot run for it.
 */
export function useIsGrantSession(): boolean {
  return useAuthStore((state) => state.session != null && state.session.grant !== undefined);
}
