'use client';

import { AuthController } from '@/controllers/auth/auth';
import type { Pubky } from '@/models/models.types';
import { useSessionHandoffStore } from '@/stores/sessionHandoff/sessionHandoff.store';

/** The pending `#s=` hand-off prompt, if any, and the two answers to it. */
export function useSessionHandoff(): { pendingPubky: Pubky | null; accept: () => void; decline: () => void } {
  const pendingPubky = useSessionHandoffStore((state) => state.pendingPubky);
  return {
    pendingPubky,
    accept: () => AuthController.answerSessionHandoff(true),
    decline: () => AuthController.answerSessionHandoff(false),
  };
}
