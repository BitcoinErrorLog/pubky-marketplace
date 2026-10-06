import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { AddressAutocompleteProvider } from '@/libs/commerce/address-autocomplete';
import { MarketplaceAddressFields } from '@/molecules/MarketplaceAddressFields/MarketplaceAddressFields';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';

const mockProvider: AddressAutocompleteProvider = {
  suggest: async () => ({
    status: 'ok',
    suggestions: [
      {
        id: 'w214672291',
        primary: '42 Union Street',
        secondary: 'New Bedford, Massachusetts 02740',
        precision: 'street',
        address: {
          line1: '42 Union Street',
          city: 'New Bedford',
          region: 'Massachusetts',
          postalCode: '02740',
          countryCode: 'US',
        },
      },
      {
        id: 'w214671109',
        primary: '42 Union Avenue',
        secondary: 'Framingham, Massachusetts 01702',
        precision: 'house',
        address: {
          line1: '42 Union Avenue',
          city: 'Framingham',
          region: 'Massachusetts',
          postalCode: '01702',
          countryCode: 'US',
        },
      },
    ],
  }),
};

const unavailableProvider: AddressAutocompleteProvider = {
  suggest: async () => ({ status: 'unavailable' }),
};

async function waitForTestId(testId: string, timeout = 5000) {
  await vi.waitFor(
    () => {
      if (!document.querySelector(`[data-testid="${testId}"]`)) {
        throw new Error(`${testId} has not opened yet.`);
      }
    },
    { timeout },
  );
}

function AddressFieldsScene({
  provider,
  countryCode = 'US',
}: {
  provider: AddressAutocompleteProvider | null;
  countryCode?: string;
}) {
  const form = useForm({
    defaultValues: {
      line1: '',
      line2: '',
      city: '',
      region: '',
      postalCode: '',
      countryCode,
    },
  });

  return (
    <div className="min-h-[720px] max-w-xl bg-background p-6">
      <MarketplaceAddressFields control={form.control} setValue={form.setValue} autocompleteProvider={provider} />
    </div>
  );
}

describe('Marketplace address fields — visual regression', () => {
  it('renders idle US fields labelled State and ZIP', async () => {
    await renderForVRT(<AddressFieldsScene provider={null} />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-address-fields')).toMatchScreenshot('address-fields-us-idle-desktop');
  });

  it('renders the OpenStreetMap credit when suggestions are on', async () => {
    await renderForVRT(<AddressFieldsScene provider={mockProvider} />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-address-fields')).toMatchScreenshot('address-fields-us-credit-desktop');
  });

  it('renders the manual-entry notice when suggestions are unavailable', async () => {
    const screen = await renderForVRT(<AddressFieldsScene provider={unavailableProvider} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    expectVrtSurface('marketplace-address-fields');
    await userEvent.type(screen.getByLabelText('Address line 1'), '42 Union');
    await waitForTestId('marketplace-address-unavailable');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-fields-unavailable-desktop');
  });

  it('renders optional Region for GB', async () => {
    await renderForVRT(<AddressFieldsScene provider={null} countryCode="GB" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(expectVrtSurface('marketplace-address-fields')).toMatchScreenshot('address-fields-gb-region-desktop');
  });

  it('renders the open US state dropdown', async () => {
    const screen = await renderForVRT(<AddressFieldsScene provider={null} />, { viewport: VRT_VIEWPORT_DESKTOP });
    expectVrtSurface('marketplace-address-fields');
    const state = screen.getByLabelText('State');
    await userEvent.click(state);
    await userEvent.type(state, 'Mass');
    await waitForTestId('marketplace-region-options');
    // Absolute list overflows the surface box; crop the VRT root so Massachusetts stays in frame.
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-fields-state-dropdown-desktop');
  });

  it('renders US address suggestions and fills the form from a selection', async () => {
    const screen = await renderForVRT(<AddressFieldsScene provider={mockProvider} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    expectVrtSurface('marketplace-address-fields');
    await userEvent.type(screen.getByLabelText('Address line 1'), '42 Union');
    await waitForTestId('marketplace-address-suggestions');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('address-fields-suggestions-desktop');

    await userEvent.click(screen.getByRole('option', { name: /42 Union Street/ }));
    await vi.waitFor(() => {
      const city = document.querySelector('#city');
      if (!(city instanceof HTMLInputElement) || city.value !== 'New Bedford') {
        throw new Error('Selecting a suggestion did not fill the city.');
      }
    });
    expect((document.querySelector('#region') as HTMLInputElement).value).toBe('MA');
    expect((document.querySelector('#postalCode') as HTMLInputElement).value).toBe('02740');
  });
});
