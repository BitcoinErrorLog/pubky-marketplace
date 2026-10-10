import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/molecules/Toaster/use-toast';
import { createUsdtOrderFixture } from '@/test/fixtures/commerce/orders';
import { REFUND_FIXTURE_ADDRESS, REFUND_FIXTURE_OTHER_ADDRESS } from '@/test/fixtures/commerce/usdt-refund.wire';
import { useConfirmRefundDestination } from './useConfirmRefundDestination';

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

async function fill(
  result: { current: ReturnType<typeof useConfirmRefundDestination> },
  values: { address?: string; networkConfirmed?: boolean; source?: 'another' | 'payment' },
) {
  await act(async () => {
    if (values.source) result.current.form.setValue('source', values.source);
    if (values.address !== undefined) result.current.form.setValue('address', values.address);
    if (values.networkConfirmed !== undefined)
      result.current.form.setValue('networkConfirmed', values.networkConfirmed);
  });
}

// Reading `errors` during render subscribes the hook to validation state.
function withErrors<T extends ReturnType<typeof useConfirmRefundDestination>>(value: T): T {
  void value.form.formState.errors;
  return value;
}

describe('useConfirmRefundDestination', () => {
  const order = createUsdtOrderFixture('paid');

  it('sends refund.confirm_destination with the trimmed address once the network is confirmed', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => withErrors(useConfirmRefundDestination(order, actOnOrder)));
    await fill(result, { address: `  ${REFUND_FIXTURE_ADDRESS} `, networkConfirmed: true });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.confirm_destination', { address: REFUND_FIXTURE_ADDRESS });
    expect(toast).toHaveBeenCalledWith({ title: 'Refund address confirmed' });
  });

  it('refuses an empty address, a malformed address and a bad checksum without calling the service', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => withErrors(useConfirmRefundDestination(order, actOnOrder)));

    await fill(result, { address: '', networkConfirmed: true });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.form.formState.errors.address?.message).toBe('Enter an Arbitrum One address.');

    await fill(result, { address: '0xnope' });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.form.formState.errors.address?.message).toBe(
      "That isn't a valid Arbitrum address. Check it and try again.",
    );

    await fill(result, { address: `0x${REFUND_FIXTURE_ADDRESS.slice(2).replace('a', 'A')}` });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.form.formState.errors.address?.message).toBe(
      "That isn't a valid Arbitrum address. Check it and try again.",
    );
    expect(actOnOrder).not.toHaveBeenCalled();
  });

  it('requires the Arbitrum One network confirmation', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => withErrors(useConfirmRefundDestination(order, actOnOrder)));
    await fill(result, { address: REFUND_FIXTURE_ADDRESS, networkConfirmed: false });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.form.formState.errors.networkConfirmed?.message).toBe(
      'Confirm that this address accepts USDT on Arbitrum One.',
    );
    expect(actOnOrder).not.toHaveBeenCalled();
  });

  it('reports a refused command and shows no success toast', async () => {
    const actOnOrder = vi.fn(async () => false);
    const { result } = renderHook(() => withErrors(useConfirmRefundDestination(order, actOnOrder)));
    await fill(result, { address: REFUND_FIXTURE_ADDRESS, networkConfirmed: true });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('offers no "address I paid from" choice unless the service projects the paying address', () => {
    const { result } = renderHook(() =>
      useConfirmRefundDestination(
        order,
        vi.fn(async () => true),
      ),
    );
    expect(result.current.paymentAddress).toBeNull();
    expect(result.current.form.getValues('source')).toBe('another');
  });

  it('defaults to the paying address when known and submits it as the address', async () => {
    const withPaymentAddress = createUsdtOrderFixture('paid', { paymentAddress: REFUND_FIXTURE_OTHER_ADDRESS });
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useConfirmRefundDestination(withPaymentAddress, actOnOrder));
    expect(result.current.paymentAddress).toBe(REFUND_FIXTURE_OTHER_ADDRESS);
    expect(result.current.form.getValues('source')).toBe('payment');
    await fill(result, { networkConfirmed: true });

    await act(async () => {
      await result.current.submit();
    });

    expect(actOnOrder).toHaveBeenCalledWith(withPaymentAddress, 'refund.confirm_destination', {
      address: REFUND_FIXTURE_OTHER_ADDRESS,
    });
  });

  it('prefills the current address when the buyer replaces it', () => {
    const { result } = renderHook(() =>
      useConfirmRefundDestination(
        order,
        vi.fn(async () => true),
      ),
    );
    act(() => result.current.reset(REFUND_FIXTURE_ADDRESS));
    expect(result.current.form.getValues()).toEqual({
      source: 'another',
      address: REFUND_FIXTURE_ADDRESS,
      networkConfirmed: false,
    });
  });
});
