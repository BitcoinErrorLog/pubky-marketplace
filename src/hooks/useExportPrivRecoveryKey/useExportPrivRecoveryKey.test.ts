import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { RECOVERY_KEY_URL_LIFETIME_MS, useExportPrivRecoveryKey } from './useExportPrivRecoveryKey';

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

const FILE = { fileName: 'pubky-marketplace-recovery-key-kkkkkkkk.json', contents: '{"format":"x"}\n' };

describe('useExportPrivRecoveryKey', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    config.mode = 'transaction-service';
    clicked = [];
    createObjectURL = vi.fn(() => 'blob:recovery');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads the recovery key file and revokes the blob URL after the download is handed off', async () => {
    vi.useFakeTimers();
    vi.spyOn(CommerceController, 'exportPrivRecoveryKey').mockResolvedValue({ kind: 'file', file: FILE });
    const { result } = renderHook(() => useExportPrivRecoveryKey());

    let exported = false;
    await act(async () => {
      exported = await result.current.exportKey();
    });

    expect(exported).toBe(true);
    expect(result.current.status).toBe('exported');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe(FILE.fileName);
    expect(clicked[0].href).toBe('blob:recovery');
    expect(clicked[0].isConnected).toBe(false);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(FILE.contents);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECOVERY_KEY_URL_LIFETIME_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
  });

  it('revokes the blob URL at once when the download cannot be started', async () => {
    vi.spyOn(CommerceController, 'exportPrivRecoveryKey').mockResolvedValue({ kind: 'file', file: FILE });
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useExportPrivRecoveryKey());

    await act(async () => {
      expect(await result.current.exportKey()).toBe(false);
    });

    expect(result.current.status).toBe('error');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
  });

  it.each(['needs_reauth', 'unavailable'] as const)('reports %s without downloading anything', async (kind) => {
    vi.spyOn(CommerceController, 'exportPrivRecoveryKey').mockResolvedValue({ kind });
    const { result } = renderHook(() => useExportPrivRecoveryKey());

    await act(async () => {
      expect(await result.current.exportKey()).toBe(false);
    });

    expect(result.current.status).toBe(kind);
    expect(clicked).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('reports error when the key read fails', async () => {
    vi.spyOn(CommerceController, 'exportPrivRecoveryKey').mockRejectedValue(new TypeError('network unavailable'));
    const { result } = renderHook(() => useExportPrivRecoveryKey());

    await act(async () => {
      expect(await result.current.exportKey()).toBe(false);
    });

    expect(result.current.status).toBe('error');
    expect(clicked).toEqual([]);
  });

  it('is not available outside the durable marketplace service', () => {
    config.mode = 'sandbox';
    const { result } = renderHook(() => useExportPrivRecoveryKey());
    expect(result.current.isAvailable).toBe(false);
  });
});
