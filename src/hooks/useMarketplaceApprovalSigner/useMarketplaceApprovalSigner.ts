'use client';

import { useGrantSigner } from '@/hooks/useGrantSigner/useGrantSigner';
import { getMarketplaceGrantFlowEnabled, getPassportSignInEnabled } from '@/libs/runtime-config/runtime-config';

export type MarketplaceApprovalSigner = 'Bitkit' | 'Pubky Passport' | 'Pubky Ring';

/**
 * The signer that approves marketplace purchases for this sign-in: the grant
 * signer (Bitkit or Pubky Passport) for a grant sign-in that can bootstrap,
 * Pubky Ring otherwise. With Passport switched off, a Passport sign-in cannot
 * bootstrap and gets the Ring copy, like Bitkit with the grant flow off.
 */
export function useMarketplaceApprovalSigner(): MarketplaceApprovalSigner {
  const grantSigner = useGrantSigner();
  if (!grantSigner || !getMarketplaceGrantFlowEnabled()) return 'Pubky Ring';
  if (grantSigner === 'passport') return getPassportSignInEnabled() ? 'Pubky Passport' : 'Pubky Ring';
  return 'Bitkit';
}
