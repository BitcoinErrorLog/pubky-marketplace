import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { orderDigitalLines, saveDigitalFile, useOrderDigitalDelivery } from './useOrderDigitalDelivery';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchOrderDigitalDelivery: vi.fn(),
    openOrderDigitalFile: vi.fn(),
  },
}));

const base = createOrderFixture('delivered');
const listing = (name: string) => `listing:${base.sellerPubky}_${name}`;
const order = createOrderFixture('delivered', {
  fulfillment: 'digital',
  lines: [
    {
      ...base.lines[0],
      listingAggregateId: listing('guide'),
      title: 'Field guide',
      fulfillment: 'digital',
      digitalKind: 'file',
    },
    {
      ...base.lines[0],
      listingAggregateId: listing('licence'),
      title: 'Licence key',
      fulfillment: 'digital',
      digitalKind: 'text',
    },
    {
      ...base.lines[0],
      listingAggregateId: listing('course'),
      title: 'Course',
      fulfillment: 'digital',
      digitalKind: 'link',
    },
  ],
});
const common = { sellerPubky: order.sellerPubky, deliverableId: 'a'.repeat(32), version: 2 };
const fileLine = {
  ...common,
  lineIndex: 0,
  listingAggregateId: listing('guide'),
  kind: 'file' as const,
  key: 'c'.repeat(64),
  iv: 'd'.repeat(24),
  ciphertextBlake3: 'e'.repeat(64),
  plaintextBlake3: 'f'.repeat(64),
  contentType: 'application/pdf',
  fileName: 'Field Guide.pdf',
  sizeBytes: 3,
};
const textLine = {
  ...common,
  lineIndex: 1,
  listingAggregateId: listing('licence'),
  kind: 'text' as const,
  text: 'Licence ABC-123',
};
const linkLine = {
  ...common,
  lineIndex: 2,
  listingAggregateId: listing('course'),
  kind: 'link' as const,
  url: 'https://example.com/course',
};
const pinned = [fileLine, textLine, linkLine];
/** The service's per-line read: only the requested line. */
const readOne = async (_orderId: unknown, lineIndex: unknown) => ({
  orderId: order.id,
  lines: pinned.filter((line) => line.lineIndex === lineIndex),
});

describe('useOrderDigitalDelivery (digital delivery design §3 "After payment", §3.4)', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:purchase');
  const revokeObjectURL = vi.fn();
  let clicked: HTMLAnchorElement[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clicked = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockImplementation(readOne);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists the digital lines by kind and reads nothing until the buyer opens one', () => {
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    expect(result.current.lines).toEqual([
      { lineIndex: 0, title: 'Field guide', kind: 'file' },
      { lineIndex: 1, title: 'Licence key', kind: 'text' },
      { lineIndex: 2, title: 'Course', kind: 'link' },
    ]);
    expect(CommerceController.fetchOrderDigitalDelivery).not.toHaveBeenCalled();
    expect(orderDigitalLines(createOrderFixture('paid'))).toEqual([]);
  });

  it('downloads a verified file under its pinned name and drops the object URL', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.mocked(CommerceController.openOrderDigitalFile).mockResolvedValue({
      ok: true,
      bytes,
      fileName: 'Field Guide.pdf',
      contentType: 'application/pdf',
    });
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(0);
    });

    expect(CommerceController.openOrderDigitalFile).toHaveBeenCalledWith(fileLine);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('Field Guide.pdf');
    expect(clicked[0].href).toBe('blob:purchase');
    expect([...bytes]).toEqual([0, 0, 0]);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:purchase');
    expect(result.current.stateFor(0)).toEqual({ status: 'idle', message: null });
  });

  it('names a file that does not verify, and saves nothing', async () => {
    vi.mocked(CommerceController.openOrderDigitalFile).mockResolvedValue({ ok: false, reason: 'ciphertext_mismatch' });
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(0);
    });

    expect(clicked).toHaveLength(0);
    expect(result.current.stateFor(0)).toEqual({
      status: 'failed',
      message: "The file on the seller's homeserver isn't the one you paid for. Message the seller.",
    });
  });

  it('shows a text or link until hidden, reading it fresh each time', async () => {
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(1);
      await result.current.open(2);
    });

    expect(result.current.revealFor(1)).toEqual({ kind: 'text', text: 'Licence ABC-123' });
    expect(result.current.revealFor(2)).toEqual({ kind: 'link', url: 'https://example.com/course' });
    expect(CommerceController.fetchOrderDigitalDelivery).toHaveBeenCalledTimes(2);
    act(() => result.current.hide(1));
    expect(result.current.revealFor(1)).toBeNull();
  });

  // Review P1: opening one line reads that line only.
  it('reads only the line the buyer opens', async () => {
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(1);
    });

    expect(CommerceController.fetchOrderDigitalDelivery).toHaveBeenCalledTimes(1);
    expect(CommerceController.fetchOrderDigitalDelivery).toHaveBeenCalledWith(order.id, 1);
    expect(result.current.revealFor(1)).toEqual({ kind: 'text', text: 'Licence ABC-123' });
    expect(result.current.revealFor(2)).toBeNull();
  });

  // Review P2: a released line must be the opened line of this paid order.
  it.each([
    ['another order', { orderId: '018f47d2-6a27-7c23-a62f-00000000ffff', lines: [textLine] }],
    ['more than the opened line', { orderId: order.id, lines: [textLine, linkLine] }],
    ['another line index', { orderId: order.id, lines: [{ ...textLine, lineIndex: 2 }] }],
    ['another listing', { orderId: order.id, lines: [{ ...textLine, listingAggregateId: listing('other') }] }],
    ['another seller', { orderId: order.id, lines: [{ ...textLine, sellerPubky: 'y'.repeat(52) }] }],
    [
      'another kind',
      { orderId: order.id, lines: [{ ...linkLine, lineIndex: 1, listingAggregateId: listing('licence') }] },
    ],
  ])('refuses a release naming %s, and reveals nothing', async (_label, release) => {
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockResolvedValue(release);
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(1);
    });

    expect(result.current.revealFor(1)).toBeNull();
    expect(result.current.stateFor(1)).toEqual({
      status: 'failed',
      message: "This download doesn't match your order. Try again, or message the seller.",
    });
  });

  it('opens no file from a release bound to another line', async () => {
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockResolvedValue({
      orderId: order.id,
      lines: [{ ...fileLine, listingAggregateId: listing('other') }],
    });
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(0);
    });

    expect(CommerceController.openOrderDigitalFile).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
  });

  it('shows the refusal copy, never the service message (D8)', async () => {
    vi.mocked(CommerceController.fetchOrderDigitalDelivery).mockRejectedValue(
      Err.client(ClientErrorCode.CONFLICT, 'Available as soon as payment is confirmed.', {
        service: ErrorService.Marketplace,
        operation: 'getOrderDigitalDelivery',
        context: { statusCode: 409, refusal: 'not_paid' },
      }),
    );
    const { result } = renderHook(() => useOrderDigitalDelivery(order));

    await act(async () => {
      await result.current.open(1);
    });

    expect(result.current.stateFor(1)).toEqual({
      status: 'failed',
      message: 'Available as soon as payment is confirmed.',
    });
    expect(result.current.revealFor(1)).toBeNull();
  });

  it('saves a copy of the bytes, so zeroing the source leaves the download intact', () => {
    const bytes = new Uint8Array([9, 9]);
    const blobs: Blob[] = [];
    createObjectURL.mockImplementationOnce((blob: Blob) => {
      blobs.push(blob);
      return 'blob:copy';
    });

    saveDigitalFile(bytes, 'a.bin', 'application/octet-stream');

    expect(blobs[0].size).toBe(2);
    expect(blobs[0].type).toBe('application/octet-stream');
    expect([...bytes]).toEqual([0, 0]);
  });
});
