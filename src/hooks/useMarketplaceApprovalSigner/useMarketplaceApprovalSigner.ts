'use client';

import { useGrantSigner } from '@/hooks/useGrantSigner/useGrantSigner';
import { getMarketplaceGrantFlowEnabled, getPassportSignInEnabled } from '@/libs/runtime-config/runtime-config';
import type { GrantSigner } from '@/stores/auth/auth.types';

export type MarketplaceApprovalSigner = 'Bitkit' | 'Pubky Passport' | 'Pubky Ring' | 'Pubky Ring or Bitkit';

/**
 * The signer that approves marketplace purchases for a sign-in. With the
 * grant flow on, the approval is a grant link: the grant signer (Bitkit or
 * Pubky Passport) approves it for a grant sign-in, and either phone signer
 * holding the pubky (Pubky Ring or Bitkit) for a Ring sign-in. With the grant
 * flow off it is the Ring connect QR. With Passport switched off, a Passport
 * sign-in cannot bootstrap and gets the Ring copy, like Bitkit with the grant
 * flow off.
 */
export function marketplaceApprovalSigner(grantSigner: GrantSigner | null): MarketplaceApprovalSigner {
  if (!getMarketplaceGrantFlowEnabled()) return 'Pubky Ring';
  if (!grantSigner) return 'Pubky Ring or Bitkit';
  if (grantSigner === 'passport') return getPassportSignInEnabled() ? 'Pubky Passport' : 'Pubky Ring';
  return 'Bitkit';
}

/** {@link marketplaceApprovalSigner} for the signed-in session. */
export function useMarketplaceApprovalSigner(): MarketplaceApprovalSigner {
  return marketplaceApprovalSigner(useGrantSigner());
}
