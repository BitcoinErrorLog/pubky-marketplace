import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVENTORY_GRANT } from '@/services/marketplace/marketplace-inventory-grant';
import { MARKETPLACE_DISCLOSURE_INVENTORY } from '@/services/marketplace/marketplace-session-grant';
import ringCapture from '@/test/fixtures/auth/ring-signin-url.sdk-0.8.0.json';
import { MarketplaceInventoryGrantDialog } from './MarketplaceInventoryGrantDialog';

function ringUrl(caps: string): string {
  return `${ringCapture.scheme}//${ringCapture.host}?${ringCapture.params
    .map((name) => `${name}=${encodeURIComponent(name === 'caps' ? caps : 'x')}`)
    .join('&')}`;
}

const grant = vi.hoisted(() => ({ authorizationUrl: '' }));

vi.mock('@/hooks/useIsGrantSession/useIsGrantSession', () => ({ useIsGrantSession: () => false }));
vi.mock('@/hooks/useMarketplaceInventoryGrantConnect/useMarketplaceInventoryGrantConnect', () => ({
  useMarketplaceInventoryGrantConnect: () => ({
    status: 'awaiting',
    authorizationUrl: grant.authorizationUrl,
    errorMessage: null,
    isOpeningSigner: false,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(),
    openInSigner: vi.fn(),
  }),
}));

describe('Studio inventory grant QR', () => {
  beforeEach(() => {
    grant.authorizationUrl = ringUrl(INVENTORY_GRANT);
  });

  it('discloses the marketplace session its AuthToken mints', async () => {
    render(<MarketplaceInventoryGrantDialog />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve in your Pubky signer' }));

    expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_INVENTORY);
    expect(document.body.textContent).not.toContain(INVENTORY_GRANT);
  });

  it('shows nothing for a request that is not the Studio grant', async () => {
    grant.authorizationUrl = ringUrl('/:rw');
    render(<MarketplaceInventoryGrantDialog />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve in your Pubky signer' }));

    expect(screen.queryByTestId('session-approval-disclosure')).toBeNull();
  });
});
