import type { MessagingIntakeGate, MessagingPolicy } from '@/libs/messaging/intake-gate';

/** An intake gate that stores every message as coming from a known contact. */
export const ADMIT_ALL_GATE: MessagingIntakeGate = {
  admit: async () => ({ store: true, origin: 'known' }),
};

/** A confirmed policy with nobody muted, over {@link ADMIT_ALL_GATE}. */
export const ADMIT_ALL_POLICY: MessagingPolicy = { gate: ADMIT_ALL_GATE, isMuted: () => false };

/** A confirmed policy that treats `muted` as muted. */
export function policyMuting(...muted: string[]): MessagingPolicy {
  const set = new Set(muted);
  return {
    isMuted: (pubky) => set.has(pubky),
    gate: {
      admit: async ({ counterpartyPubky }) =>
        set.has(counterpartyPubky) ? { store: false, reason: 'muted' } : { store: true, origin: 'known' },
    },
  };
}
