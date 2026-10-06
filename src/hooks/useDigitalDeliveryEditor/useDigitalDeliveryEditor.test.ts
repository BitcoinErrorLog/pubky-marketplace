import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { DIGITAL_DELIVERY_SETUP_COPY } from '@/libs/commerce/digital';
import { ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { useDigitalDeliveryEditor } from './useDigitalDeliveryEditor';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchSellerDigitalDelivery: vi.fn(),
    commitSetDigitalDelivery: vi.fn(),
    commitClearDigitalDelivery: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const LISTING_ID = 'guide_01';

const ownerRead = (overrides: Record<string, unknown> = {}) => ({
  listingAggregateId: `listing:${'s'.repeat(52)}_${LISTING_ID}`,
  current: {
    kind: 'link' as const,
    deliverableId: 'a'.repeat(32),
    version: 2,
    createdAt: '2026-09-25T10:00:00.000Z',
    url: 'https://example.com/course',
  },
  lastVersion: 2,
  pinnedVersions: [{ version: 1, liveOrders: 3 }],
  ...overrides,
});

const ok = {
  ok: true as const,
  version: 1 as const,
  commandId: '',
  aggregateId: '',
  revision: 1,
  eventIds: [],
  result: { kind: 'digital_delivery' as const },
};
const refused = (code: string, reason?: string) => ({ ok: false as const, error: { code, message: 'x', reason } });

function editorHook(enabled = true, maxBytes: number | null = null) {
  return renderHook(() => useDigitalDeliveryEditor({ listingId: LISTING_ID, enabled, maxBytes }));
}

async function ready(enabled = true, maxBytes: number | null = null) {
  const hook = editorHook(enabled, maxBytes);
  await waitFor(() => expect(hook.result.current.readState).toBe('ready'));
  return hook;
}

function pdf(size = 32): File {
  const file = new File([new Uint8Array(size).fill(7)], 'Field Guide.pdf', { type: 'application/pdf' });
  return file;
}

beforeEach(() => {
  vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockReset();
  vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockResolvedValue(ownerRead());
  vi.mocked(CommerceController.commitSetDigitalDelivery).mockReset();
  vi.mocked(CommerceController.commitClearDigitalDelivery).mockReset();
  vi.mocked(toast).mockReset();
});

describe('useDigitalDeliveryEditor (digital delivery design §2, §6 C1–C5)', () => {
  it('reads nothing while the panel is gated off', async () => {
    const { result } = editorHook(false);
    await act(async () => {});
    expect(result.current.readState).toBe('idle');
    expect(CommerceController.fetchSellerDigitalDelivery).not.toHaveBeenCalled();
  });

  it('seeds the form from the owner read and states the live version', async () => {
    const { result } = await ready();

    expect(CommerceController.fetchSellerDigitalDelivery).toHaveBeenCalledWith(LISTING_ID);
    expect(result.current.form.getValues()).toEqual({ kind: 'link', url: 'https://example.com/course', text: '' });
    expect(result.current.versionLine).toBe('Version 2 is live. 3 buyers still download version 1.');
  });

  it('sets a link as the next version and reloads', async () => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue(ok as never);
    const { result } = await ready();
    act(() => result.current.form.setValue('url', ' https://example.com/new-course '));

    let saved = false;
    await act(async () => {
      saved = await result.current.submit();
    });

    expect(saved).toBe(true);
    expect(CommerceController.commitSetDigitalDelivery).toHaveBeenCalledWith(LISTING_ID, {
      expectedVersion: 2,
      delivery: { kind: 'link', url: 'https://example.com/new-course' },
    });
    expect(CommerceController.fetchSellerDigitalDelivery).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith({ description: 'Version 2 is live. 3 buyers still download version 1.' });
  });

  it('asks for a file before saving the file kind, then hands over its bytes', async () => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue(ok as never);
    const { result } = await ready();
    act(() => result.current.form.setValue('kind', 'file'));

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.error).toBe('Choose the file buyers receive.');
    expect(CommerceController.commitSetDigitalDelivery).not.toHaveBeenCalled();

    act(() => result.current.picker.choose(pdf(32)));
    await act(async () => {
      await result.current.submit();
    });

    const [, input] = vi.mocked(CommerceController.commitSetDigitalDelivery).mock.calls[0] as [
      string,
      { expectedVersion: number; delivery: { kind: string; bytes: Uint8Array; fileName: string; contentType: string } },
    ];
    expect(input.expectedVersion).toBe(2);
    expect(input.delivery).toMatchObject({ kind: 'file', fileName: 'Field Guide.pdf', contentType: 'application/pdf' });
    expect(input.delivery.bytes).toBeInstanceOf(Uint8Array);
    expect(input.delivery.bytes).toHaveLength(32);
    expect(result.current.picker.file).toBeNull();
  });

  it('refuses a malformed link or empty text before any command', async () => {
    const { result } = await ready();
    act(() => result.current.form.setValue('url', 'http://example.com'));
    await act(async () => {
      expect(await result.current.submit()).toBe(false);
    });
    act(() => {
      result.current.form.setValue('kind', 'text');
      result.current.form.setValue('text', '   ');
    });
    await act(async () => {
      expect(await result.current.submit()).toBe(false);
    });
    expect(CommerceController.commitSetDigitalDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ['in_use', refused('INVALID_STATE', 'digital_delivery_in_use'), DIGITAL_DELIVERY_SETUP_COPY.in_use],
    ['unverifiable', refused('INVALID_STATE', 'deliverable_unverifiable'), DIGITAL_DELIVERY_SETUP_COPY.unverifiable],
    ['not_seller', refused('UNAUTHORIZED'), DIGITAL_DELIVERY_SETUP_COPY.not_seller],
    ['not_published', refused('INVALID_STATE'), DIGITAL_DELIVERY_SETUP_COPY.not_published],
    ['unknown', refused('INTERNAL'), DIGITAL_DELIVERY_SETUP_COPY.failed],
  ])('shows the %s refusal in plain words', async (_label, response, copy) => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue(response as never);
    const { result } = await ready();

    await act(async () => {
      expect(await result.current.submit()).toBe(false);
    });

    expect(result.current.error).toBe(copy);
  });

  it('reloads the owner read when the delivery changed underneath the seller', async () => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue(refused('REVISION_CONFLICT') as never);
    const { result } = await ready();

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe(DIGITAL_DELIVERY_SETUP_COPY.changed);
    expect(CommerceController.fetchSellerDigitalDelivery).toHaveBeenCalledTimes(2);
  });

  it('names the deployment cap on a too-large refusal', async () => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockResolvedValue(
      refused('INVALID_COMMAND', 'deliverable_too_large') as never,
    );
    const { result } = await ready(true, 20 * 1024 * 1024);
    act(() => {
      result.current.form.setValue('kind', 'file');
      result.current.picker.choose(pdf());
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe('Files can be up to 20 MB for now.');
  });

  it.each([
    [507, DIGITAL_DELIVERY_SETUP_COPY.uploadStorageFull],
    [413, DIGITAL_DELIVERY_SETUP_COPY.uploadStorageFull],
    [500, DIGITAL_DELIVERY_SETUP_COPY.uploadFailed],
  ])('reads a %s homeserver upload refusal', async (statusCode, copy) => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockRejectedValue(
      Err.server(ServerErrorCode.INTERNAL_ERROR, 'upload failed', {
        service: ErrorService.Homeserver,
        operation: 'putBlob',
        context: { statusCode },
      }),
    );
    const { result } = await ready();
    act(() => {
      result.current.form.setValue('kind', 'file');
      result.current.picker.choose(pdf());
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe(copy);
  });

  it.each([
    [
      'the encryption on this device',
      Err.validation(ValidationErrorCode.INVALID_INPUT, 'encrypt failed', {
        service: ErrorService.Local,
        operation: 'commitSetDigitalDelivery',
        context: { refusal: 'encrypt_failed' },
      }),
      DIGITAL_DELIVERY_SETUP_COPY.encryptFailed,
    ],
    [
      'the command after the upload',
      Err.server(ServerErrorCode.INTERNAL_ERROR, 'service unavailable', {
        service: ErrorService.Marketplace,
        operation: 'execute',
        context: { statusCode: 503 },
      }),
      DIGITAL_DELIVERY_SETUP_COPY.failed,
    ],
    ['an untyped failure', new TypeError('network'), DIGITAL_DELIVERY_SETUP_COPY.failed],
  ])('names a file set that failed in %s, not as a homeserver refusal', async (_where, caught, copy) => {
    vi.mocked(CommerceController.commitSetDigitalDelivery).mockRejectedValue(caught);
    const { result } = await ready();
    act(() => {
      result.current.form.setValue('kind', 'file');
      result.current.picker.choose(pdf());
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe(copy);
  });

  it('clears the delivery, and shows a refusal when buyers still use it', async () => {
    vi.mocked(CommerceController.commitClearDigitalDelivery).mockResolvedValueOnce(
      refused('INVALID_STATE', 'digital_delivery_in_use') as never,
    );
    const { result } = await ready();

    await act(async () => {
      expect(await result.current.clear()).toBe(false);
    });
    expect(result.current.error).toBe(DIGITAL_DELIVERY_SETUP_COPY.in_use);

    vi.mocked(CommerceController.commitClearDigitalDelivery).mockResolvedValueOnce(ok as never);
    await act(async () => {
      expect(await result.current.clear()).toBe(true);
    });
    expect(CommerceController.commitClearDigitalDelivery).toHaveBeenLastCalledWith(LISTING_ID, 2);
  });

  it('reports a failed owner read and retries it', async () => {
    vi.mocked(CommerceController.fetchSellerDigitalDelivery).mockRejectedValueOnce(new TypeError('offline'));
    const { result } = editorHook();
    await waitFor(() => expect(result.current.readState).toBe('failed'));
    expect(result.current.error).toBe('This could not be loaded. Try again.');

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.readState).toBe('ready');
  });
});
