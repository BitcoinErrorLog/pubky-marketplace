import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { toast } from '@/molecules/Toaster/use-toast';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { usePickupOrderActions } from './usePickupOrderActions';

const controllerState = vi.hoisted(() => ({
  markReadyResponse: { ok: true } as unknown,
  confirmResponse: { ok: true } as unknown,
  cancelResponse: { ok: true } as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    commitMarkReady: vi.fn(async () => controllerState.markReadyResponse),
    commitConfirmPickup: vi.fn(async () => controllerState.confirmResponse),
    executeMarketplaceCommand: vi.fn(async () => controllerState.cancelResponse),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

const mockedController = vi.mocked(CommerceController);

const ORDER = createOrderFixture('paid', { fulfillment: 'pickup' });

function renderActions(onChanged = vi.fn()) {
  return { result: renderHook(() => usePickupOrderActions(ORDER, onChanged)).result, onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  controllerState.markReadyResponse = { ok: true };
  controllerState.confirmResponse = { ok: true };
  controllerState.cancelResponse = { ok: true };
});

describe('usePickupOrderActions', () => {
  it('marks ready through fulfillment.mark_ready with the order revision as CAS', async () => {
    const { result, onChanged } = renderActions();

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.markReady();
    });

    expect(succeeded).toBe(true);
    expect(mockedController.commitMarkReady).toHaveBeenCalledWith(ORDER.id, ORDER.revision);
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms the handover and reports terms_blocked instead of toasting the raw refusal (§A6)', async () => {
    controllerState.confirmResponse = {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message:
          'The pickup terms changed after payment; the seller cannot confirm the handover until the buyer has seen the change.',
      },
    };
    const { result } = renderActions();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.confirmHandover();
    });

    expect(outcome).toBe('terms_blocked');
    expect(toast).not.toHaveBeenCalled();
  });

  it('toasts static pickup-refusal copy and never the server message when the envelope echoes a meeting address', async () => {
    // Same fixture as marketplace-transaction.test.ts: the seller meeting
    // address this feature seals at rest. A refusal that still carries it
    // must not put it on screen.
    const echoed = 'Meet at 14 Oak Lane after 6pm; ask for the red jacket.';
    controllerState.markReadyResponse = {
      ok: false,
      error: { code: 'INVALID_STATE', message: echoed },
    };
    const { result } = renderActions();

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.markReady();
    });

    expect(succeeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: 'The pickup request was refused.',
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('14 Oak Lane');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(echoed);
  });

  it('reloads and asks for a retry on a revision conflict', async () => {
    controllerState.confirmResponse = {
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The order revision is stale.', currentRevision: 3 },
    };
    const { result, onChanged } = renderActions();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.confirmHandover();
    });

    expect(outcome).toBe(false);
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
  });

  it('reads the unilateral exit from the result order state — cancelled vs the degraded cancel_requested (§7.2)', async () => {
    controllerState.cancelResponse = {
      ok: true,
      result: { kind: 'order', order: { state: 'cancelled' } },
    };
    const { result } = renderActions();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.cancelOrder('The spot no longer works for me');
    });

    expect(outcome).toBe('cancelled');
    expect(mockedController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'order.cancel_request',
        payload: { orderId: ORDER.id, reason: 'The spot no longer works for me' },
      }),
    );
  });

  it('returns cancel_requested when the service degraded the lost-race request', async () => {
    controllerState.cancelResponse = {
      ok: true,
      result: { kind: 'order', order: { state: 'cancel_requested' } },
    };
    const { result } = renderActions();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.cancelOrder('Changed my mind');
    });

    expect(outcome).toBe('cancel_requested');
  });
});
