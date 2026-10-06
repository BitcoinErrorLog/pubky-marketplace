import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MaskedPickupDetails,
  PICKUP_LISTING_GONE_TOAST,
  PICKUP_NOTHING_PUBLISHED_TOAST,
  PICKUP_SESSION_EXPIRED_TOAST,
} from '@/libs/commerce/pickup';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { usePickupDetailsForm } from './usePickupDetailsForm';
import { pickupDetailsFormDefaults, pickupDetailsFormSchema } from './usePickupDetailsForm.types';

const LISTING_ID = 'boots_01';

const spotDetails = {
  kind: 'spot' as const,
  spot: 'Central Station, north entrance',
  instructions: 'Ring the bell twice.',
  availability: {
    windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

const ownerRead = {
  listingAggregateId: `listing:${'y'.repeat(52)}_boots_01`,
  current: {
    details: MaskedPickupDetails.wrap(spotDetails),
    version: 3,
    updatedAt: '2026-08-19T20:00:00.000Z',
  },
  lastVersion: 3,
};

const controllerState = vi.hoisted(() => ({
  available: true as boolean | Error,
  ownerRead: null as unknown,
  setResponse: { ok: true } as unknown,
  clearResponse: { ok: true } as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchPickupAvailable: vi.fn(async () => {
      if (controllerState.available instanceof Error) throw controllerState.available;
      return controllerState.available;
    }),
    fetchSellerPickupDetails: vi.fn(async () => {
      if (controllerState.ownerRead instanceof Error) throw controllerState.ownerRead;
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

const sessionRequiredError = () =>
  new AppError({
    category: ErrorCategory.Auth,
    code: AuthErrorCode.SESSION_EXPIRED,
    message: 'The marketplace session expired. Approve the marketplace connection on your signer and try again.',
    service: ErrorService.Marketplace,
    operation: 'commitSetPickupDetails',
  });

const pickupNotPublishedError = () =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.CONFLICT,
    message: 'The listing does not publish pickup.',
    service: ErrorService.Marketplace,
    operation: 'commitSetPickupDetails',
    context: { refusal: 'pickup_not_published' },
  });

async function renderReadyForm(
  options: { persistListing?: () => Promise<boolean>; revertListing?: () => Promise<boolean> } = {},
) {
  const rendered = renderHook(() => usePickupDetailsForm(LISTING_ID, options));
  await waitFor(() => {
    expect(rendered.result.current.readState).toBe('ready');
    expect(rendered.result.current.capability).toBe('available');
  });
  return rendered;
}

beforeEach(() => {
  vi.clearAllMocks();
  controllerState.available = true;
  controllerState.ownerRead = ownerRead;
  controllerState.setResponse = { ok: true };
  controllerState.clearResponse = { ok: true };
});

describe('usePickupDetailsForm', () => {
  it('canonicalizes the UTC device timezone to a contract-valid IANA zone', () => {
    const defaults = pickupDetailsFormDefaults('UTC', 'US');
    defaults.spot = 'Harbor Market, stall 12';

    expect(defaults.zone).toBe('Etc/UTC');
    expect(pickupDetailsFormSchema.safeParse(defaults).success).toBe(true);
  });

  it('starts an address in the browser country: no details yet, or a spot pickup switched to an address', async () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB']);
    try {
      controllerState.ownerRead = { ...ownerRead, current: null, lastVersion: 0 };
      const empty = await renderReadyForm();
      expect(empty.result.current.form.getValues('countryCode')).toBe('GB');
      empty.unmount();

      controllerState.ownerRead = ownerRead;
      const spot = await renderReadyForm();
      expect(spot.result.current.form.getValues('kind')).toBe('spot');
      expect(spot.result.current.form.getValues('countryCode')).toBe('GB');
    } finally {
      languages.mockRestore();
    }
  });

  it('hydrates from the owner read and saves with the current version as CAS', async () => {
    const { result } = await renderReadyForm();

    expect(result.current.currentVersion).toBe(3);
    expect(result.current.lastVersion).toBe(3);
    expect(result.current.form.getValues('spot')).toBe('Central Station, north entrance');
    expect(result.current.canClear).toBe(true);
    expect(result.current.canSave).toBe(false);

    act(() => {
      result.current.form.setValue('spot', 'Market square, east kiosk', { shouldDirty: true });
    });
    expect(result.current.canSave).toBe(true);

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(true);
    expect(mockedController.commitSetPickupDetails).toHaveBeenCalledWith(
      LISTING_ID,
      expect.objectContaining({
        expectedVersion: 3,
        details: expect.objectContaining({ kind: 'spot', spot: 'Market square, east kiosk' }),
      }),
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pickup details saved' }));
  });

  it('refuses to save when the capability is off', async () => {
    controllerState.available = false;
    const { result } = renderHook(() => usePickupDetailsForm(LISTING_ID));
    await waitFor(() => {
      expect(result.current.capability).toBe('unavailable');
      expect(result.current.readState).toBe('failed');
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(mockedController.commitSetPickupDetails).not.toHaveBeenCalled();
  });

  it('refuses to save over an unread owner row', async () => {
    controllerState.ownerRead = new Error('owner read failed');
    const { result } = renderHook(() => usePickupDetailsForm(LISTING_ID));
    await waitFor(() => {
      expect(result.current.capability).toBe('available');
      expect(result.current.readState).toBe('failed');
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(mockedController.commitSetPickupDetails).not.toHaveBeenCalled();
  });

  it('reloads and asks for a retry on a revision conflict', async () => {
    const { result } = await renderReadyForm();
    controllerState.setResponse = {
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The pickup details version is stale.', currentVersion: 4 },
    };

    act(() => {
      result.current.form.setValue('instructions', 'Ask for the blue bag.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    await waitFor(() => {
      expect(mockedController.fetchSellerPickupDetails.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('toasts static pickup-refusal copy and never a meeting address echoed in the envelope', async () => {
    const echoed = 'Meet at 14 Oak Lane after 6pm; ask for the red jacket.';
    const { result } = await renderReadyForm();
    controllerState.setResponse = {
      ok: false,
      error: { code: 'INVALID_STATE', message: echoed },
    };

    act(() => {
      result.current.form.setValue('instructions', 'Ask for the blue bag.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'The pickup request was refused.',
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('14 Oak Lane');
  });

  it('toasts the session-required error instead of a generic save failure', async () => {
    mockedController.commitSetPickupDetails.mockRejectedValueOnce(sessionRequiredError());
    const { result } = await renderReadyForm();

    act(() => {
      result.current.form.setValue('instructions', 'Weekdays after 18:00.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        description:
          'The marketplace session expired. Approve the marketplace connection on your signer and try again.',
      }),
    );
  });

  it('toasts the classified pickup_not_published next step instead of a generic save failure', async () => {
    mockedController.commitSetPickupDetails.mockRejectedValueOnce(pickupNotPublishedError());
    const { result } = await renderReadyForm();

    act(() => {
      result.current.form.setValue('instructions', 'Weekdays after 18:00.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'Save the listing as pickup first (Save changes), then save the meeting point.',
    });
  });

  it('persists the listing once then retries set when pickup is not yet published', async () => {
    const persistListing = vi.fn(async () => true);
    mockedController.commitSetPickupDetails
      .mockRejectedValueOnce(pickupNotPublishedError())
      .mockResolvedValueOnce({ ok: true } as never);
    const { result } = await renderReadyForm({ persistListing });

    act(() => {
      result.current.form.setValue('spot', 'Harbor Market, stall 12', { shouldDirty: true });
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(true);
    expect(persistListing).toHaveBeenCalledOnce();
    expect(mockedController.commitSetPickupDetails).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pickup details saved' }));
  });

  it('skips retry when persistListing returns false', async () => {
    const persistListing = vi.fn(async () => false);
    const revertListing = vi.fn(async () => true);
    mockedController.commitSetPickupDetails.mockRejectedValueOnce(pickupNotPublishedError());
    const { result } = await renderReadyForm({ persistListing, revertListing });

    act(() => {
      result.current.form.setValue('spot', 'Harbor Market, stall 12', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(persistListing).toHaveBeenCalledOnce();
    expect(mockedController.commitSetPickupDetails).toHaveBeenCalledOnce();
    expect(revertListing).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'Save the listing as pickup first (Save changes), then save the meeting point.',
    });
  });

  it('reverts the listing when persist succeeds and the retry set fails', async () => {
    const persistListing = vi.fn(async () => true);
    const revertListing = vi.fn(async () => true);
    mockedController.commitSetPickupDetails
      .mockRejectedValueOnce(pickupNotPublishedError())
      .mockRejectedValueOnce(new Error('injected set failure'));
    const { result } = await renderReadyForm({ persistListing, revertListing });

    act(() => {
      result.current.form.setValue('spot', 'Harbor Market, stall 12', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(persistListing).toHaveBeenCalledOnce();
    expect(mockedController.commitSetPickupDetails).toHaveBeenCalledTimes(2);
    expect(revertListing).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: PICKUP_NOTHING_PUBLISHED_TOAST,
    });
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'The pickup details could not be saved.',
    });
  });

  it('does not persist a second time when the retry is still pickup_not_published', async () => {
    const persistListing = vi.fn(async () => true);
    const revertListing = vi.fn(async () => true);
    mockedController.commitSetPickupDetails
      .mockRejectedValueOnce(pickupNotPublishedError())
      .mockRejectedValueOnce(pickupNotPublishedError());
    const { result } = await renderReadyForm({ persistListing, revertListing });

    act(() => {
      result.current.form.setValue('spot', 'Harbor Market, stall 12', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(persistListing).toHaveBeenCalledOnce();
    expect(mockedController.commitSetPickupDetails).toHaveBeenCalledTimes(2);
    expect(revertListing).toHaveBeenCalledOnce();
  });

  it('toasts a refresh prompt when the listing is gone', async () => {
    const { result } = await renderReadyForm();
    controllerState.setResponse = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'The listing was not found.' },
    };

    act(() => {
      result.current.form.setValue('instructions', 'Weekdays after 18:00.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: PICKUP_LISTING_GONE_TOAST,
    });
  });

  it('toasts a sign-in prompt when the set is unauthorized', async () => {
    const { result } = await renderReadyForm();
    controllerState.setResponse = {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Only the listing seller may set pickup details.' },
    };

    act(() => {
      result.current.form.setValue('instructions', 'Weekdays after 18:00.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: PICKUP_SESSION_EXPIRED_TOAST,
    });
  });

  it('toasts the generic save failure for unclassified thrown errors', async () => {
    mockedController.commitSetPickupDetails.mockRejectedValueOnce(new Error('network down'));
    const { result } = await renderReadyForm();

    act(() => {
      result.current.form.setValue('instructions', 'Weekdays after 18:00.', { shouldDirty: true });
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.save();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'The pickup details could not be saved.',
    });
  });

  it('clears through pickup_details.clear and refuses when nothing is saved', async () => {
    const { result } = await renderReadyForm();

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.clearDetails();
    });

    expect(succeeded).toBe(true);
    expect(mockedController.commitClearPickupDetails).toHaveBeenCalledWith(LISTING_ID, 3);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pickup details removed' }));

    controllerState.ownerRead = { ...ownerRead, current: null, lastVersion: 3 };
    const empty = renderHook(() => usePickupDetailsForm(LISTING_ID));
    await waitFor(() => {
      expect(empty.result.current.readState).toBe('ready');
      expect(empty.result.current.currentVersion).toBeNull();
    });

    let cleared = true;
    await act(async () => {
      cleared = await empty.result.current.clearDetails();
    });
    expect(cleared).toBe(false);
  });
});
