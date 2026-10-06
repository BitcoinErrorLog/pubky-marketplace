// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { createZustandLikeHook } from '@/test-utils/stores';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_DENSE_CHROME_SCREENSHOT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import { MarketplaceSell } from '@/templates/Marketplace/MarketplaceSell';

// 8x8 solid-color PNG so photo scenarios show real previews without any
// network fetch or file-picker interaction.
const PREVIEW_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=';

const draftFixture = vi.hoisted(() => ({
  id: 'draft_row_01',
  owner_id: 'y'.repeat(52),
  listing_id: 'draftlisting01',
  data: {
    form: {
      title: 'Vintage leather boots',
      description: 'Hand-finished leather boots with a softly worn patina. Resoled once.',
      categoryId: 'fashion',
      condition: 'good',
      countryCode: 'US',
      region: 'NY',
      saleFormat: 'fixed_price',
      price: '125.00',
      variants: [{ sku: 'BOOTS-42', size: '42', color: 'Brown', style: 'Classic', quantity: '1', priceOverride: '' }],
      fulfillment: 'physical',
      shippingPrice: '12.00',
      weightGrams: '1200',
      lengthMillimeters: '350',
      widthMillimeters: '250',
      heightMillimeters: '150',
      returnDays: '30',
    },
  },
  created_at: 1_000,
  // VRT_FROZEN_NOW_MS - 3 * MINUTE_MS. Duplicated here because vi.hoisted
  // cannot read imported bindings.
  updated_at: Date.UTC(2026, 0, 1, 12, 0, 0) - 3 * 60_000,
}));

interface MockMediaItem {
  key: string;
  kind: 'new';
  file: File;
  previewUrl: string;
  altText: string;
}

const view = vi.hoisted(() => ({
  adapterMode: 'sandbox' as 'sandbox' | 'transaction-service',
  drafts: [] as unknown[],
  mediaItems: [] as unknown[],
  shippingPresets: [] as unknown[],
  pickupAvailable: false,
  digitalAvailable: false,
  marketplaceSession: {
    pubky: 'y'.repeat(52),
    capabilities: '/pub/pubky.app/:rw',
    expiresAt: '2026-09-14T00:00:00.000Z',
    issuedAt: '2026-09-13T00:00:00.000Z',
  } as object | null,
  commitDeleteListingDraft: vi.fn((..._args: unknown[]) => Promise.resolve()),
  sessionErrorMessage: null as string | null,
}));
const sellerPaymentConfig = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    }),
  ),
);
const emptySellerPaymentConfig = {
  bitcoinAvailable: false,
  bitcoinOfferAvailable: true,
  paypalAvailable: false,
};
const paidSellerPaymentConfig = {
  bitcoinAvailable: true,
  bitcoinOfferAvailable: true,
  paypalAvailable: false,
};

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

// Two device-local shipping presets so the shipping section's apply-preset
// picker renders (shape mirrors CommerceShippingPresetModelSchema).
const presetFixtures = vi.hoisted(() => {
  const owner = 'y'.repeat(52);
  return [
    {
      id: `${owner}:preset_standard`,
      owner_id: owner,
      label: 'Standard shipping',
      price_minor: 1_200,
      currency: 'USD',
      estimated_min_days: 3,
      estimated_max_days: 7,
      created_at: 1_754_000_000_000,
      updated_at: 1_755_000_000_000,
    },
    {
      id: `${owner}:preset_express`,
      owner_id: owner,
      label: 'Express courier',
      price_minor: 2_500,
      currency: 'USD',
      estimated_min_days: 1,
      estimated_max_days: 2,
      created_at: 1_754_100_000_000,
      updated_at: 1_754_100_000_000,
    },
  ];
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  // Both the hook selector (publish guards) and getState() (Sell.submit) must
  // read the live view. A frozen snapshot would keep hasMarketplaceSession
  // true after a grant-expiry scene sets view.marketplaceSession = null.
  useCommerceStore: createZustandLikeHook({
    get marketplaceSession() {
      return view.marketplaceSession;
    },
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    getListingDrafts: () => Promise.resolve(view.drafts),
    commitUpdateListingDraft: () => Promise.resolve(),
    commitDeleteListingDraft: (...args: unknown[]) => view.commitDeleteListingDraft(...args),
    commitCreateMedia: () => Promise.resolve(),
    commitUpsertListing: () => Promise.resolve(),
    getShippingPresets: () => Promise.resolve(view.shippingPresets),
    commitUpsertShippingPreset: () => Promise.resolve(),
    fetchPickupAvailable: () => Promise.resolve(view.pickupAvailable),
    fetchDigitalDeliveryCapability: () =>
      Promise.resolve({ available: view.digitalAvailable, maxBytes: view.digitalAvailable ? 52_428_800 : null }),
    getSellerPaymentConfig: sellerPaymentConfig,
    hasFullHomeserverGrant: () => true,
  },
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect')>();
  return {
    ...actual,
    useMarketplaceSessionConnect: (options: { onConnected?: () => void } = {}) => {
      if (!view.sessionErrorMessage) return actual.useMarketplaceSessionConnect(options);
      return {
        status: 'error' as const,
        authorizationUrl: '',
        errorMessage: view.sessionErrorMessage,
        requestsFullGrant: false,
        start: vi.fn(),
        cancel: vi.fn(),
        copyAuthUrl: vi.fn(async () => undefined),
        openInRing: vi.fn(),
        isOpeningRing: false,
      };
    },
  };
});

vi.mock('@/hooks/useListingMediaManager/useListingMediaManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useListingMediaManager/useListingMediaManager')>();
  return {
    ...actual,
    useListingMediaManager: () => ({
      items: view.mediaItems,
      maxPhotos: 8,
      error: null,
      inputRef: { current: null },
      onInputChange: vi.fn(),
      choose: vi.fn(),
      removeItem: vi.fn(),
      moveItem: vi.fn(),
      setAltText: vi.fn(),
      seed: vi.fn(),
      restore: vi.fn(),
      reset: vi.fn(),
      prepare: vi.fn(async () => ({ ok: false as const, reason: 'no-photos' as const })),
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

function photoItem(key: string, altText: string): MockMediaItem {
  return {
    key,
    kind: 'new',
    file: new File([new Uint8Array([1, 2, 3, 4])], `${key}.png`, { type: 'image/png' }),
    previewUrl: PREVIEW_DATA_URL,
    altText,
  };
}

async function resumeAutosavedDraft(
  screen: Awaited<ReturnType<typeof renderForVRT>>,
  expectedTitle = draftFixture.data.form.title,
) {
  await vi.waitFor(() => {
    if (!screen.container.querySelector('[data-surface="listing-draft-restore-prompt"]')) {
      throw new Error('The resume prompt has not rendered yet.');
    }
  });
  await screen.getByRole('button', { name: 'Resume' }).click();
  await vi.waitFor(() => {
    const input = screen.container.querySelector<HTMLInputElement>('#title');
    if (input?.value !== expectedTitle) throw new Error('Draft has not populated the form yet.');
  });
}

describe('Marketplace sell studio — visual regression', () => {
  beforeEach(() => {
    // The display store persists to localStorage, which browser-mode workers
    // share across suites — MarketplacePricingUnits sets both systems, so an
    // unpinned preference here renders whichever ran last. Pin the system the
    // committed baselines were captured with.
    useMarketplaceDisplayStore.setState({ measurementSystem: 'imperial' });
    view.pickupAvailable = false;
    view.digitalAvailable = false;
    view.adapterMode = 'sandbox';
    view.drafts = [];
    view.mediaItems = [];
    view.shippingPresets = [];
    view.marketplaceSession = {
      pubky: 'y'.repeat(52),
      capabilities: '/pub/pubky.app/:rw',
      expiresAt: '2026-09-14T00:00:00.000Z',
      issuedAt: '2026-09-13T00:00:00.000Z',
    };
    view.sessionErrorMessage = null;
    view.commitDeleteListingDraft.mockClear();
    sellerPaymentConfig.mockReset();
    sellerPaymentConfig.mockImplementation(() => Promise.resolve(emptySellerPaymentConfig));
    sessionStorage.clear();
  });

  function assertStickyRailHasVisibleAncestors(rail: Element, scrollingRoot: Element) {
    expect(window.getComputedStyle(rail).position).toBe('sticky');
    for (let parent = rail.parentElement; parent && parent !== scrollingRoot; parent = parent.parentElement) {
      expect(window.getComputedStyle(parent).overflow).toBe('visible');
    }
  }

  it('keeps the production section rail sticky without an overflowing ancestor', async () => {
    view.drafts = [];
    view.mediaItems = [];
    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });

    const rail = document.querySelector('[aria-label="Listing sections"]');
    const scrollingRoot = document.querySelector(`[data-testid="${VRT_ROOT_TESTID}"]`);
    expect(rail).not.toBeNull();
    expect(scrollingRoot).not.toBeNull();
    assertStickyRailHasVisibleAncestors(rail!, scrollingRoot!);

    const clipped = document.createElement('div');
    clipped.style.overflow = 'hidden';
    const clonedRail = rail!.cloneNode(true);
    clipped.append(clonedRail);
    scrollingRoot!.append(clipped);
    expect(() => assertStickyRailHasVisibleAncestors(clonedRail as Element, scrollingRoot!)).toThrow();
    clipped.remove();
  });

  it('renders the empty listing form at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-empty-form-desktop');
  });

  it('renders the empty listing form at mobile viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot(
      'sell-empty-form-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the payment-method interstitial at desktop viewport', async () => {
    view.adapterMode = 'transaction-service';
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-surface="listing-payment-setup"]')) {
        throw new Error('The payment interstitial has not rendered yet.');
      }
      if (!screen.container.textContent?.includes('Buyers cannot pay you otherwise')) {
        throw new Error('The payment interstitial copy has not rendered yet.');
      }
    });
    expect(sellerPaymentConfig).toHaveBeenCalledWith('y'.repeat(52));
    expect(screen.container.querySelector('#title')).toBeNull();
    expect(screen.container.querySelector('[name="title"]')).toBeNull();
    await expect(expectVrtSurface('listing-payment-setup')).toMatchScreenshot('sell-payment-setup-desktop');
  });

  it('renders the payment-method interstitial at mobile viewport', async () => {
    view.adapterMode = 'transaction-service';
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_MOBILE });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-surface="listing-payment-setup"]')) {
        throw new Error('The payment interstitial has not rendered yet.');
      }
      if (!screen.container.textContent?.includes('Buyers cannot pay you otherwise')) {
        throw new Error('The payment interstitial copy has not rendered yet.');
      }
    });
    expect(screen.container.querySelector('#title')).toBeNull();
    await expect(expectVrtSurface('listing-payment-setup')).toMatchScreenshot(
      'sell-payment-setup-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('returns to the listing composer after a payment method is configured', async () => {
    view.adapterMode = 'transaction-service';
    view.drafts = [];
    view.mediaItems = [];

    const blocked = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!blocked.container.querySelector('[data-surface="listing-payment-setup"]')) {
        throw new Error('The payment interstitial has not rendered yet.');
      }
      if (!blocked.container.querySelector('a[href="/marketplace/settings?returnTo=%2Fmarketplace%2Fsell"]')) {
        throw new Error('The Payment settings link has not rendered yet.');
      }
    });
    expect(blocked.container.querySelector('#title')).toBeNull();
    const settingsLink = blocked.container.querySelector<HTMLAnchorElement>(
      'a[href="/marketplace/settings?returnTo=%2Fmarketplace%2Fsell"]',
    );
    expect(settingsLink).not.toBeNull();
    settingsLink!.addEventListener('click', (event) => event.preventDefault(), { capture: true });
    settingsLink!.click();
    expect(sessionStorage.getItem('pubky.marketplace.listingComposerReturnTo')).toBe('/marketplace/sell');

    sellerPaymentConfig.mockImplementation(() => Promise.resolve(paidSellerPaymentConfig));
    blocked.unmount();

    const composer = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!composer.container.querySelector('#title')) {
        throw new Error('The listing composer has not rendered yet.');
      }
    });
    expect(composer.container.querySelector('[data-surface="listing-payment-setup"]')).toBeNull();
    expect(
      [...composer.container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Publish listing'),
      ),
    ).toBe(true);
  });

  // The shipping section with saved presets: the apply-preset picker renders
  // next to "Save as preset" once the seller has presets on this device.
  it('renders the shipping section with the preset picker at desktop viewport', async () => {
    view.drafts = [draftFixture];
    view.mediaItems = [];
    view.shippingPresets = presetFixtures;

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.querySelector('#listing-shipping-preset')) {
        throw new Error('The preset picker has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-shipping-presets-desktop');
    view.shippingPresets = [];
  });

  // Digital delivery beside shipping (digital delivery design §2): the three
  // delivery checkboxes, the publish-first note and the PayPal warning.
  it('renders digital delivery beside shipping with the PayPal warning at desktop viewport', async () => {
    view.drafts = [
      { ...draftFixture, data: { form: { ...draftFixture.data.form, fulfillment: 'shipping_and_digital' } } },
    ];
    view.mediaItems = [];
    view.pickupAvailable = true;
    view.digitalAvailable = true;
    sellerPaymentConfig.mockImplementation(() =>
      Promise.resolve({ ...paidSellerPaymentConfig, paypalAvailable: true }),
    );

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-testid="listing-digital-paypal-warning"]')) {
        throw new Error('The PayPal warning has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('listing-section-shipping')).toMatchScreenshot('sell-digital-delivery-desktop');
  });

  it('renders unlimited stock on a digital-only variant at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            fulfillment: 'digital',
            variants: [
              {
                sku: 'GUIDE',
                size: '',
                color: '',
                style: '',
                quantity: '1',
                unlimited: true,
                priceOverride: '',
              },
            ],
          },
        },
      },
    ];
    view.mediaItems = [];
    view.digitalAvailable = true;

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      const quantity = screen.container.querySelector<HTMLInputElement>('#variants\\.0\\.quantity');
      if (quantity?.value !== 'Unlimited' || !quantity.disabled) {
        throw new Error('Unlimited quantity has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('listing-section-price')).toMatchScreenshot('sell-unlimited-stock-desktop');
  });

  it('renders the restore prompt at desktop viewport', async () => {
    view.drafts = [draftFixture];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-surface="listing-draft-restore-prompt"]')) {
        throw new Error('The restore prompt has not rendered yet.');
      }
    });
    expect(screen.container.querySelector('[data-surface="listing-draft-restore-prompt"]')?.textContent).toContain(
      'Resume your draft from 3 min ago?',
    );
    await expect(expectVrtSurface('listing-draft-restore-prompt')).toMatchScreenshot(
      'sell-draft-restore-prompt-desktop',
    );
  });

  it('renders the form with an autosaved draft restored at desktop viewport', async () => {
    view.drafts = [draftFixture];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-surface="listing-draft-restored"]')) {
        throw new Error('The restored-draft banner has not rendered yet.');
      }
    });
    const banner = screen.container.querySelector('[data-surface="listing-draft-restored"]');
    expect(banner?.textContent).toContain('including photos saved on it.');
    await expect(expectVrtSurface('listing-draft-restored')).toMatchScreenshot('sell-draft-restored-desktop');
  });

  it('renders the seller-private auction reserve at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          ...draftFixture.data,
          form: {
            ...draftFixture.data.form,
            saleFormat: 'auction',
            reservePrice: '200.00',
            fulfillment: 'shipping',
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      const input = screen.container.querySelector<HTMLInputElement>('#reservePrice');
      if (input?.value !== '200.00') throw new Error('Private reserve has not populated the form yet.');
    });
    await expect(expectVrtSurface('listing-section-price')).toMatchScreenshot('sell-auction-private-reserve-desktop');
  });

  it('renders the form with additional variants added at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: 'Add variant' }).click();
    await screen.getByRole('button', { name: 'Add variant' }).click();
    await vi.waitFor(() => {
      if (screen.container.querySelectorAll('input[name^="variants."][name$=".sku"]').length !== 3) {
        throw new Error('Variant rows have not rendered yet.');
      }
    });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-variants-added-desktop');
  });

  it('renders the compose form with multiple ordered photos at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
      photoItem('photo_sole', 'Soles with light wear'),
    ];

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-photos-attached-desktop');
  });

  it('renders the compose form with multiple ordered photos at mobile viewport', async () => {
    view.drafts = [];
    view.mediaItems = [
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
    ];

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-photos-attached-mobile');
  });

  it('renders the photo list after a reorder moved a new cover first at desktop viewport', async () => {
    view.drafts = [];
    // Same photos as the compose scenario but with the sole shot promoted to
    // cover — the Cover badge must follow position one, not the original file.
    view.mediaItems = [
      photoItem('photo_sole', 'Soles with light wear'),
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
    ];

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-photos-reordered-desktop');
  });

  it('renders the photo limit reached state at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = Array.from({ length: 8 }, (_, index) =>
      photoItem(`photo_${index + 1}`, `Detail photo ${index + 1}`),
    );

    await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-photos-limit-desktop');
  });

  // A restored draft for a sized fashion leaf: the category cascade shows
  // the full path and the category-dependent item specifics render populated
  // (size chart select, brand, color/style chips, source, age).
  it('renders fashion item specifics for a sized leaf at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            categoryId: 'fashion-men-tops-hoodies',
            attrSize: 'L',
            attrBrand: 'Champion',
            attrColors: ['grey', 'navy'],
            attrSource: 'vintage',
            attrAge: '90s',
            attrStyles: ['retro', 'sportswear'],
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-cy="marketplace-listing-attributes"]')) {
        throw new Error('The item specifics block has not rendered yet.');
      }
      if (!screen.container.querySelector('#marketplace-attribute-size')) {
        throw new Error('The size field has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-attributes-fashion-desktop');
    view.drafts = [];
  });

  it('renders electronics item specifics (brand, model, colors) at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            title: 'Program-mode 35mm SLR',
            description: 'Clean program-mode SLR body with a fresh light seal service.',
            categoryId: 'electronics-cameras-film',
            attrBrand: 'Canon',
            attrModel: 'AE-1 Program',
            attrColors: ['black'],
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen, 'Program-mode 35mm SLR');
    await vi.waitFor(() => {
      if (!screen.container.querySelector('#marketplace-attribute-model')) {
        throw new Error('The model field has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-attributes-electronics-desktop');
    view.drafts = [];
  });

  it('renders validation errors after an empty submit at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            description: '',
            fulfillment: 'pickup',
          },
        },
      },
    ];
    view.mediaItems = [photoItem('photo_front', 'Front view of the boots')];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Description')) {
        throw new Error('The description checklist row has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('seller-studio')).toMatchScreenshot('sell-validation-errors-desktop');
  });

  it('renders the seller studio with pickup enabled and a pickup-only draft at desktop viewport', async () => {
    view.pickupAvailable = true;
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            fulfillment: 'pickup',
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Publish first, then add your meeting point')) {
        throw new Error('The pickup-enabled studio copy has not rendered yet.');
      }
      const pickup = screen.container.querySelector('#listing-delivery-pickup');
      if (pickup?.getAttribute('data-state') !== 'checked') {
        throw new Error('The pickup fulfillment value has not restored yet.');
      }
      if (screen.container.querySelector('[data-testid="pickup-capability-skeleton"]')) {
        throw new Error('Pickup capability is still loading.');
      }
      if (screen.container.textContent?.includes('Invalid option')) {
        throw new Error('Fulfillment still has a schema error.');
      }
    });
    await expect(expectVrtSurface('listing-section-shipping')).toMatchScreenshot('sell-pickup-enabled-desktop');
    view.pickupAvailable = false;
    view.drafts = [];
  });

  it('keeps the restored draft when the grant dialog reports approval expired', async () => {
    view.adapterMode = 'transaction-service';
    view.marketplaceSession = null;
    view.sessionErrorMessage = 'The approval expired before it was completed. Try again.';
    view.drafts = [draftFixture];
    view.mediaItems = [];
    sellerPaymentConfig.mockImplementation(() => Promise.resolve(paidSellerPaymentConfig));

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (screen.container.querySelector('[data-surface="listing-payment-setup"]')) {
        throw new Error('Payment interstitial is still covering the composer.');
      }
    });
    await resumeAutosavedDraft(screen);
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-surface="seller-publish-blocked"]')) {
        throw new Error('The session publish guard has not rendered yet.');
      }
      const connect = [...screen.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Connect marketplace session'),
      );
      if (!connect) {
        throw new Error('The session-connect control has not rendered yet.');
      }
    });
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    const connect = [...screen.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Connect marketplace session'),
    );
    expect(connect).toBeDefined();
    await connect!.click();
    // DialogContent portals out of the VRT root — assert against document.
    await vi.waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('The grant dialog has not opened yet.');
      if (!dialog.textContent?.includes('The approval expired before it was completed. Try again.')) {
        throw new Error('The grant expiry copy has not rendered yet.');
      }
    });
    const input = screen.container.querySelector<HTMLInputElement>('#title');
    expect(input?.value).toBe(draftFixture.data.form.title);
    expect(view.commitDeleteListingDraft).not.toHaveBeenCalled();
    expect(screen.container.querySelector('#title')).not.toBeNull();
  });
});
