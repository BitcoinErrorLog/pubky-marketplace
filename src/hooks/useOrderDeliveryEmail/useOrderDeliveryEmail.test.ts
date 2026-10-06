import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { orderHasEmailLine, useOrderDeliveryEmail } from './useOrderDeliveryEmail';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchOrderDeliveryEmail: vi.fn(),
    commitSetDeliveryEmail: vi.fn(),
  },
}));

const base = createOrderFixture('paid');
const order = createOrderFixture('paid', {
  fulfillment: 'digital',
  revision: 4,
  lines: [{ ...base.lines[0], fulfillment: 'digital', digitalKind: 'email' }],
});
const ok = {
  ok: true as const,
  version: 1 as const,
  commandId: '018f47d2-6a27-7c23-a62f-000000000921',
  aggregateId: `order:${order.id}`,
  revision: 5,
  eventIds: [],
  result: { kind: 'order' as const },
};

describe('useOrderDeliveryEmail (digital delivery design §4.3, §6 F5, F9, F11, F12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockResolvedValue({
      orderId: order.id,
      deliveryEmail: 'buyer@example.com',
      emailedAt: null,
    });
    vi.mocked(CommerceController.commitSetDeliveryEmail).mockResolvedValue(ok);
  });

  it('reads the address for an email-kind order, and nothing otherwise', async () => {
    const { result } = renderHook(() => useOrderDeliveryEmail(order, { enabled: true }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({
      status: 'ready',
      email: { orderId: order.id, deliveryEmail: 'buyer@example.com', emailedAt: null },
    });

    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockClear();
    renderHook(() => useOrderDeliveryEmail(createOrderFixture('paid'), { enabled: true }));
    renderHook(() => useOrderDeliveryEmail(order, { enabled: false }));
    expect(CommerceController.fetchOrderDeliveryEmail).not.toHaveBeenCalled();
    expect(orderHasEmailLine(order)).toBe(true);
  });

  it('reads a purged address as missing, so the buyer can enter one (F9)', async () => {
    vi.mocked(CommerceController.fetchOrderDeliveryEmail).mockRejectedValue(
      Err.client(ClientErrorCode.CONFLICT, 'No delivery email is on file for this order.', {
        service: ErrorService.Marketplace,
        operation: 'getOrderDeliveryEmail',
        context: { statusCode: 409, refusal: 'email_missing' },
      }),
    );
    const { result } = renderHook(() => useOrderDeliveryEmail(order, { enabled: true }));

    await waitFor(() => expect(result.current.state).toEqual({ status: 'missing' }));
  });

  it('refuses a malformed address before any command', async () => {
    const { result } = renderHook(() => useOrderDeliveryEmail(order, { enabled: true }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let saved = true;
    await act(async () => {
      saved = await result.current.change('buyer at example.com');
    });

    expect(saved).toBe(false);
    expect(result.current.changeMessage).toBe('Check the email address.');
    expect(CommerceController.commitSetDeliveryEmail).not.toHaveBeenCalled();
  });

  it('saves a new address with the order revision and reloads (F11)', async () => {
    const onChanged = vi.fn();
    const { result } = renderHook(() => useOrderDeliveryEmail(order, { enabled: true, onChanged }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      await result.current.change('  new@example.com ');
    });

    expect(CommerceController.commitSetDeliveryEmail).toHaveBeenCalledWith(order.id, 4, 'new@example.com');
    expect(result.current.changeMessage).toBe('Saved. The seller will use this address.');
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(CommerceController.fetchOrderDeliveryEmail).toHaveBeenCalledTimes(2));
  });

  it('says the seller already emailed it, and reloads (F12)', async () => {
    vi.mocked(CommerceController.commitSetDeliveryEmail).mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'service words', reason: 'already_emailed' },
    } as never);
    const { result } = renderHook(() => useOrderDeliveryEmail(order, { enabled: true }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      await result.current.change('new@example.com');
    });

    expect(result.current.changeMessage).toBe(
      "The seller already emailed your purchase. Message them if it didn't arrive.",
    );
    await waitFor(() => expect(CommerceController.fetchOrderDeliveryEmail).toHaveBeenCalledTimes(2));
  });
});
