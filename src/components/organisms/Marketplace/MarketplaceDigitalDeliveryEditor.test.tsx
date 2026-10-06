import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  DIGITAL_DELIVERY_COPY,
  DIGITAL_DELIVERY_SETUP_COPY,
  type MarketplaceSellerDigitalDelivery,
} from '@/libs/commerce/digital';
import { MarketplaceDigitalDeliveryEditor } from './MarketplaceDigitalDeliveryEditor';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchSellerDigitalDelivery: vi.fn(),
    commitSetDigitalDelivery: vi.fn(),
    commitClearDigitalDelivery: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const read = (current: MarketplaceSellerDigitalDelivery['current']) => ({
  listingAggregateId: 'listing:x_guide_01',
  current,
  lastVersion: current ? 2 : 0,
  pinnedVersions: current ? [{ version: 1, liveOrders: 3 }] : [],
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockReset();
  vi.mocked(CommerceController.commitSetDigitalDelivery).mockReset();
  vi.mocked(CommerceController.commitClearDigitalDelivery).mockReset();
});

function editor(props: Partial<Parameters<typeof MarketplaceDigitalDeliveryEditor>[0]> = {}) {
  return render(
    <MarketplaceDigitalDeliveryEditor listingId="guide_01" available maxBytes={null} published {...props} />,
  );
}

describe('MarketplaceDigitalDeliveryEditor (digital delivery design §2)', () => {
  it('says so and reads nothing when the deployment has no digital delivery', () => {
    editor({ available: false });
    expect(screen.getByText(DIGITAL_DELIVERY_COPY.unavailable)).toBeInTheDocument();
    expect(CommerceController.fetchSellerDigitalDelivery).not.toHaveBeenCalled();
  });

  it('asks the seller to save the listing first when the record does not sell digitally yet', () => {
    editor({ published: false });
    expect(screen.getByText(DIGITAL_DELIVERY_SETUP_COPY.not_published)).toBeInTheDocument();
    expect(CommerceController.fetchSellerDigitalDelivery).not.toHaveBeenCalled();
  });

  it('shows the current delivery, its version line, and the trust note', async () => {
    vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockResolvedValue(
      read({
        kind: 'file',
        deliverableId: 'a'.repeat(32),
        version: 2,
        createdAt: '',
        fileName: 'Field Guide.pdf',
        sizeBytes: 12_582_912,
      }),
    );
    editor();

    expect(await screen.findByTestId('digital-delivery-current')).toHaveTextContent(
      'Buyers download Field Guide.pdf (12 MB) after payment.',
    );
    expect(screen.getByText('Version 2 is live. 3 buyers still download version 1.')).toBeInTheDocument();
    expect(screen.getByText(/stores only the encrypted copy on your homeserver/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove delivery' })).toBeInTheDocument();
  });

  it('offers the five kinds and shows the input each needs', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockResolvedValue(read(null));
    editor();

    expect(await screen.findByText(/^Not set yet/)).toBeInTheDocument();
    for (const label of ['A file', 'A link', 'Text or a licence key', "I'll email it", "I'll send it in messages"]) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove delivery' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /A link/ }));
    expect(screen.getByLabelText('Link')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Text or a licence key/ }));
    await user.type(screen.getByLabelText('Text every buyer receives'), 'KEY-1');
    expect(screen.getByText('5 / 4,000')).toBeInTheDocument();
  });

  it('saves the chosen file through the panel', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockResolvedValue(read(null));
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '',
      aggregateId: '',
      revision: 1,
      eventIds: [],
      result: { kind: 'digital_delivery' },
    } as never);
    editor();

    await screen.findByText(/^Not set yet/);
    await user.upload(
      screen.getByTestId('digital-delivery-file-input'),
      new File(['guide bytes'], 'guide.pdf', { type: 'application/pdf' }),
    );
    expect(screen.getByTestId('digital-delivery-chosen-file')).toHaveTextContent('guide.pdf · 1 KB');
    await user.click(screen.getByRole('button', { name: 'Save delivery' }));

    await waitFor(() => expect(CommerceController.commitSetDigitalDelivery).toHaveBeenCalledTimes(1));
    expect(vi.mocked(CommerceController.commitSetDigitalDelivery).mock.calls[0][1]).toMatchObject({
      expectedVersion: 0,
      delivery: { kind: 'file', fileName: 'guide.pdf', contentType: 'application/pdf' },
    });
  });

  it('shows a refusal in plain words', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockResolvedValue(
      read({ kind: 'email', deliverableId: 'a'.repeat(32), version: 2, createdAt: '' }),
    );
    vi.mocked(CommerceController.commitClearDigitalDelivery).mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'service text', reason: 'digital_delivery_in_use' },
    } as never);
    editor();

    await user.click(await screen.findByRole('button', { name: 'Remove delivery' }));

    expect(await screen.findByTestId('digital-delivery-error')).toHaveTextContent(DIGITAL_DELIVERY_SETUP_COPY.in_use);
    expect(screen.queryByText('service text')).not.toBeInTheDocument();
  });

  it('offers a retry when the owner read fails', async () => {
    const user = userEvent.setup();
    vi.mocked(CommerceController.fetchSellerDigitalDelivery)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(read(null));
    editor();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/^Not set yet/)).toBeInTheDocument();
  });
});
