// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceOrderActions } from '@/organisms/Marketplace/MarketplaceOrderActions';

// The review dialog's D2 amount-band opt-in and the own-review verified
// status line, in every honest state: seller consented (checkbox), seller
// declined (truthful note, no checkbox), and the three publication states of
// the user's own record.

const fixtures = vi.hoisted(async () => {
  const { createOrderFixture, ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/orders');
  const { VRT_FROZEN_NOW_MS, HOUR_MS } = await import('@/test-utils/vrt.clock');
  const reviewedOrder = createOrderFixture('completed', {
    reviews: [
      {
        id: '018f47d2-6a27-7c23-a62f-000000000601',
        reviewerPubky: ORDER_FIXTURE_BUYER,
        subjectPubky: ORDER_FIXTURE_SELLER,
        rating: 5,
        text: 'Accurate and fast.',
        createdAt: new Date(VRT_FROZEN_NOW_MS - HOUR_MS).toISOString(),
      },
    ],
  });
  return {
    buyer: ORDER_FIXTURE_BUYER,
    unreviewedOrder: createOrderFixture('completed', { reviews: [] }),
    reviewedOrder,
  };
});

const controllerState = vi.hoisted(() => ({
  bandConsent: null as boolean | null,
  ownReview: null as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    getMarketplaceBandConsent: vi.fn(async () => controllerState.bandConsent),
    getOwnMarketplaceReview: vi.fn(async () => controllerState.ownReview),
  },
}));

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error('Dialog has not opened yet.');
  });
}

function Harness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

function ownReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row',
    owner_id: 'b'.repeat(52),
    review_id: '8Z8CWH8NVYQY39ZEBFGKQWWEKG',
    order_id: 'order-1',
    subject_id: 's'.repeat(52),
    record: {},
    attestation_verified: true,
    attestation_iss: 'o'.repeat(52),
    sync_status: 'synced',
    updated_at: 0,
    ...overrides,
  };
}

describe('Marketplace review attestation surfaces — visual regression', () => {
  it('renders the band opt-in when the seller consented at desktop viewport', async () => {
    const { unreviewedOrder } = await fixtures;
    controllerState.bandConsent = true;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceOrderActions
          order={unreviewedOrder}
          isBuyer={true}
          canEditReview={true}
          actOnOrder={vi.fn(async () => true)}
        />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Leave review' }));
    await vi.waitFor(() => {
      if (!document.querySelector('[role="checkbox"]')) throw new Error('Band opt-in has not rendered yet.');
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-dialog-band-optin-desktop');
  });

  it('renders the truthful no-band note when the seller declined at desktop viewport', async () => {
    const { unreviewedOrder } = await fixtures;
    controllerState.bandConsent = false;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceOrderActions
          order={unreviewedOrder}
          isBuyer={true}
          canEditReview={true}
          actOnOrder={vi.fn(async () => true)}
        />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Leave review' }));
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('has not enabled price-range sharing')) {
        throw new Error('Consent note has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-dialog-band-declined-desktop');
  });

  it('renders the band opt-in at mobile viewport', async () => {
    const { unreviewedOrder } = await fixtures;
    controllerState.bandConsent = true;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceOrderActions
          order={unreviewedOrder}
          isBuyer={true}
          canEditReview={true}
          actOnOrder={vi.fn(async () => true)}
        />
      </Harness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await openDialog(screen.getByRole('button', { name: 'Leave review' }));
    await vi.waitFor(() => {
      if (!document.querySelector('[role="checkbox"]')) throw new Error('Band opt-in has not rendered yet.');
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-dialog-band-optin-mobile');
  });

  async function renderStatusScenario(row: unknown) {
    const { reviewedOrder } = await fixtures;
    controllerState.ownReview = row;
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceOrderActions
          order={reviewedOrder}
          isBuyer={true}
          canEditReview={true}
          actOnOrder={vi.fn(async () => true)}
        />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="own-review-status"]')) {
        throw new Error('Status line has not rendered yet.');
      }
    });
    return screen;
  }

  it('renders the verified own-review state at desktop viewport', async () => {
    const screen = await renderStatusScenario(ownReviewRow());
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Verified purchase')) {
        throw new Error('Verified status has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-status-verified-desktop');
  });

  it('renders the pending-publication own-review state at desktop viewport', async () => {
    const screen = await renderStatusScenario(ownReviewRow({ sync_status: 'pending' }));
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Publication is pending')) {
        throw new Error('Pending status has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-status-pending-desktop');
  });

  it('renders the service-only own-review state at desktop viewport', async () => {
    const screen = await renderStatusScenario(null);
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('publication status will appear')) {
        throw new Error('Service-only status has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('review-status-service-only-desktop');
  });
});
