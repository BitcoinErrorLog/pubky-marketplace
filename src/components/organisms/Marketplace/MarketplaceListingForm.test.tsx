import { createRef, useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { seedDraftFormFromListing } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import {
  type CreateMarketplaceListingData,
  createMarketplaceListingDefaults,
  createMarketplaceListingPublishChecklist,
  createMarketplaceListingSchema,
  isCreateMarketplaceListingPublishReady,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import { formDataFromRecord } from '@/hooks/useEditMarketplaceListing/useEditMarketplaceListing';
import type {
  ListingMediaItem,
  UseListingMediaManagerResult,
} from '@/hooks/useListingMediaManager/useListingMediaManager';
import { DIGITAL_DELIVERY_COPY } from '@/libs/commerce/digital';
import { PICKUP_NOTHING_PUBLISHED_TOAST } from '@/libs/commerce/pickup';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { setHeavySuiteBudgets } from '@/test-utils/load-budget';
import { MarketplaceListingForm } from './MarketplaceListingForm';

setHeavySuiteBudgets();

// The form reads the deployment's `pickup_available` capability through the
// controller seam (§A7). Tests default it to ON; the capability-off describe
// flips it. The editor's owner read is stubbed too so edit-mode mounts do
// not touch the network.
const pickupCapability = vi.hoisted(() => ({
  available: true,
  pending: false,
  commitSetPickupDetails: vi.fn(async () => ({ ok: true })),
}));

// The digital delivery capability (/health) and the seller's own payment
// config (the PayPal warning) ride the same controller seam.
const digitalCapability = vi.hoisted(() => ({
  available: true,
  pending: false,
  paypalAvailable: false,
  getSellerPaymentConfig: vi.fn(),
}));

// Presets are device-local (Dexie) and not under test here; the row's own
// behavior (apply fills fields and untoggles free shipping) IS — so the hook
// is mocked with one preset for that single test.
const shippingPresetsMock = vi.hoisted(() => ({
  saveFromFields: vi.fn(async () => true),
  presets: [] as Array<{
    id: string;
    owner_id: string;
    label: string;
    price_minor: number;
    currency: string;
    estimated_min_days: number;
    estimated_max_days: number;
    created_at: number;
    updated_at: number;
  }>,
}));

vi.mock('@/hooks/useMarketplaceShippingPresets/useMarketplaceShippingPresets', () => ({
  useMarketplaceShippingPresets: () => ({
    presets: shippingPresetsMock.presets,
    isLoading: false,
    saveFromFields: shippingPresetsMock.saveFromFields,
    remove: vi.fn(),
  }),
}));

vi.mock('@/controllers/commerce/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/controllers/commerce/commerce')>();
  return {
    ...actual,
    CommerceController: {
      ...actual.CommerceController,
      fetchPickupAvailable: () =>
        pickupCapability.pending ? new Promise<boolean>(() => {}) : Promise.resolve(pickupCapability.available),
      fetchSellerPickupDetails: () =>
        Promise.resolve({ listingAggregateId: 'listing:agg', current: null, lastVersion: 0 }),
      commitSetPickupDetails: pickupCapability.commitSetPickupDetails,
      hasFullHomeserverGrant: () => true,
      fetchDigitalDeliveryCapability: () =>
        digitalCapability.pending
          ? new Promise(() => {})
          : Promise.resolve({ available: digitalCapability.available, maxBytes: 52_428_800 }),
      getSellerPaymentConfig: digitalCapability.getSellerPaymentConfig,
      fetchSellerDigitalDelivery: () =>
        Promise.resolve({ listingAggregateId: 'listing:agg', current: null, lastVersion: 0, pinnedVersions: [] }),
    },
  };
});

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

beforeEach(() => {
  // The shipping-preset picker renders only when presets exist; keep the
  // shared mock empty unless a test opts in (the snapshot stays picker-free).
  shippingPresetsMock.presets = [];
  shippingPresetsMock.saveFromFields.mockReset().mockResolvedValue(true);
  pickupCapability.available = true;
  pickupCapability.pending = false;
  digitalCapability.available = true;
  digitalCapability.pending = false;
  digitalCapability.paypalAvailable = false;
  digitalCapability.getSellerPaymentConfig.mockReset();
  digitalCapability.getSellerPaymentConfig.mockImplementation(async () => ({
    bitcoinAvailable: true,
    bitcoinOfferAvailable: true,
    paypalAvailable: digitalCapability.paypalAvailable,
  }));
  useAuthStore.setState({ currentUserPubky: null });
  pickupCapability.commitSetPickupDetails.mockReset();
  pickupCapability.commitSetPickupDetails.mockResolvedValue({ ok: true });
  vi.mocked(toast).mockReset();
});

function buildMedia(items: ListingMediaItem[] = []): UseListingMediaManagerResult {
  return {
    items,
    maxPhotos: 8,
    error: null,
    inputRef: createRef<HTMLInputElement>(),
    onInputChange: vi.fn(),
    choose: vi.fn(),
    removeItem: vi.fn(),
    moveItem: vi.fn(),
    setAltText: vi.fn(),
    seed: vi.fn(),
    restore: vi.fn(),
    reset: vi.fn(),
    prepare: vi.fn(),
  };
}

function photoItem(key: string, altText = ''): ListingMediaItem {
  return {
    key,
    kind: 'new',
    file: new File(['x'], `${key}.jpg`, { type: 'image/jpeg' }),
    previewUrl: `blob:${key}`,
    altText,
  };
}

function expectIconOnlyButtonsToHaveLabels(container: HTMLElement) {
  const iconOnlyButtons = Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === '' && button.querySelector('svg') !== null,
  );
  expect(iconOnlyButtons.length).toBeGreaterThan(0);
  for (const button of iconOnlyButtons) {
    expect(button).toHaveAttribute('aria-label', expect.stringMatching(/\S/));
  }
}

function FormHarness({
  fulfillment = 'shipping',
  defaultValues = {},
  onSubmit = vi.fn(),
  onPublished,
  media = buildMedia(),
  mode = 'create' as const,
  saleTermsLocked = false,
  listingId,
  submittedFulfillment,
  publishBlocked = null,
  publishGuardReady = true,
  formRef,
}: {
  fulfillment?: CreateMarketplaceListingData['fulfillment'];
  defaultValues?: Partial<CreateMarketplaceListingData>;
  onSubmit?: (options?: { silent?: boolean }) => Promise<boolean | void>;
  submittedFulfillment?: CreateMarketplaceListingData['fulfillment'][];
  onPublished?: () => void;
  media?: UseListingMediaManagerResult;
  mode?: 'create' | 'edit';
  saleTermsLocked?: boolean;
  listingId?: string;
  publishBlocked?: import('@/libs/commerce/listing-publish-guards').ListingPublishBlockReason | null;
  publishGuardReady?: boolean;
  formRef?: { current: UseFormReturn<CreateMarketplaceListingData> | null };
}) {
  const form = useForm<CreateMarketplaceListingData>({
    defaultValues: { ...createMarketplaceListingDefaults, fulfillment, ...defaultValues },
  });
  useEffect(() => {
    if (formRef) formRef.current = form;
  }, [form, formRef]);
  return (
    <MarketplaceListingForm
      form={form}
      media={media}
      onSubmit={async (options) => {
        submittedFulfillment?.push(form.getValues('fulfillment'));
        return onSubmit(options);
      }}
      onPublished={onPublished}
      isPublishing={false}
      mode={mode}
      saleTermsLocked={saleTermsLocked}
      listingId={listingId}
      publishBlocked={publishBlocked}
      publishGuardReady={publishGuardReady}
    />
  );
}

describe('MarketplaceListingForm', () => {
  it('renders the complete physical listing contract', () => {
    render(<FormHarness />);

    expect(screen.getByRole('heading', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Item' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Price & format' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delivery & returns' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review & publish' })).toBeInTheDocument();
    expect(screen.getByText('Pricing currency')).toBeInTheDocument();
    expect(screen.getByText('Flat shipping (USD)')).toBeInTheDocument();
    expect(screen.getByText('Weight (g)')).toBeInTheDocument();
    expect(screen.getByText('Length (cm)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('You can add these later')).toBeInTheDocument();
  });

  it('hides package fields for pickup listings', () => {
    render(<FormHarness fulfillment="pickup" />);

    expect(screen.queryByText('Flat shipping (USD)')).not.toBeInTheDocument();
    expect(screen.queryByText('Weight (g)')).not.toBeInTheDocument();
  });

  it('keeps the section rail sticky', () => {
    render(<FormHarness />);

    expect(screen.getByRole('navigation', { name: 'Listing sections' }).closest('aside')).toHaveClass('sticky');
  });

  it('pins the section rail and section jumps below the main header', () => {
    render(<FormHarness />);

    for (const name of ['Listing sections']) {
      const rail = screen.getByRole('navigation', { name }).closest('aside');
      expect(rail).toHaveClass('top-(--header-offset-main)');
      expect(rail).not.toHaveClass('top-24');
    }
    expect(document.getElementById('listing-section-photos')).toHaveClass('lg:scroll-mt-(--header-offset-main)');
  });

  it('pins the mobile step bar, and mobile section jumps, below the mobile header', () => {
    render(<FormHarness />);

    const stepper = screen.getByTestId('listing-mobile-stepper');
    expect(stepper).toHaveClass('sticky', 'top-(--header-offset-mobile)');
    expect(stepper).not.toHaveClass('top-2');
    expect(document.getElementById('listing-section-photos')).toHaveClass(
      'scroll-mt-[calc(var(--header-offset-mobile)+8.5rem)]',
    );
  });
});

function deliveryBox(name: 'Ship' | 'Local pickup' | 'Digital delivery') {
  return screen.getByRole('checkbox', { name });
}

async function waitForPickupEnabled() {
  await waitFor(() => {
    expect(deliveryBox('Local pickup')).toBeEnabled();
  });
}

describe('MarketplaceListingForm pickup capability (§A7)', () => {
  beforeEach(() => {
    pickupCapability.available = true;
  });

  it('offers Ship, Local pickup and Digital delivery when the deployment has both', async () => {
    render(<FormHarness />);

    await waitForPickupEnabled();
    expect(deliveryBox('Ship')).toBeChecked();
    expect(deliveryBox('Local pickup')).not.toBeChecked();
    expect(deliveryBox('Digital delivery')).not.toBeChecked();
    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).toBeEnabled();
    });
  });

  it('shows a skeleton and keeps pickup off while pickup capability is unknown', () => {
    pickupCapability.pending = true;
    render(<FormHarness />);

    expect(screen.getByTestId('pickup-capability-skeleton')).toHaveAttribute(
      'aria-label',
      'Checking pickup availability',
    );
    expect(deliveryBox('Local pickup')).toBeDisabled();
  });

  it('keeps a restored pickup value while pickup capability is still unknown', () => {
    pickupCapability.pending = true;
    render(<FormHarness fulfillment="pickup" />);

    expect(deliveryBox('Local pickup')).toBeChecked();
    expect(deliveryBox('Ship')).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('pickup-capability-skeleton')).toBeInTheDocument();
  });

  it('offers shipping only, coerces a pickup value, and says why when the deployment has no pickup', async () => {
    pickupCapability.available = false;
    render(<FormHarness fulfillment="pickup" />);

    expect(await screen.findByText('Local pickup is not available on this deployment.')).toBeInTheDocument();
    // …and the stale pickup value is coerced to shipping the way the auction
    // path does, so the shipping/package fields come back.
    await waitFor(() => {
      expect(screen.getByText('Weight (g)')).toBeInTheDocument();
    });
    expect(deliveryBox('Ship')).toBeChecked();
    expect(deliveryBox('Local pickup')).not.toBeChecked();
    expect(deliveryBox('Local pickup')).toBeDisabled();
  });

  it('does not mount the pickup-details editor in create mode — it points at the edit page', async () => {
    render(<FormHarness fulfillment="shipping_and_pickup" listingId="boots_01" />);

    expect(
      await screen.findByText("Publish first, then add your meeting point from the listing's edit page."),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-surface="pickup-details-editor"]')).toBeNull();
  });

  it('mounts the pickup-details editor in edit mode when the listing offers pickup', async () => {
    render(<FormHarness fulfillment="shipping_and_pickup" mode="edit" listingId="boots_01" />);

    await waitFor(() => {
      expect(document.querySelector('[data-surface="pickup-details-editor"]')).not.toBeNull();
    });
    expect(screen.queryByText(/Publish first, then add your meeting point/)).not.toBeInTheDocument();
  });

  it('refuses to save a pickup listing that still has no meeting point', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    const onPublished = vi.fn();
    render(
      <FormHarness
        fulfillment="pickup"
        mode="edit"
        listingId="boots_01"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
        onPublished={onPublished}
      />,
    );

    expect(await screen.findByLabelText('Pickup details version 0')).toHaveTextContent('No details saved · counter v0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description:
        'Add a meeting point before saving a pickup listing. Buyers can otherwise place an order with nowhere to meet.',
    });
  });

  it('saves the listing then the dirty pickup details before publishing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    const onPublished = vi.fn();
    render(
      <FormHarness
        fulfillment="pickup"
        mode="edit"
        listingId="boots_01"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
        onPublished={onPublished}
      />,
    );

    await user.type(await screen.findByLabelText('Meeting point'), 'Harbor Market, stall 12');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(pickupCapability.commitSetPickupDetails).toHaveBeenCalledWith(
        'boots_01',
        expect.objectContaining({
          expectedVersion: 0,
          details: expect.objectContaining({ kind: 'spot', spot: 'Harbor Market, stall 12' }),
        }),
      );
    });
    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledOnce();
    });
  });

  it('reverts fulfillment when pickup set fails after listing persist', async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn(async () => true);
    const onPublished = vi.fn();
    const submittedFulfillment: CreateMarketplaceListingData['fulfillment'][] = [];
    pickupCapability.commitSetPickupDetails.mockRejectedValueOnce(new Error('injected set failure'));
    render(
      <FormHarness
        fulfillment="shipping"
        mode="edit"
        listingId="boots_01"
        submittedFulfillment={submittedFulfillment}
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
          shippingPrice: '12.00',
          packageWeight: '1200',
          packageLength: '35.0',
          packageWidth: '25.0',
          packageHeight: '15.0',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
        onPublished={onPublished}
      />,
    );

    await waitForPickupEnabled();
    await user.click(deliveryBox('Local pickup'));
    await user.click(deliveryBox('Ship'));
    await user.type(await screen.findByLabelText('Meeting point'), 'Harbor Market, stall 12');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
    expect(submittedFulfillment).toEqual(['pickup', 'shipping']);
    expect(onPublished).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: PICKUP_NOTHING_PUBLISHED_TOAST,
    });
  });

  it('saves a shipping-only edit without writing pickup details', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    const onPublished = vi.fn();
    render(
      <FormHarness
        fulfillment="shipping"
        mode="edit"
        listingId="boots_01"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
          shippingPrice: '12.00',
          packageWeight: '1200',
          packageLength: '35.0',
          packageWidth: '25.0',
          packageHeight: '15.0',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
        onPublished={onPublished}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    expect(pickupCapability.commitSetPickupDetails).not.toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalledOnce();
  });

  it('opens the photo picker and submits through the form owner', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const media = buildMedia([photoItem('one', 'Front')]);
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        onSubmit={onSubmit}
        media={media}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add photos (1/8)' }));
    await user.click(screen.getByRole('button', { name: 'Publish listing' }));

    expect(media.choose).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('focuses sections from anchor navigation', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<FormHarness />);

    await user.click(screen.getAllByRole('link', { name: /Price & format/ })[0]);

    expect(document.activeElement).toHaveAttribute('id', 'listing-section-price');
  });

  it('advances the mobile step indicator without unmounting sections', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<FormHarness />);

    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review & publish' })).toBeInTheDocument();
  });

  it('drops filled title, description, price, and category from the publish checklist', async () => {
    const user = userEvent.setup({ delay: null });
    render(<FormHarness />);

    const requiredItems = () => {
      const heading = screen.getByText('Required to publish');
      return Array.from(heading.parentElement?.querySelectorAll('ul li') ?? []).map((item) => item.textContent);
    };
    expect(requiredItems()).toEqual(expect.arrayContaining(['Title', 'Description', 'Category', 'Price']));
    const remainingBefore = requiredItems().length;

    await user.type(screen.getByLabelText('Title'), 'Vintage leather boots');
    await user.type(screen.getByLabelText('Description'), 'Well cared for boots with light wear.');
    await user.type(screen.getByLabelText('Price (USD)'), '125.00');
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Fashion' }));

    expect(requiredItems()).not.toEqual(expect.arrayContaining(['Title']));
    expect(requiredItems()).not.toEqual(expect.arrayContaining(['Description']));
    expect(requiredItems()).not.toEqual(expect.arrayContaining(['Category']));
    expect(requiredItems()).not.toEqual(expect.arrayContaining(['Price']));
    expect(requiredItems().length).toBeLessThan(remainingBefore);
  });

  it('keeps publish disabled when description is empty even if other minimums are filled', () => {
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{ title: 'Vintage boots', categoryId: 'fashion', price: '125.00', description: '' }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('Required to publish').parentElement).toHaveTextContent('Description');
  });

  it('allows publishing without optional photo descriptions', () => {
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one')])}
      />,
    );

    expect(document.getElementById('listing-section-photos')).toHaveAttribute('data-section-complete', 'true');
    expect(document.getElementById('listing-section-review')).toHaveAttribute('data-section-complete', 'true');
    expect(screen.queryByText('Photo descriptions')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
  });

  it('keeps physical listings unpublished until shipping fields are filled or pickup is chosen', () => {
    const first = render(
      <FormHarness
        fulfillment="shipping"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('Shipping details')).toBeInTheDocument();
    first.unmount();

    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
  });

  it('defaults returns to final sale while remaining editable', () => {
    render(<FormHarness />);

    expect(screen.getByLabelText('Returns')).toHaveTextContent('Final sale');
  });

  it('renders photos in order with cover badge, reorder, and remove controls', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one', 'Front'), photoItem('two', 'Back'), photoItem('three', 'Sole')]);
    render(<FormHarness media={media} />);

    expect(screen.getByText('Cover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add photos (3/8)' })).toBeInTheDocument();
    // The cover cannot move earlier and the last photo cannot move later.
    expect(screen.getByRole('button', { name: 'Move photo 1 earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move photo 3 later' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(media.moveItem).toHaveBeenCalledWith('two', -1);

    await user.click(screen.getByRole('button', { name: 'Move photo 1 later' }));
    expect(media.moveItem).toHaveBeenCalledWith('one', 1);

    await user.click(screen.getByRole('button', { name: 'Remove photo 3' }));
    expect(media.removeItem).toHaveBeenCalledWith('three');
  });

  it('edits per-photo descriptions through the media manager', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one')]);
    render(<FormHarness media={media} />);

    await user.type(screen.getByLabelText('Photo description'), 'F');
    expect(media.setAltText).toHaveBeenCalledWith('one', 'F');
  });

  it('disables adding photos once the studio limit is reached', () => {
    const media = buildMedia(
      Array.from({ length: 8 }, (_, index) => photoItem(`photo-${index + 1}`, `Photo ${index + 1}`)),
    );
    render(<FormHarness media={media} />);

    expect(screen.getByRole('button', { name: 'Add photos (8/8)' })).toBeDisabled();
  });

  it('locks the sale format and relabels submit in edit mode', () => {
    render(<FormHarness mode="edit" />);

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByText('The sale format cannot change after publishing.')).toBeInTheDocument();
  });

  it('locks the price for published auctions', () => {
    render(<FormHarness mode="edit" saleTermsLocked />);

    expect(screen.getByLabelText('Price (USD)')).toBeDisabled();
    expect(
      screen.getByText('Auction terms (format, starting price, and schedule) are fixed once the auction is published.'),
    ).toBeInTheDocument();
  });

  it('adds and removes inventory variants', async () => {
    const user = userEvent.setup();
    render(<FormHarness fulfillment="pickup" />);

    await user.click(screen.getByRole('button', { name: 'Add variant' }));
    expect(screen.getAllByText('Seller SKU')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove variant 2' }));
    expect(screen.getAllByText('Seller SKU')).toHaveLength(1);
  });

  it('labels every icon-only control in listing forms', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one', 'Front'), photoItem('two', 'Back')]);
    const { container } = render(<FormHarness media={media} />);

    await user.click(screen.getByRole('button', { name: 'Add variant' }));

    expectIconOnlyButtonsToHaveLabels(container);
  });
});

describe('MarketplaceListingForm scoped status watch', () => {
  function StatusWatchHarness({
    defaultValues,
    media = buildMedia([photoItem('one', 'Front')]),
  }: {
    defaultValues?: Partial<CreateMarketplaceListingData>;
    media?: UseListingMediaManagerResult;
  }) {
    const form = useForm<CreateMarketplaceListingData>({
      defaultValues: {
        ...createMarketplaceListingDefaults,
        fulfillment: 'pickup',
        title: 'Vintage boots',
        description: 'Well cared for boots.',
        categoryId: 'fashion-shoes-boots',
        price: '125.00',
        ...defaultValues,
      },
    });
    return (
      <>
        <button type="button" onClick={() => form.setValue('title', 'ab')}>
          shorten-title
        </button>
        <button type="button" onClick={() => form.setValue('description', '')}>
          clear-description
        </button>
        <button type="button" onClick={() => form.setValue('categoryId', '')}>
          clear-category
        </button>
        <button type="button" onClick={() => form.setValue('price', '')}>
          clear-price
        </button>
        <button
          type="button"
          onClick={() =>
            form.setValue('variants', [
              { sku: '', size: '', color: '', style: '', quantity: '0', unlimited: false, priceOverride: '' },
            ])
          }
        >
          invalidate-variants
        </button>
        <button type="button" onClick={() => form.setValue('fulfillment', 'shipping')}>
          set-physical
        </button>
        <button type="button" onClick={() => form.setValue('shippingLabel', 'Ground')}>
          set-shipping-label
        </button>
        <button type="button" onClick={() => form.setValue('shippingPrice', '12.00')}>
          set-shipping-price
        </button>
        <button type="button" onClick={() => form.setValue('shippingMinDays', '3')}>
          set-shipping-min
        </button>
        <button type="button" onClick={() => form.setValue('shippingMaxDays', '7')}>
          set-shipping-max
        </button>
        <button type="button" onClick={() => form.setValue('packageWeight', '1200')}>
          set-weight
        </button>
        <button type="button" onClick={() => form.setValue('packageLength', '35.0')}>
          set-length
        </button>
        <button type="button" onClick={() => form.setValue('packageWidth', '25.0')}>
          set-width
        </button>
        <button type="button" onClick={() => form.setValue('packageHeight', '15.0')}>
          set-height
        </button>
        <button type="button" onClick={() => form.setValue('returnDays', '30')}>
          set-returns
        </button>
        <MarketplaceListingForm form={form} media={media} onSubmit={async () => {}} isPublishing={false} />
      </>
    );
  }

  const sectionComplete = (sectionId: string) =>
    document.getElementById(`listing-section-${sectionId}`)?.getAttribute('data-section-complete');

  it('starts with every watched section complete', () => {
    render(<StatusWatchHarness />);

    expect(sectionComplete('item')).toBe('true');
    expect(sectionComplete('price')).toBe('true');
    expect(sectionComplete('shipping')).toBe('true');
    expect(sectionComplete('review')).toBe('true');
  });

  it.each([
    ['title', 'shorten-title', 'item'],
    ['description', 'clear-description', 'item'],
    ['category', 'clear-category', 'item'],
    ['price', 'clear-price', 'price'],
    ['variants', 'invalidate-variants', 'price'],
  ] as const)('marks the %s watched field incomplete via %s', async (_field, button, sectionId) => {
    const user = userEvent.setup({ delay: null });
    render(<StatusWatchHarness />);

    await user.click(screen.getByRole('button', { name: button }));

    expect(sectionComplete(sectionId)).toBe('false');
  });

  it('completes the shipping section once every shipping field is set', async () => {
    const user = userEvent.setup({ delay: null });
    render(<StatusWatchHarness />);

    await user.click(screen.getByRole('button', { name: 'set-physical' }));
    expect(sectionComplete('shipping')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'set-shipping-label' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-price' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-min' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-max' }));
    await user.click(screen.getByRole('button', { name: 'set-weight' }));
    await user.click(screen.getByRole('button', { name: 'set-length' }));
    await user.click(screen.getByRole('button', { name: 'set-width' }));
    await user.click(screen.getByRole('button', { name: 'set-height' }));

    expect(sectionComplete('shipping')).toBe('true');
  });

  it('hides the returns policy prompt once return days are set', async () => {
    const user = userEvent.setup({ delay: null });
    render(<StatusWatchHarness />);

    expect(screen.getByText('Returns policy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'set-returns' }));

    expect(screen.queryByText('Returns policy')).not.toBeInTheDocument();
  });
});

describe('MarketplaceListingForm free shipping', () => {
  it('disables the flat price while free shipping is on and keeps it for toggling back', async () => {
    const user = userEvent.setup();
    render(<FormHarness defaultValues={{ shippingPrice: '12.00' }} />);

    const price = screen.getByLabelText(/Flat shipping/);
    expect(price).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Free shipping' }));
    expect(price).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Free shipping' }));
    expect(price).toBeEnabled();
    expect(price).toHaveValue('12.00');
  });

  it('treats a free-shipping listing as shipping-section complete without a price', () => {
    render(
      <FormHarness
        defaultValues={{
          freeShipping: true,
          shippingPrice: '',
          packageWeight: '1200',
          packageLength: '35.0',
          packageWidth: '25.0',
          packageHeight: '15.0',
        }}
      />,
    );

    expect(
      document.querySelector('[data-surface="listing-section-shipping"]')?.getAttribute('data-section-complete'),
    ).toBe('true');
  });

  it('untoggles free shipping and fills the price when a preset is applied', async () => {
    shippingPresetsMock.presets = [
      {
        id: 'preset_1',
        owner_id: 'y'.repeat(52),
        label: 'Standard shipping',
        price_minor: 1200,
        currency: 'USD',
        estimated_min_days: 3,
        estimated_max_days: 7,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const user = userEvent.setup();
    render(<FormHarness defaultValues={{ freeShipping: true, shippingPrice: '' }} />);

    const price = screen.getByLabelText(/Flat shipping/);
    expect(price).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: /shipping preset/i }));
    await user.click(await screen.findByRole('option', { name: /Standard shipping/ }));

    await waitFor(() => expect(price).toBeEnabled());
    expect(price).toHaveValue('12.00');
    expect(screen.getByRole('checkbox', { name: 'Free shipping' })).not.toBeChecked();
  });

  it.each([
    { checked: true, saved: true, expected: 1 },
    { checked: false, saved: true, expected: 0 },
    { checked: true, saved: false, expected: 0 },
  ])(
    'saves only requested presets after successful listing save ($checked, $saved)',
    async ({ checked, saved, expected }) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(async () => saved);
      render(
        <FormHarness
          onSubmit={onSubmit}
          media={buildMedia([photoItem('one')])}
          defaultValues={{
            title: 'Vintage boots',
            description: 'Well cared for boots.',
            categoryId: 'fashion',
            price: '125.00',
            currency: 'USD',
            shippingLabel: 'Tracked',
            shippingPrice: '12.00',
            shippingMinDays: '3',
            shippingMaxDays: '7',
            packageWeight: '1200',
            packageLength: '35',
            packageWidth: '25',
            packageHeight: '15',
          }}
        />,
      );
      const checkbox = screen.getByRole('checkbox', { name: 'Save delivery details as preset' });
      expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();
      if (checked) await user.click(checkbox);
      expect(shippingPresetsMock.saveFromFields).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Publish listing' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(shippingPresetsMock.saveFromFields).toHaveBeenCalledTimes(expected);
      if (expected)
        expect(shippingPresetsMock.saveFromFields).toHaveBeenCalledWith(null, {
          shippingLabel: 'Tracked',
          shippingPrice: '12.00',
          shippingMinDays: '3',
          shippingMaxDays: '7',
        });
    },
  );

  it.each([{ freeShipping: true }, { currency: 'BTC' as const }])(
    'does not offer incompatible shipping presets (%j)',
    (values) => {
      render(<FormHarness defaultValues={values} />);
      expect(screen.getByRole('checkbox', { name: 'Save delivery details as preset' })).toBeDisabled();
    },
  );
});

describe('MarketplaceListingForm publish gate vs schema', () => {
  const pickupReady = {
    title: 'Vintage boots',
    description: 'Well cared for boots.',
    categoryId: 'fashion',
    price: '125.00',
  };

  it.each([
    {
      label: 'pickup schema-valid with photo',
      fulfillment: 'pickup' as const,
      values: pickupReady,
      photos: 1,
      enabled: true,
    },
    {
      label: 'empty description',
      fulfillment: 'pickup' as const,
      values: { ...pickupReady, description: '' },
      photos: 1,
      enabled: false,
    },
    {
      label: 'physical without shipping',
      fulfillment: 'shipping' as const,
      values: pickupReady,
      photos: 1,
      enabled: false,
    },
    {
      label: 'physical with shipping fields',
      fulfillment: 'shipping' as const,
      values: {
        ...pickupReady,
        shippingPrice: '12.00',
        packageWeight: '1200',
        packageLength: '35.0',
        packageWidth: '25.0',
        packageHeight: '15.0',
      },
      photos: 1,
      enabled: true,
    },
    {
      label: 'schema-valid without photo',
      fulfillment: 'pickup' as const,
      values: pickupReady,
      photos: 0,
      enabled: false,
    },
  ])('Publish enabled iff schema-valid plus photos ($label)', ({ fulfillment, values, photos, enabled }) => {
    render(
      <FormHarness
        fulfillment={fulfillment}
        defaultValues={values}
        media={photos > 0 ? buildMedia([photoItem('one', 'Front')]) : buildMedia()}
      />,
    );

    const formValues = { ...createMarketplaceListingDefaults, fulfillment, ...values };
    const schemaValid = createMarketplaceListingSchema.safeParse(formValues).success;
    expect(isCreateMarketplaceListingPublishReady(formValues, photos)).toBe(schemaValid && photos > 0);
    expect(isCreateMarketplaceListingPublishReady(formValues, photos)).toBe(enabled);
    if (enabled) {
      expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
    } else {
      expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    }
  });
});

describe('MarketplaceListingForm durable publish guards at the button', () => {
  const pickupReady = {
    title: 'Vintage boots',
    description: 'Well cared for boots.',
    categoryId: 'fashion',
    price: '125.00',
  };

  it.each([
    ['no-method', 'Payment method', 'Configure a payment method before publishing'],
    ['session', 'Selling approval', 'Enable selling to publish'],
    ['unsigned', 'Sign in', 'Sign in before publishing'],
    [
      'unverified',
      'Payment settings',
      'We could not verify your payment settings. Reconnect your session and try again.',
    ],
  ] as const)('disables Publish and lists %s on Review', (reason, checklist, title) => {
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={pickupReady}
        media={buildMedia([photoItem('one', 'Front')])}
        publishBlocked={reason}
      />,
    );

    const publish = screen.getByRole('button', { name: 'Publish listing' });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('aria-describedby', 'listing-publish-guard');
    expect(screen.getByText(checklist)).toBeInTheDocument();
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    expect(document.getElementById('listing-section-review')).toHaveAttribute('data-section-complete', 'false');
    expect(screen.getByRole('alert')).toHaveAttribute('data-surface', 'listing-publish-guard');
  });

  it('keeps Publish disabled while guards are still checking', () => {
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={pickupReady}
        media={buildMedia([photoItem('one', 'Front')])}
        publishGuardReady={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('Checking payment settings…')).toBeInTheDocument();
  });
});

describe('MarketplaceListingForm - Snapshots', () => {
  it('matches the physical listing form snapshot', async () => {
    const { container } = render(<FormHarness />);
    await screen.findByRole('checkbox', { name: 'Ship' });
    // The delivery options are on the first paint while pickupAvailable is
    // still null, so they exist under the pickup-capability skeleton. The
    // committed snapshot is the settled form (both capabilities on, no
    // skeleton). Wait for that world.
    await waitFor(() => {
      expect(screen.queryByTestId('pickup-capability-skeleton')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Digital delivery' })).toBeEnabled();
    });
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('MarketplaceListingForm digital delivery (digital delivery design §2)', () => {
  const editReady = {
    title: 'Field guide',
    description: 'A printable field guide.',
    categoryId: 'fashion',
    price: '12.00',
    shippingPrice: '4.00',
    packageWeight: '300',
    packageLength: '30.0',
    packageWidth: '20.0',
    packageHeight: '2.0',
  };

  it('adds Digital delivery beside shipping and keeps the shipping fields', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    const submittedFulfillment: CreateMarketplaceListingData['fulfillment'][] = [];
    render(
      <FormHarness
        mode="edit"
        listingId="guide_01"
        defaultValues={editReady}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
        submittedFulfillment={submittedFulfillment}
      />,
    );

    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).toBeEnabled();
    });
    await user.click(deliveryBox('Digital delivery'));
    expect(screen.getByText('Weight (g)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    expect(submittedFulfillment).toEqual(['shipping_and_digital']);
  });

  it('skips the shipping and package fields for a digital-only listing', () => {
    render(<FormHarness fulfillment="digital" />);

    expect(deliveryBox('Digital delivery')).toBeChecked();
    expect(deliveryBox('Ship')).not.toBeChecked();
    expect(screen.queryByText('Flat shipping (USD)')).not.toBeInTheDocument();
    expect(screen.queryByText('Weight (g)')).not.toBeInTheDocument();
  });

  it('never lets the only checked option be cleared', async () => {
    const user = userEvent.setup();
    render(<FormHarness />);

    expect(deliveryBox('Ship')).toBeDisabled();
    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).toBeEnabled();
    });
    await user.click(deliveryBox('Digital delivery'));
    expect(deliveryBox('Ship')).toBeEnabled();
    await user.click(deliveryBox('Ship'));

    expect(deliveryBox('Ship')).not.toBeChecked();
    expect(deliveryBox('Digital delivery')).toBeChecked();
    expect(deliveryBox('Digital delivery')).toBeDisabled();
  });

  it('ships auctions only', async () => {
    render(<FormHarness fulfillment="shipping_and_digital" defaultValues={{ saleFormat: 'auction' }} />);

    expect(await screen.findByText(DIGITAL_DELIVERY_COPY.auctionsShipOnly)).toBeInTheDocument();
    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).not.toBeChecked();
    });
    expect(deliveryBox('Digital delivery')).toBeDisabled();
    expect(deliveryBox('Local pickup')).toBeDisabled();
    expect(deliveryBox('Ship')).toBeChecked();
  });

  it('drops digital from a new listing and says why when the deployment cannot deliver', async () => {
    digitalCapability.available = false;
    render(<FormHarness fulfillment="shipping_and_digital" />);

    expect(await screen.findByText(DIGITAL_DELIVERY_COPY.unavailable)).toBeInTheDocument();
    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).not.toBeChecked();
    });
    expect(deliveryBox('Digital delivery')).toBeDisabled();
    expect(deliveryBox('Ship')).toBeChecked();
  });

  it('keeps a published digital choice on an edit when the deployment turns it off', async () => {
    digitalCapability.available = false;
    render(<FormHarness fulfillment="shipping_and_digital" mode="edit" listingId="guide_01" />);

    expect(await screen.findByText(DIGITAL_DELIVERY_COPY.unavailable)).toBeInTheDocument();
    expect(deliveryBox('Digital delivery')).toBeChecked();
    expect(deliveryBox('Digital delivery')).toBeEnabled();
    expect(document.querySelector('[data-surface="digital-delivery-editor"]')).toBeNull();
  });

  it('mounts the digital delivery panel on the edit page of a digital listing', async () => {
    render(<FormHarness fulfillment="shipping_and_digital" mode="edit" listingId="guide_01" />);

    await waitFor(() => {
      expect(document.querySelector('[data-surface="digital-delivery-editor"]')).not.toBeNull();
    });
    expect(await screen.findByText(/^Not set yet/)).toBeInTheDocument();
  });

  it('does not mount the panel for a new listing or a listing without digital delivery', () => {
    const { unmount } = render(<FormHarness fulfillment="digital" />);
    expect(document.querySelector('[data-surface="digital-delivery-editor"]')).toBeNull();
    unmount();

    render(<FormHarness fulfillment="shipping" mode="edit" listingId="guide_01" />);
    expect(document.querySelector('[data-surface="digital-delivery-editor"]')).toBeNull();
  });

  it('asks to save the listing first when digital delivery is newly checked, then opens once saved', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    render(
      <FormHarness
        mode="edit"
        listingId="guide_01"
        defaultValues={editReady}
        media={buildMedia([photoItem('one', 'Front')])}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).toBeEnabled();
    });
    await user.click(deliveryBox('Digital delivery'));
    expect(
      screen.getByText('Save the listing with Digital delivery first, then set how buyers receive it.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/^Not set yet/)).toBeInTheDocument();
  });

  it('points a new digital listing at the edit page for delivery setup', () => {
    render(<FormHarness fulfillment="digital" />);

    expect(
      screen.getByText("Publish first, then set how buyers receive it from the listing's edit page."),
    ).toBeInTheDocument();
  });

  it('warns about PayPal reversals on a digital listing when the shop accepts PayPal', async () => {
    useAuthStore.setState({ currentUserPubky: 'seller_pubky' });
    digitalCapability.paypalAvailable = true;
    const { unmount } = render(<FormHarness fulfillment="shipping_and_digital" />);

    expect(await screen.findByTestId('listing-digital-paypal-warning')).toHaveTextContent(
      DIGITAL_DELIVERY_COPY.paypalWarning,
    );
    unmount();

    render(<FormHarness fulfillment="shipping" />);
    await waitFor(() => {
      expect(deliveryBox('Digital delivery')).toBeEnabled();
    });
    expect(screen.queryByTestId('listing-digital-paypal-warning')).not.toBeInTheDocument();
  });

  it('shows no PayPal warning when the shop does not accept PayPal', async () => {
    useAuthStore.setState({ currentUserPubky: 'seller_pubky' });
    render(<FormHarness fulfillment="digital" />);

    await waitFor(() => {
      expect(digitalCapability.getSellerPaymentConfig).toHaveBeenCalledWith('seller_pubky');
    });
    await act(async () => {
      await digitalCapability.getSellerPaymentConfig.mock.results[0]?.value;
    });
    expect(screen.queryByTestId('listing-digital-paypal-warning')).not.toBeInTheDocument();
  });

  it('offers Unlimited only while the listing is digital-only and shows Unlimited in place of the quantity', async () => {
    const user = userEvent.setup();
    const shipping = render(<FormHarness fulfillment="shipping" />);
    expect(screen.queryByRole('checkbox', { name: 'Unlimited' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1');
    shipping.unmount();

    const mixed = render(<FormHarness fulfillment="shipping_and_digital" />);
    expect(screen.queryByRole('checkbox', { name: 'Unlimited' })).not.toBeInTheDocument();
    mixed.unmount();

    render(<FormHarness fulfillment="digital" />);
    expect(screen.getByRole('checkbox', { name: 'Unlimited' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Unlimited' }));
    expect(screen.getByRole('checkbox', { name: 'Unlimited' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('Unlimited');
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toBeDisabled();
  });

  it('drops Unlimited when the listing is no longer digital-only', async () => {
    const user = userEvent.setup();
    render(<FormHarness fulfillment="digital" />);
    await user.click(screen.getByRole('checkbox', { name: 'Unlimited' }));
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('Unlimited');

    await user.click(deliveryBox('Ship'));
    expect(screen.queryByRole('checkbox', { name: 'Unlimited' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toBeEnabled();

    await user.click(deliveryBox('Ship'));
    expect(screen.getByRole('checkbox', { name: 'Unlimited' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('');
  });
});

// Polish review P1: an unlimited variant hydrated from a published listing
// must not carry the quantity cap into a listing that ships or offers pickup.
describe('MarketplaceListingForm unlimited stock leaving digital-only', () => {
  const unlimitedRecord = () =>
    createCommerceListingFixture({
      fulfillmentMethods: ['digital'],
      package: undefined,
      shippingOptions: [],
      variants: [
        {
          id: 'variant_01',
          options: { size: 'pdf' },
          quantity: COMMERCE_LISTING_MAX_QUANTITY,
          mediaIds: ['image_01'],
          enabled: true,
        },
      ],
    });
  const hydrate = {
    edit: () => formDataFromRecord(unlimitedRecord(), 'USD', 'metric', null),
    duplicate: () => seedDraftFormFromListing(unlimitedRecord(), 'metric'),
  } as const;
  const inventoryBlocked = (values: CreateMarketplaceListingData) =>
    createMarketplaceListingPublishChecklist(values, 1).includes('Inventory');

  it.each([
    ['edit', 'Ship', 'shipping_and_digital'],
    ['edit', 'Local pickup', 'pickup_and_digital'],
    ['duplicate', 'Ship', 'shipping_and_digital'],
    ['duplicate', 'Local pickup', 'pickup_and_digital'],
  ] as const)('needs a real count on the %s journey once %s is added', async (journey, method, fulfillment) => {
    const user = userEvent.setup();
    const formRef: { current: UseFormReturn<CreateMarketplaceListingData> | null } = { current: null };
    render(
      <FormHarness
        mode={journey === 'edit' ? 'edit' : 'create'}
        listingId={journey === 'edit' ? 'guide_01' : undefined}
        defaultValues={hydrate[journey]()}
        formRef={formRef}
      />,
    );
    const form = () => formRef.current as UseFormReturn<CreateMarketplaceListingData>;
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('Unlimited');
    expect(inventoryBlocked(form().getValues())).toBe(false);

    if (method === 'Local pickup') await waitForPickupEnabled();
    await user.click(deliveryBox(method));

    expect(form().getValues('fulfillment')).toBe(fulfillment);
    expect(form().getValues('variants.0')).toMatchObject({ unlimited: false, quantity: '' });
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('');
    expect(inventoryBlocked(form().getValues())).toBe(true);
    expect(createMarketplaceListingSchema.safeParse(form().getValues()).success).toBe(false);

    await user.type(screen.getByRole('textbox', { name: 'Quantity' }), '3');
    expect(form().getValues('variants.0.quantity')).toBe('3');
    expect(inventoryBlocked(form().getValues())).toBe(false);
  });
});
