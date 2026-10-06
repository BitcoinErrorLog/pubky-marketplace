import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { marketplaceShopSettingsDefaults } from '@/hooks/useMarketplaceShopSettings/useMarketplaceShopSettings.types';
import { MarketplaceMyShop } from './MarketplaceMyShop';

const imageSlot = vi.hoisted(() => (previewUrl: string | null) => ({
  previewUrl,
  hasImage: previewUrl !== null,
  error: null,
  inputRef: { current: null },
  choose: vi.fn(),
  onInputChange: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: 'y'.repeat(52) }),
    {
      getState: () => ({
        currentUserPubky: 'y'.repeat(52),
        selectCurrentUserPubky: () => 'y'.repeat(52),
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceShopSettings/useMarketplaceShopSettings', () => ({
  useMarketplaceShopSettings: () => {
    const form = useForm({
      defaultValues: {
        ...marketplaceShopSettingsDefaults,
        vacationMode: true,
      },
    });
    return {
      form,
      revision: 0,
      isLoading: false,
      isSaving: false,
      hasShop: false,
      avatar: imageSlot(null),
      banner: imageSlot(null),
      submit: vi.fn(async () => false),
    };
  },
}));

describe('MarketplaceMyShop', () => {
  it('updates the public shop preview as the seller edits the form', async () => {
    const user = userEvent.setup();
    render(<MarketplaceMyShop />);

    const preview = screen.getByTestId('shop-live-preview');
    expect(preview).toHaveTextContent('Your shop name');
    expect(preview).toHaveTextContent('Vacation mode');

    await user.type(screen.getByLabelText('Shop name'), 'Satoshi Vintage');
    await user.type(screen.getByLabelText('Shop bio'), 'Circular fashion and Bitcoin.');
    await user.clear(screen.getByLabelText('Region'));
    await user.type(screen.getByLabelText('Region'), 'NY');

    await waitFor(() => expect(preview).toHaveTextContent('Satoshi Vintage'));
    expect(preview).toHaveTextContent('Circular fashion and Bitcoin.');
    expect(preview).toHaveTextContent('NY, US');
  });
});
