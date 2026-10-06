'use client';

import { LockKeyhole } from 'lucide-react';
import { Typography } from '@/atoms/Typography/Typography';
import { useGrantSigner } from '@/hooks/useGrantSigner/useGrantSigner';
import type { GrantSigner } from '@/stores/auth/auth.types';

export type GrantSessionRefusalReason = 'default' | 'messaging';

const GRANT_SIGNER_NAMES: Record<GrantSigner, string> = {
  bitkit: 'Bitkit',
  passport: 'Pubky Passport',
};

/**
 * What a grant (Bitkit or Pubky Passport) sign-in reads where the Shop cannot
 * serve it yet. Messaging needs an encrypted-messaging session that grant
 * sign-ins cannot open today, so that copy names no other signer: it says
 * what is missing and that the rest of Shop works.
 */
export function grantSessionRefusalCopy(reason: GrantSessionRefusalReason, signer: GrantSigner): string {
  const name = GRANT_SIGNER_NAMES[signer];
  return reason === 'messaging'
    ? `Messages are not available for ${name} sign-ins yet. Everything else in Shop works with this sign-in.`
    : `${name} sign-in does not cover this step yet. Sign in with Pubky Ring to continue.`;
}

/** Shown instead of a Pubky Ring approval QR when the Shop session came from a grant sign-in. */
export function GrantSessionRefusal({ reason = 'default' }: { reason?: GrantSessionRefusalReason }) {
  const signer = useGrantSigner() ?? 'bitkit';
  return (
    <div
      role="status"
      data-testid="grant-session-refusal"
      className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
    >
      <Typography as="p" className="text-sm text-muted-foreground">
        {grantSessionRefusalCopy(reason, signer)}
      </Typography>
    </div>
  );
}

/**
 * The messages inbox for a grant sign-in: messaging cannot be enabled for it
 * yet, so the inbox states that in place of the enable prompt and offers no
 * approval to start.
 */
export function GrantSessionMessagingNotice() {
  const signer = useGrantSigner() ?? 'bitkit';
  return (
    <div
      role="status"
      data-testid="grant-session-messaging-unavailable"
      className="flex items-center gap-2 rounded-xl border border-dashed p-5"
    >
      <LockKeyhole className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <Typography as="p" className="text-sm text-muted-foreground">
        {grantSessionRefusalCopy('messaging', signer)}
      </Typography>
    </div>
  );
}
