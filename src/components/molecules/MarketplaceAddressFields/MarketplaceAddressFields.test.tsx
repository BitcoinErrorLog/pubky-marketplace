import { zodResolver } from '@hookform/resolvers/zod';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, useWatch } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import {
  type MarketplaceAddressFormData,
  marketplaceAddressFormDefaults,
  marketplaceAddressFormSchema,
} from '@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook.types';
import type {
  AddressAutocompleteProvider,
  AddressSuggestion,
  AddressSuggestResult,
} from '@/libs/commerce/address-autocomplete';
import { MarketplaceAddressFields } from './MarketplaceAddressFields';

const suggestion: AddressSuggestion = {
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
};

function providerReturning(result: AddressSuggestResult) {
  return { suggest: vi.fn(async () => result) } satisfies AddressAutocompleteProvider;
}

function Harness({ provider }: { provider?: AddressAutocompleteProvider | null }) {
  const form = useForm<MarketplaceAddressFormData>({
    resolver: zodResolver(marketplaceAddressFormSchema),
    defaultValues: { ...marketplaceAddressFormDefaults, label: 'Home', name: 'Alice Buyer' },
    mode: 'onChange',
  });
  const city = useWatch({ control: form.control, name: 'city' });
  const region = useWatch({ control: form.control, name: 'region' });
  const postal = useWatch({ control: form.control, name: 'postalCode' });
  const line2 = useWatch({ control: form.control, name: 'line2' });
  const country = useWatch({ control: form.control, name: 'countryCode' });

  return (
    <div>
      <MarketplaceAddressFields
        control={form.control}
        setValue={form.setValue}
        autocompleteProvider={provider === undefined ? null : provider}
      />
      <output data-testid="filled-city">{city}</output>
      <output data-testid="filled-region">{region}</output>
      <output data-testid="filled-postal">{postal}</output>
      <output data-testid="filled-line2">{line2}</output>
      <output data-testid="filled-country">{country}</output>
    </div>
  );
}

describe('MarketplaceAddressFields', () => {
  it('asks for the country first, before any field that depends on it', () => {
    render(<Harness provider={null} />);

    const fields = [...document.querySelectorAll('[data-surface="marketplace-address-fields"] input')].map((input) =>
      input.getAttribute('name'),
    );
    expect(fields).toEqual(['countryCode', 'line1', 'line2', 'city', 'region', 'postalCode']);
  });

  it('searches in the country chosen before the street is typed', async () => {
    const user = userEvent.setup();
    const suggest = vi.fn<AddressAutocompleteProvider['suggest']>(async () => ({ status: 'ok', suggestions: [] }));
    render(<Harness provider={{ suggest }} />);

    await user.clear(screen.getByRole('textbox', { name: 'Country' }));
    await user.type(screen.getByRole('textbox', { name: 'Country' }), 'de');
    await user.type(screen.getByLabelText('Address line 1'), 'Unter den Linden 1');

    await waitFor(() => expect(suggest).toHaveBeenCalled());
    expect(suggest).toHaveBeenLastCalledWith('Unter den Linden 1', expect.objectContaining({ countryCode: 'DE' }));
    expect(suggest.mock.calls.every(([, options]) => options.countryCode === 'DE')).toBe(true);
  });

  it('labels US subdivision State and ZIP, and keeps suggestions closed without a provider', async () => {
    const user = userEvent.setup();
    render(<Harness provider={null} />);

    expect(screen.getByLabelText('State')).toBeInTheDocument();
    expect(screen.getByLabelText('ZIP code')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Address line 1'), '42 Union Street');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('filters the US state list as the buyer types', async () => {
    const user = userEvent.setup();
    render(<Harness provider={null} />);

    await user.click(screen.getByLabelText('State'));
    await user.type(screen.getByLabelText('State'), 'Mass');
    expect(screen.getByRole('option', { name: /Massachusetts/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /New York/ })).not.toBeInTheDocument();
  });

  it('fills the address from a selection, keeps line 2 and the country, and does not search again', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({ status: 'ok', suggestions: [suggestion] });
    render(<Harness provider={provider} />);

    await user.type(screen.getByLabelText('Address line 2'), 'Apt 4');
    await user.type(screen.getByLabelText('Address line 1'), '42 Union');
    const option = await screen.findByRole('option', { name: /42 Union Street/ });
    await user.click(option);

    await waitFor(() => {
      expect(screen.getByTestId('filled-city')).toHaveTextContent('New Bedford');
      expect(screen.getByTestId('filled-region')).toHaveTextContent('MA');
      expect(screen.getByTestId('filled-postal')).toHaveTextContent('02740');
    });
    expect(screen.getByLabelText('Address line 1')).toHaveValue('42 Union Street');
    expect(screen.getByTestId('filled-line2')).toHaveTextContent('Apt 4');
    expect(screen.getByTestId('filled-country')).toHaveTextContent('US');

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(provider.suggest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('debounces typing into one search, waits for four characters, and passes the country and an abort signal', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({ status: 'ok', suggestions: [suggestion] });
    render(<Harness provider={provider} />);

    await user.type(screen.getByLabelText('Address line 1'), '42 U');
    await screen.findByRole('option', { name: /42 Union Street/ });
    expect(provider.suggest).toHaveBeenCalledTimes(1);
    expect(provider.suggest).toHaveBeenCalledWith('42 U', {
      countryCode: 'US',
      signal: expect.any(AbortSignal),
    });
  });

  it('does not search below four characters', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({ status: 'ok', suggestions: [suggestion] });
    render(<Harness provider={provider} />);

    await user.type(screen.getByLabelText('Address line 1'), '42 ');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(provider.suggest).not.toHaveBeenCalled();
  });

  it('aborts the previous search when the buyer keeps typing', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const provider: AddressAutocompleteProvider = {
      suggest: vi.fn(async (_input, options) => {
        if (options.signal) signals.push(options.signal);
        return { status: 'ok', suggestions: [] } satisfies AddressSuggestResult;
      }),
    };
    render(<Harness provider={provider} />);

    const input = screen.getByLabelText('Address line 1');
    await user.type(input, '42 Un');
    await waitFor(() => expect(provider.suggest).toHaveBeenCalledTimes(1));
    await user.type(input, 'ion');
    await waitFor(() => expect(provider.suggest).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('credits OpenStreetMap under Address line 1 whenever suggestions are on', () => {
    const { rerender } = render(<Harness provider={providerReturning({ status: 'ok', suggestions: [] })} />);
    const link = screen.getByRole('link', { name: '© OpenStreetMap contributors' });
    expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('marketplace-address-attribution')).toHaveTextContent('Address suggestions');

    rerender(<Harness provider={null} />);
    expect(screen.queryByTestId('marketplace-address-attribution')).not.toBeInTheDocument();
  });

  it('says suggestions are unavailable and keeps manual entry working', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({ status: 'unavailable' });
    render(<Harness provider={provider} />);

    const line1 = screen.getByLabelText('Address line 1');
    await user.type(line1, '42 Union');
    expect(await screen.findByTestId('marketplace-address-unavailable')).toHaveTextContent(
      'Address suggestions are unavailable. Enter the address manually.',
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('City'), 'New Bedford');
    expect(screen.getByTestId('filled-city')).toHaveTextContent('New Bedford');

    await user.clear(line1);
    await waitFor(() => expect(screen.queryByTestId('marketplace-address-unavailable')).not.toBeInTheDocument());
  });

  it('searches other countries and leaves an unrecognised state name for the buyer to pick', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({
      status: 'ok',
      suggestions: [
        {
          ...suggestion,
          address: { ...suggestion.address, region: 'Nowhereland', countryCode: 'CA', postalCode: 'M5V 2T6' },
        },
      ],
    });
    render(<Harness provider={provider} />);

    await user.clear(screen.getByLabelText('Country'));
    await user.type(screen.getByLabelText('Country'), 'CA');
    await user.type(screen.getByLabelText('Address line 1'), '42 Union');
    await user.click(await screen.findByRole('option', { name: /42 Union Street/ }));

    expect(provider.suggest).toHaveBeenCalledWith('42 Union', expect.objectContaining({ countryCode: 'CA' }));
    await waitFor(() => expect(screen.getByTestId('filled-postal')).toHaveTextContent('M5V 2T6'));
    expect(screen.getByTestId('filled-region')).toHaveTextContent('');
  });

  it('maps a Canadian province name to its code', async () => {
    const user = userEvent.setup();
    const provider = providerReturning({
      status: 'ok',
      suggestions: [{ ...suggestion, address: { ...suggestion.address, region: 'Ontario', countryCode: 'CA' } }],
    });
    render(<Harness provider={provider} />);

    await user.clear(screen.getByLabelText('Country'));
    await user.type(screen.getByLabelText('Country'), 'CA');
    await user.type(screen.getByLabelText('Address line 1'), '42 Union');
    await user.click(await screen.findByRole('option', { name: /42 Union Street/ }));
    await waitFor(() => expect(screen.getByTestId('filled-region')).toHaveTextContent('ON'));
  });

  it('supports the keyboard: arrow to an option and Enter to pick it', async () => {
    const user = userEvent.setup();
    const second: AddressSuggestion = {
      ...suggestion,
      id: 'w2',
      primary: '42 Union Avenue',
      address: { ...suggestion.address, line1: '42 Union Avenue', city: 'Framingham', postalCode: '01702' },
    };
    render(<Harness provider={providerReturning({ status: 'ok', suggestions: [suggestion, second] })} />);

    await user.type(screen.getByLabelText('Address line 1'), '42 Union');
    await screen.findByRole('option', { name: /42 Union Avenue/ });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.getByTestId('filled-city')).toHaveTextContent('Framingham'));
    expect(screen.getByLabelText('Address line 1')).toHaveValue('42 Union Avenue');
  });

  it('fills City and State from a US ZIP without sending the street anywhere', async () => {
    const user = userEvent.setup();
    render(<Harness provider={null} />);

    await user.type(screen.getByLabelText('ZIP code'), '02740');
    await waitFor(() => {
      expect(screen.getByTestId('filled-city')).toHaveTextContent('New Bedford');
      expect(screen.getByTestId('filled-region')).toHaveTextContent('MA');
    });
  });

  it('leaves a typed city alone when ZIP fill runs', async () => {
    const user = userEvent.setup();
    render(<Harness provider={null} />);

    await user.type(screen.getByLabelText('City'), 'Fairhaven');
    await user.type(screen.getByLabelText('ZIP code'), '02740');
    await waitFor(() => {
      expect(screen.getByTestId('filled-region')).toHaveTextContent('MA');
    });
    expect(screen.getByTestId('filled-city')).toHaveTextContent('Fairhaven');
  });

  it('relabels to Province for CA and optional Region for GB', async () => {
    const user = userEvent.setup();
    render(<Harness provider={null} />);

    await user.clear(screen.getByLabelText('Country'));
    await user.type(screen.getByLabelText('Country'), 'CA');
    expect(screen.getByLabelText('Province')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Country'));
    await user.type(screen.getByLabelText('Country'), 'GB');
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
    expect(screen.getByLabelText('Postal code')).toBeInTheDocument();
  });
});
