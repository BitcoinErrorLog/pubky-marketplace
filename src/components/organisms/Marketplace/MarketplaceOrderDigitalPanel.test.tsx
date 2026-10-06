import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { MarketplaceOrderDigitalPanel } from './MarketplaceOrderDigitalPanel';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchOrderDigitalDelivery: vi.fn(),
    openOrderDigitalFile: vi.fn(),
    fetchOrderDeliveryEmail: vi.fn(),
    commitSetDeliveryEmail: vi.fn(),
  },
}));

const base = createOrderFixture('delivered');
type Kind = 'file' | 'link' | 'text' | 'email' | 'message';

function digitalOrder(state: MarketplaceOrder['state'], kinds: Kind[], overrides: Partial<MarketplaceOrder> = {}) {
  return createOrderFixture(state, {
    fulfillment: 'digital',
    lines: kinds.map((kind, index) => ({
      ...base.lines[0],
      title: `Item ${index} (${kind})`,
      fulfillment: 'digital' as const,
      digitalKind: kind,
    })),
    ...overrides,
  });
}

// The released line matches the paid order line: same listing and seller (bindOrderDigitalLine).
const common = {
  listingAggregateId: base.lines[0].listingAggregateId,
  sellerPubky: base.sellerPubky,
  deliverableId: 'a'.repeat(32),
  version: 2,
};

describe('MarketplaceOrderDigitalPanel (digital delivery design §3 "After payment", §6 D5–D11, F5–F12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockResolvedValue({
      orderId: base.id,
      deliveryEmail: 'buyer@example.com',
      emailedAt: null,
    });
  });

  it('renders nothing for an order without digital lines', () => {
    const { container } = render(<MarketplaceOrderDigitalPanel order={createOrderFixture('paid')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Download on a paid file line and reads nothing until it is pressed', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockResolvedValue({
      orderId: base.id,
      lines: [
        {
          ...common,
          lineIndex: 0,
          kind: 'file',
          key: 'c'.repeat(64),
          iv: 'd'.repeat(24),
          ciphertextBlake3: 'e'.repeat(64),
          plaintextBlake3: 'f'.repeat(64),
          contentType: 'application/pdf',
          fileName: 'Field Guide.pdf',
          sizeBytes: 3,
        },
      ],
    });
    vi.mocked(CommerceController.openOrderDigitalFile).mockResolvedValue({ ok: false, reason: 'fetch_failed' });
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('delivered', ['file'])} />);

    expect(screen.getByRole('heading', { name: 'Your purchase' })).toBeInTheDocument();
    expect(CommerceController.fetchOrderDigitalDelivery).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(CommerceController.fetchOrderDigitalDelivery).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The seller's homeserver didn't return the file. Try again shortly.",
    );
  });

  it('says a purchase unlocks at payment, and offers nothing to open before then (D8)', () => {
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('pending_payment', ['file'], { receiptId: null })} />);

    expect(screen.getByText('Available as soon as payment is confirmed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('says an ended order no longer downloads (D9)', () => {
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('refunded_external', ['file'])} />);

    expect(
      screen.getByText('This order was refunded or cancelled, so the download is no longer available.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('reveals a text, masked from replay, until hidden', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockResolvedValue({
      orderId: base.id,
      lines: [{ ...common, lineIndex: 0, kind: 'text', text: 'Licence ABC-123' }],
    });
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('delivered', ['text'])} />);

    await user.click(screen.getByRole('button', { name: 'Reveal text' }));
    const text = await screen.findByTestId('order-digital-text');
    expect(text).toHaveTextContent('Licence ABC-123');
    expect(text).toHaveAttribute('data-sentry-mask');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('order-digital-text')).not.toBeInTheDocument();
  });

  it('shows a link that opens in a new tab without the opener', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockResolvedValue({
      orderId: base.id,
      lines: [{ ...common, lineIndex: 0, kind: 'link', url: 'https://example.com/course' }],
    });
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('delivered', ['link'])} />);

    await user.click(screen.getByRole('button', { name: 'Show link' }));
    const link = await screen.findByRole('link', { name: /Open link/ });
    expect(link).toHaveAttribute('href', 'https://example.com/course');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows where the seller will email it and lets the buyer change it (F5, F11)', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.commitSetDeliveryEmail).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000931',
      aggregateId: `order:${base.id}`,
      revision: 2,
      eventIds: [],
      result: { kind: 'order' },
    });
    const order = digitalOrder('paid', ['email']);
    render(<MarketplaceOrderDigitalPanel order={order} />);

    expect(await screen.findByText('The seller will email this to buyer@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const input = screen.getByLabelText('Email for delivery');
    await user.clear(input);
    await user.type(input, 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(CommerceController.commitSetDeliveryEmail).toHaveBeenCalledWith(order.id, order.revision, 'new@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. The seller will use this address.');
  });

  it('says when it was emailed, and offers no change after that (F12)', async () => {
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockResolvedValue({
      orderId: base.id,
      deliveryEmail: 'buyer@example.com',
      emailedAt: '2026-09-26T12:00:00.000Z',
    });
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('delivered', ['email'])} />);

    expect(
      await screen.findByText(
        'Emailed to buyer@example.com on Sep 26, 2026. Check your spam folder, or message the seller.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('offers no change once emailed, even while a message line keeps the order paid (F12)', async () => {
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockResolvedValue({
      orderId: base.id,
      deliveryEmail: 'buyer@example.com',
      emailedAt: '2026-09-26T12:00:00.000Z',
    });
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('paid', ['email', 'message'])} />);

    expect(await screen.findByText(/^Emailed to buyer@example.com on Sep 26, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email for delivery')).not.toBeInTheDocument();
  });

  it('asks for an email when none is on file (F9)', async () => {
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockRejectedValue(
      Err.client(ClientErrorCode.CONFLICT, 'No delivery email is on file for this order.', {
        service: ErrorService.Marketplace,
        operation: 'getOrderDeliveryEmail',
        context: { statusCode: 409, refusal: 'email_missing' },
      }),
    );
    render(<MarketplaceOrderDigitalPanel order={digitalOrder('paid', ['email'])} />);

    expect(await screen.findByText('Enter your email so the seller can deliver.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email for delivery')).toBeInTheDocument();
  });

  it('tells the buyer where a message-kind purchase arrives', async () => {
    const { unmount } = render(<MarketplaceOrderDigitalPanel order={digitalOrder('paid', ['message'])} />);
    expect(screen.getByText('The seller will send this in your messages.')).toBeInTheDocument();
    unmount();

    render(<MarketplaceOrderDigitalPanel order={digitalOrder('delivered', ['message'])} />);
    expect(screen.getByText('The seller marked this delivered. Check your messages.')).toBeInTheDocument();
    await waitFor(() => expect(CommerceController.fetchOrderDeliveryEmail).not.toHaveBeenCalled());
  });
});
