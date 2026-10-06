import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { type MarketplaceSellerPickupDetails, MaskedPickupDetails } from '@/libs/commerce/pickup';
import { toast } from '@/molecules/Toaster/use-toast';
import { MarketplacePickupDetailsEditor } from './MarketplacePickupDetailsEditor';

const LISTING_ID = 'boots_01';

const controllerState = vi.hoisted(() => ({
  pickupAvailable: true,
  ownerRead: null as MarketplaceSellerPickupDetails | null,
  ownerReadFails: false,
  setResponse: { ok: true } as unknown,
  clearResponse: { ok: true } as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchPickupAvailable: vi.fn(async () => controllerState.pickupAvailable),
    fetchSellerPickupDetails: vi.fn(async () => {
      if (controllerState.ownerReadFails) throw new Error('read failed');
      return controllerState.ownerRead;
    }),
    commitSetPickupDetails: vi.fn(async () => controllerState.setResponse),
    commitClearPickupDetails: vi.fn(async () => controllerState.clearResponse),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

const mockedController = vi.mocked(CommerceController);

const SPOT_DETAILS = {
  kind: 'spot' as const,
  spot: 'Central Station, north entrance',
  instructions: 'Ring the bell twice.',
  availability: { zone: 'Europe/Berlin' },
};

function ownerRead(overrides: Partial<MarketplaceSellerPickupDetails> = {}): MarketplaceSellerPickupDetails {
  return {
    listingAggregateId: `listing:${'y'.repeat(52)}_${LISTING_ID}`,
    current: {
      details: MaskedPickupDetails.wrap(SPOT_DETAILS),
      version: 3,
      updatedAt: '2026-08-19T20:00:00.000Z',
    },
    lastVersion: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  controllerState.pickupAvailable = true;
  controllerState.ownerRead = ownerRead();
  controllerState.ownerReadFails = false;
  controllerState.setResponse = { ok: true };
  controllerState.clearResponse = { ok: true };
});

describe('MarketplacePickupDetailsEditor', () => {
  it('renders the deployment note and no details fields when pickup is unavailable (sandbox included)', async () => {
    // `pickup_available` is off without the sealing key and on every
    // sandbox-payments deployment — one flag, one honest note (§A7).
    controllerState.pickupAvailable = false;
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    expect(await screen.findByText('Local pickup is not available on this deployment.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meeting point')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save pickup details' })).not.toBeInTheDocument();
    expect(mockedController.fetchSellerPickupDetails).not.toHaveBeenCalled();
  });

  it('populates the editor from the owner read and shows the seller-visible version counter', async () => {
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    expect(await screen.findByLabelText('Meeting point')).toHaveValue('Central Station, north entrance');
    expect(screen.getByLabelText('Pickup details version 3')).toHaveTextContent('Saved as version 3 · counter v3');
    expect(mockedController.fetchSellerPickupDetails).toHaveBeenCalledWith(LISTING_ID);
    // Telemetry masking is binding (§7.2): the surface carries the mask and
    // the VRT capture marker.
    const surface = screen.getByTestId('pickup-details-editor');
    expect(surface).toHaveAttribute('data-sentry-mask');
    expect(surface).toHaveAttribute('data-surface', 'pickup-details-editor');
  });

  it('saves through commitSetPickupDetails with the CAS version from the owner read', async () => {
    const user = userEvent.setup();
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    const meetingPoint = await screen.findByLabelText('Meeting point');
    await user.clear(meetingPoint);
    await user.type(meetingPoint, 'Harbor Market, stall 12');
    await user.click(screen.getByRole('button', { name: 'Save pickup details' }));

    await waitFor(() => {
      expect(mockedController.commitSetPickupDetails).toHaveBeenCalledWith(LISTING_ID, {
        expectedVersion: 3,
        details: expect.objectContaining({ kind: 'spot', spot: 'Harbor Market, stall 12' }),
      });
    });
    expect(mockedController.fetchSellerPickupDetails).toHaveBeenCalledTimes(2); // re-read after save
  });

  it('CAS-bases a fresh save on the surviving counter after a clear (post-clear CAS, §A3)', async () => {
    controllerState.ownerRead = ownerRead({ current: null, lastVersion: 4 });
    const user = userEvent.setup();
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    expect(await screen.findByLabelText('Pickup details version 4')).toHaveTextContent('No details saved · counter v4');
    await user.type(await screen.findByLabelText('Meeting point'), 'Harbor Market, stall 12');
    await user.click(screen.getByRole('button', { name: 'Save pickup details' }));

    await waitFor(() => {
      expect(mockedController.commitSetPickupDetails).toHaveBeenCalledWith(LISTING_ID, {
        expectedVersion: 4,
        details: expect.objectContaining({ spot: 'Harbor Market, stall 12' }),
      });
    });
  });

  it('blocks saving over an unread row and retries the owner read (the self-heal rule, §A4)', async () => {
    controllerState.ownerReadFails = true;
    const user = userEvent.setup();
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    expect(await screen.findByTestId('pickup-read-failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save pickup details' })).not.toBeInTheDocument();

    controllerState.ownerReadFails = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Meeting point')).toBeInTheDocument();
  });

  it('clears through commitClearPickupDetails after the paid-buyer warning', async () => {
    const user = userEvent.setup();
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    await user.click(await screen.findByRole('button', { name: 'Remove pickup details' }));
    expect(
      await screen.findByText(/Buyers who already paid keep the terms they were shown at payment/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove details' }));

    await waitFor(() => {
      expect(mockedController.commitClearPickupDetails).toHaveBeenCalledWith(LISTING_ID, 3);
    });
  });

  it('reloads and asks for a retry when the save hits a version conflict', async () => {
    controllerState.setResponse = {
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The pickup details version is stale.', currentRevision: 4 },
    };
    const user = userEvent.setup();
    render(<MarketplacePickupDetailsEditor listingId={LISTING_ID} />);

    const meetingPoint = await screen.findByLabelText('Meeting point');
    await user.clear(meetingPoint);
    await user.type(meetingPoint, 'Harbor Market, stall 12');
    await user.click(screen.getByRole('button', { name: 'Save pickup details' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    });
    expect(mockedController.fetchSellerPickupDetails).toHaveBeenCalledTimes(2);
  });
});
