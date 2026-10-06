import { create } from 'zustand';
import type { Pubky } from '@/models/models.types';

type SessionHandoffStore = {
  /** Identity a pending `#s=` hand-off would sign this tab in as; null when none is waiting. */
  pendingPubky: Pubky | null;
  setPendingPubky: (pubky: Pubky | null) => void;
};

// No persistence: a hand-off belongs to one page load.
export const useSessionHandoffStore = create<SessionHandoffStore>()((set) => ({
  pendingPubky: null,
  setPendingPubky: (pubky) => set({ pendingPubky: pubky }),
}));
