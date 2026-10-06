import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MaskedPickupDetails } from '@/libs/commerce/pickup';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { pickupRevealRefusalMessage, usePickupReveal } from './usePickupReveal';

const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000741';

const reveal = {
  orderId: ORDER_ID,
  firstRevealedAt: '2026-08-19T21:00:00.000Z',
  lines: [
    {
      lineIndex: 0,
      listingAggregateId: `listing:${'y'.repeat(52)}_boots`,
      version: 2,
      currentVersion: 3,
      updatedSincePayment: true,
      withdrawnBySeller: false,
      updatedAt: '2026-08-10T09:00:00.000Z',
      details: MaskedPickupDetails.wrap({
        kind: 'spot' as const,
        spot: 'Central Station, north entrance',
        instructions: 'Ring the bell twice.',
        availability: { zone: 'Europe/Berlin' },
      }),
    },
  ],
};

const controllerState = vi.hoisted(() => ({
  reveal: null as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchPickupReveal: vi.fn(async () => {
      if (controllerState.reveal instanceof Error) throw controllerState.reveal;
      return controllerState.reveal;
    }),
  },
}));

const mockedController = vi.mocked(CommerceController);

function refusalError(message: string, refusal?: string) {
  return new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.UNPROCESSABLE,
    message,
    service: ErrorService.Marketplace,
    operation: 'fetchPickupReveal',
    context: refusal ? { refusal } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  controllerState.reveal = reveal;
});

describe('usePickupReveal', () => {
  it('holds the pinned snapshot in memory after a successful reveal', async () => {
    const { result } = renderHook(() => usePickupReveal(ORDER_ID));

    expect(result.current.state).toBe('idle');
    await act(async () => {
      await result.current.load();
    });

    expect(result.current.state).toBe('ready');
    expect(result.current.reveal).toEqual(reveal);
    expect(result.current.refusalMessage).toBeNull();
    expect(mockedController.fetchPickupReveal).toHaveBeenCalledWith(ORDER_ID);

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.reveal).toBeNull();
  });

  it('maps a typed context refusal without falling through to the generic copy', async () => {
    controllerState.reveal = refusalError('The order carries no payment confirmation.', 'payment_unconfirmed');
    const { result } = renderHook(() => usePickupReveal(ORDER_ID));

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.state).toBe('refused');
    expect(result.current.reveal).toBeNull();
    expect(result.current.refusalMessage).toBe('The meeting point is revealed as soon as your payment confirms.');
  });

  it('classifies a known service INVALID_STATE message when context.refusal is absent', async () => {
    controllerState.reveal = refusalError(
      'This order was confirmed by a sandbox payment; its pickup details are never revealed.',
    );
    const { result } = renderHook(() => usePickupReveal(ORDER_ID));

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.state).toBe('refused');
    expect(result.current.refusalMessage).toBe(
      'This order was paid with sandbox money, so no real meeting point is ever revealed.',
    );
  });

  it('uses the generic copy for an unknown refusal', async () => {
    controllerState.reveal = new Error('network blip');
    const { result } = renderHook(() => usePickupReveal(ORDER_ID));

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.state).toBe('refused');
    expect(result.current.refusalMessage).toBe('The pickup details could not be shown.');
  });
});

describe('pickupRevealRefusalMessage', () => {
  it('covers every typed refusal the classifier can emit', () => {
    expect(pickupRevealRefusalMessage('payment_unconfirmed')).toContain('payment confirms');
    expect(pickupRevealRefusalMessage('order_terminal')).toContain('closed');
    expect(pickupRevealRefusalMessage('sandbox_confirmed')).toContain('sandbox');
    expect(pickupRevealRefusalMessage('no_pinned_details')).toContain('no pinned');
    expect(pickupRevealRefusalMessage('pickup_unavailable')).toContain('not available');
    expect(pickupRevealRefusalMessage('not_pickup_order')).toContain('not a pickup');
    expect(pickupRevealRefusalMessage('pickup_not_published')).toBe('The pickup details could not be shown.');
    expect(pickupRevealRefusalMessage('terms_change_unresolved')).toBe('The pickup details could not be shown.');
    expect(pickupRevealRefusalMessage(null)).toBe('The pickup details could not be shown.');
  });
});
