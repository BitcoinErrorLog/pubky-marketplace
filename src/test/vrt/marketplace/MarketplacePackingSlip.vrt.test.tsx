// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplacePackingSlipDialog } from '@/organisms/Marketplace/MarketplacePackingSlipDialog';

// The seller's print-friendly packing slip. The slip renders ONLY what the
// seller's client legitimately holds — the seller's single-order projection
// when eligible, or the truthful unavailable notice with ruled lines. The
// pasted-address scene covers the optional local-only fallback: pasted text
// renders onto the slip but is never persisted or sent anywhere.
const fixtures = vi.hoisted(async () => {
  const { createOrderFixture } = await import('@/test/fixtures/commerce/orders');
  const { marketplaceDeliveryAddressSchema } = await import('@/services/marketplace/marketplace-projections');
  const { toCamelCaseWire } = await import('@/libs/commerce/wire-casing');
  const { default: sellerPaidShippingAddress } =
    await import('@/test/fixtures/commerce/seller-paid-shipping-address.json');
  const deliveryAddress = marketplaceDeliveryAddressSchema.parse(toCamelCaseWire(sellerPaidShippingAddress));
  return {
    paidOrder: createOrderFixture('paid'),
    sellerPaidShippingOrder: createOrderFixture('paid', {
      id: '018f47d2-6a27-7c23-a49d-000000009999',
      deliveryAddress,
    }),
    shippedOrder: createOrderFixture('shipped', {
      shipment: {
        carrier: 'USPS',
        trackingNumber: '9400111899223197428490',
        state: 'shipped' as const,
        shippedAt: '2026-08-14T10:00:00.000Z',
        deliveredAt: null,
      },
    }),
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketplace/orders',
}));

vi.mock('@/stores/auth/auth.store', async () => ({
  useAuthStore: createMarketplaceVrtAuthStore({
    currentUserPubky: (await fixtures).sellerPaidShippingOrder.sellerPubky,
  }),
}));

vi.mock('@/controllers/commerce/commerce', async () => ({
  CommerceController: {
    getMarketplaceOrder: async (orderId: string) => {
      const { sellerPaidShippingOrder } = await fixtures;
      return orderId === sellerPaidShippingOrder.id ? sellerPaidShippingOrder : null;
    },
  },
}));

async function openSlip(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[data-packing-slip]')) throw new Error('The packing slip has not opened yet.');
  });
  // The dialog's open-auto-focus lands on the paste textarea; whether the
  // focus ring paints depends on focus-visible heuristics that differ by
  // browser and by what ran before in the session. Blur so the capture is
  // deterministic regardless of suite context.
  (document.activeElement as HTMLElement | null)?.blur();
}

function SlipHarness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

describe('Marketplace packing slip — visual regression', () => {
  it('renders the packing slip for a paid order at desktop viewport', async () => {
    const { paidOrder } = await fixtures;

    const screen = await renderForVRT(
      <SlipHarness>
        <MarketplacePackingSlipDialog order={paidOrder} />
      </SlipHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openSlip(screen.getByRole('button', { name: 'Packing slip' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('packing-slip-paid-desktop');
  });

  it('renders the packing slip for a paid order at mobile viewport', async () => {
    const { paidOrder } = await fixtures;

    const screen = await renderForVRT(
      <SlipHarness>
        <MarketplacePackingSlipDialog order={paidOrder} />
      </SlipHarness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await openSlip(screen.getByRole('button', { name: 'Packing slip' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('packing-slip-paid-mobile');
  });

  it('renders the packing slip with shipment facts at desktop viewport', async () => {
    const { shippedOrder } = await fixtures;

    const screen = await renderForVRT(
      <SlipHarness>
        <MarketplacePackingSlipDialog order={shippedOrder} />
      </SlipHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openSlip(screen.getByRole('button', { name: 'Packing slip' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('packing-slip-shipped-desktop');
  });

  it('renders the packing slip with a pasted delivery address at desktop viewport', async () => {
    const { paidOrder } = await fixtures;

    const screen = await renderForVRT(
      <SlipHarness>
        <MarketplacePackingSlipDialog order={paidOrder} />
      </SlipHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openSlip(screen.getByRole('button', { name: 'Packing slip' }));
    await screen
      .getByLabelText('Paste delivery address (optional)')
      .fill('Ada Buyer\n123 Privacy Lane\n83820 Someville, US');
    // See openSlip: drop the focus the fill left on the textarea.
    (document.activeElement as HTMLElement | null)?.blur();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('packing-slip-pasted-address-desktop');
  });

  it('renders a seller paid shipping address at desktop viewport', async () => {
    const { sellerPaidShippingOrder } = await fixtures;

    const screen = await renderForVRT(
      <SlipHarness>
        <MarketplacePackingSlipDialog order={sellerPaidShippingOrder} />
      </SlipHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openSlip(screen.getByRole('button', { name: 'Packing slip' }));
    await vi.waitFor(() => {
      if (!document.querySelector('[data-packing-slip]')?.textContent?.includes('1 Market Street')) {
        throw new Error('The seller address branch has not rendered yet.');
      }
    });
    const surface = document.querySelector('[data-packing-slip]');
    if (!(surface instanceof HTMLElement)) throw new Error('The packing slip surface is missing.');
    await expect(page.elementLocator(surface)).toMatchScreenshot('packing-slip-seller-paid-shipping-address-desktop');
  });
});
