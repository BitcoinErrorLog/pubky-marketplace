'use client';

import { useIsGrantSession } from '@/hooks/useIsGrantSession/useIsGrantSession';

/**
 * A Pubky Ring sign-in is the homeserver cookie that pubky.app in the same
 * browser also uses, so signing it out signs pubky.app out too. A Bitkit
 * grant session is the Shop's own.
 */
export const SIGN_OUT_COPY = {
  title: 'Sign out',
  cookie: 'Signs you out of the Shop and of pubky.app in this browser. Both use the same Pubky Ring sign-in.',
  grant: 'Signs you out of the Shop in this browser. pubky.app is not signed out.',
} as const;

/** Sign-out title and the description for the current session type. */
export function useSignOutCopy(): { title: string; description: string } {
  const isGrantSession = useIsGrantSession();
  return {
    title: SIGN_OUT_COPY.title,
    description: isGrantSession ? SIGN_OUT_COPY.grant : SIGN_OUT_COPY.cookie,
  };
}
