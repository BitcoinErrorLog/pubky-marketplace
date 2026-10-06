// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceAddressSettings } from '@/templates/Marketplace/MarketplaceAddressSettings';

const view = vi.hoisted(() => ({
  addresses: [] as unknown[],
  isLoading: false,
}));

const addressFixtures = vi.hoisted(() => {
  const owner = 'b'.repeat(52);
  return [
    {
      id: `${owner}:addr_home`,
      owner_id: owner,
      label: 'Home',
      name: 'Alice Buyer',
      line1: '1 Market Street',
      line2: 'Apartment 12',
      city: 'New York',
      region: 'NY',
      postal_code: '10001',
      country_code: 'US',
      is_default: true,
      last_used_at: 1_755_000_000_000,
      created_at: 1_754_000_000_000,
      updated_at: 1_755_000_000_000,
    },
    {
      id: `${owner}:addr_work`,
      owner_id: owner,
      label: 'Work',
      name: 'Alice Buyer',
      line1: '77 Broadway, Floor 4',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10006',
      country_code: 'US',
      is_default: false,
      last_used_at: null,
      created_at: 1_754_100_000_000,
      updated_at: 1_754_100_000_000,
    },
  ];
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/marketplace/settings/addresses',
}));

vi.mock('@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook')>();
  return {
    ...actual,
    useMarketplaceAddressBook: () => ({
      addresses: view.addresses,
      isLoading: view.isLoading,
      save: vi.fn(async () => true),
      remove: vi.fn(async () => {}),
      setDefault: vi.fn(async () => {}),
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace address settings — visual regression', () => {
  it('renders the saved address list at desktop viewport', async () => {
    view.addresses = addressFixtures;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceAddressSettings />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-settings-list-desktop');
  });

  it('renders the saved address list at mobile viewport', async () => {
    view.addresses = addressFixtures;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceAddressSettings />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-settings-list-mobile');
  });

  it('renders the empty state at desktop viewport', async () => {
    view.addresses = [];
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceAddressSettings />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-settings-empty-desktop');
  });

  it('renders the create form at desktop viewport', async () => {
    view.addresses = addressFixtures;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceAddressSettings />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: 'Add address' }).click();
    await vi.waitFor(() => {
      if (!screen.container.querySelector('#label')) throw new Error('The address form has not opened yet.');
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-settings-create-desktop');
  });
});
