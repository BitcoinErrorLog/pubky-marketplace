import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { db } from '@/database/franky/franky';
import { useAuthStore } from '@/stores/auth/auth.store';
import { createOrderFixture, ORDER_FIXTURE_SELLER } from '@/test/fixtures/commerce/orders';
import { MarketplacePackingSlipDialog } from './MarketplacePackingSlipDialog';

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketplace/orders',
}));

const PASTED_ADDRESS = 'Ada Buyer\n123 Privacy Lane\n83820 Someville, US';

const UNAVAILABLE_NOTE = 'Delivery address unavailable for this order — paste it below.';

const LOCAL_ONLY_NOTE =
  'Kept only in this dialog on this device — not saved, not sent to the marketplace or any server. Anything you print (including print-to-PDF) will contain it.';

async function openSlip() {
  render(<MarketplacePackingSlipDialog order={createOrderFixture('paid')} />);
  await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));
  return screen.getByRole('dialog');
}

// Escape routes through the dialog's onOpenChange(false), the same path as
// the footer Close button and the built-in X.
async function closeSlip() {
  await userEvent.keyboard('{Escape}');
}

async function expectNothingPersisted(haystack: string) {
  // Web storage: nothing may have been written at all by this flow.
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  // Dexie: scan every table for the pasted value.
  if (!db.isOpen()) await db.open();
  for (const table of db.tables) {
    const rows = await table.toArray();
    expect(JSON.stringify(rows)).not.toContain(haystack);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useAuthStore.setState({ currentUserPubky: null });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  useAuthStore.setState({ currentUserPubky: null });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('MarketplacePackingSlipDialog — bitcoin amount', () => {
  it('prints items, shipping, and the payment code as the total', async () => {
    render(
      <MarketplacePackingSlipDialog
        order={createOrderFixture('paid', {
          paymentMethod: 'bitcoin',
          paykitTotalSats: 1_255,
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
          total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
        })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Items ₿1,000')).toBeInTheDocument();
    expect(within(dialog).getByText('Shipping ₿0')).toBeInTheDocument();
    expect(within(dialog).getByText('Payment code ₿255')).toBeInTheDocument();
    expect(within(dialog).getByText('Total ₿1,255')).toBeInTheDocument();
  });
});

describe('MarketplacePackingSlipDialog — paste delivery address', () => {
  it('shows the deployment limitation note and ruled lines while the field is empty', async () => {
    const dialog = await openSlip();

    const slip = within(dialog).getByText('Packing slip', { selector: 'p' }).closest('[data-packing-slip]')!;
    expect(within(slip as HTMLElement).getByText(new RegExp(UNAVAILABLE_NOTE))).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Paste delivery address (optional)')).toHaveValue('');
    expect(within(dialog).getByText(LOCAL_ONLY_NOTE)).toBeInTheDocument();
  });

  it('marks the paste field for Sentry Replay masking', async () => {
    const dialog = await openSlip();
    expect(within(dialog).getByLabelText('Paste delivery address (optional)')).toHaveAttribute('data-sentry-mask');

    // instrumentation-client.test.ts is out of this wave's edit set; pin the
    // Replay options from the client source so a maskAllInputs regression
    // still fails this suite. The module is not imported (side effects).
    const clientInit = readFileSync(resolve(__dirname, '../../../instrumentation-client.ts'), 'utf8');
    expect(clientInit).toMatch(/replayIntegration\(\{[\s\S]*maskAllText:\s*true/);
    expect(clientInit).toMatch(/replayIntegration\(\{[\s\S]*maskAllInputs:\s*true/);
  });

  it('renders the pasted address into the printed slip only when non-empty', async () => {
    const dialog = await openSlip();
    const field = within(dialog).getByLabelText('Paste delivery address (optional)');

    await userEvent.type(field, PASTED_ADDRESS);
    const slip = dialog.querySelector('[data-packing-slip]')!;
    expect(within(slip as HTMLElement).getByText(/123 Privacy Lane/)).toBeInTheDocument();
    // The deployment limitation note gives way to the pasted destination.
    expect(within(slip as HTMLElement).queryByText(new RegExp(UNAVAILABLE_NOTE))).toBeNull();

    await userEvent.clear(field);
    expect(within(slip as HTMLElement).queryByText(/123 Privacy Lane/)).toBeNull();
    expect(within(slip as HTMLElement).getByText(new RegExp(UNAVAILABLE_NOTE))).toBeInTheDocument();
  });

  it('clears the pasted address when the dialog closes', async () => {
    const dialog = await openSlip();
    const field = within(dialog).getByLabelText('Paste delivery address (optional)');
    await userEvent.type(field, PASTED_ADDRESS);

    await closeSlip();

    // Reopen: the field and the slip are back to the withheld state.
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));
    const reopened = screen.getByRole('dialog');
    expect(within(reopened).getByLabelText('Paste delivery address (optional)')).toHaveValue('');
    const slip = reopened.querySelector('[data-packing-slip]')!;
    expect(within(slip as HTMLElement).queryByText(/123 Privacy Lane/)).toBeNull();
  });

  it('never persists the pasted address (Dexie, localStorage, sessionStorage)', async () => {
    const dialog = await openSlip();
    await userEvent.type(within(dialog).getByLabelText('Paste delivery address (optional)'), PASTED_ADDRESS);
    await closeSlip();

    await expectNothingPersisted(PASTED_ADDRESS);
  });
});

describe('MarketplacePackingSlipDialog — pickup orders (§A5)', () => {
  it('suppresses the delivery-address block and the paste field, naming the in-app meeting point', async () => {
    render(<MarketplacePackingSlipDialog order={createOrderFixture('ready_for_pickup')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).queryByLabelText('Paste delivery address (optional)')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(new RegExp(UNAVAILABLE_NOTE))).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('Local pickup — meeting point is only visible to the buyer in the app.'),
    ).toBeInTheDocument();
    // The slip keeps the line items and totals — there is just no address.
    const slip = dialog.querySelector('[data-packing-slip]')!;
    expect(within(slip as HTMLElement).getByText('Handmade leather boots')).toBeInTheDocument();
  });

  it('keeps the shipped-order slip unchanged', async () => {
    const dialog = await openSlip();

    expect(within(dialog).getByLabelText('Paste delivery address (optional)')).toBeInTheDocument();
    expect(within(dialog).getByText(new RegExp(UNAVAILABLE_NOTE))).toBeInTheDocument();
    expect(
      within(dialog).queryByText('Local pickup — meeting point is only visible to the buyer in the app.'),
    ).not.toBeInTheDocument();
  });
});

describe('MarketplacePackingSlipDialog — seller delivery projection', () => {
  it('renders the seller paid shipping address from the single-order projection', async () => {
    const order = createOrderFixture('paid');
    const sellerOrder = createOrderFixture('paid', {
      deliveryAddress: {
        format: 'plaintext_v1',
        address: {
          name: 'Alice Buyer',
          line1: '1 Market Street',
          line2: '',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'US',
        },
      },
    });
    vi.spyOn(CommerceController, 'getMarketplaceOrder').mockResolvedValue(sellerOrder);
    useAuthStore.setState({ currentUserPubky: ORDER_FIXTURE_SELLER });

    render(<MarketplacePackingSlipDialog order={order} />);
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));

    const slip = screen.getByRole('dialog').querySelector('[data-packing-slip]')!;
    await waitFor(() => expect(within(slip as HTMLElement).getByText('1 Market Street')).toBeInTheDocument());
    expect(within(slip as HTMLElement).getByText('Alice Buyer')).toBeInTheDocument();
    expect(within(slip as HTMLElement).getByText('New York, NY 10001')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByLabelText('Paste delivery address (optional)')).toBeNull();
  });

  it('falls back to the static paste guidance for an unsupported format', async () => {
    const order = createOrderFixture('paid');
    vi.spyOn(CommerceController, 'getMarketplaceOrder').mockResolvedValue(
      createOrderFixture('paid', { deliveryAddress: { format: 'unsupported' } }),
    );
    useAuthStore.setState({ currentUserPubky: ORDER_FIXTURE_SELLER });

    render(<MarketplacePackingSlipDialog order={order} />);
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));

    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog).getByText('Delivery address unavailable for this order — paste it below.'),
      ).toBeInTheDocument(),
    );
    expect(within(dialog).getByLabelText('Paste delivery address (optional)')).toBeInTheDocument();
  });

  it('clears the rendered and pasted address on account switch', async () => {
    const order = createOrderFixture('paid');
    vi.spyOn(CommerceController, 'getMarketplaceOrder').mockResolvedValue(
      createOrderFixture('paid', {
        deliveryAddress: {
          format: 'plaintext_v1',
          address: {
            name: 'Alice Buyer',
            line1: '1 Market Street',
            line2: '',
            city: 'New York',
            region: 'NY',
            postalCode: '10001',
            countryCode: 'US',
          },
        },
      }),
    );
    useAuthStore.setState({ currentUserPubky: ORDER_FIXTURE_SELLER });

    render(<MarketplacePackingSlipDialog order={order} />);
    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('1 Market Street')).toBeInTheDocument());

    useAuthStore.setState({ currentUserPubky: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Packing slip' }));
    const reopened = screen.getByRole('dialog');
    expect(within(reopened).queryByText('1 Market Street')).toBeNull();
    expect(within(reopened).getByLabelText('Paste delivery address (optional)')).toBeInTheDocument();
  });
});
