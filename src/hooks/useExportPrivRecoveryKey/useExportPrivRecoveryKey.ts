'use client';

import { useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { privErrorSummary } from '@/libs/commerce/priv-envelope';
import type { PrivRecoveryKeyFile } from '@/libs/commerce/priv-recovery-key';
import { Logger } from '@/libs/logger/logger';

export type ExportPrivRecoveryKeyStatus = 'idle' | 'exporting' | 'exported' | 'needs_reauth' | 'unavailable' | 'error';

interface UseExportPrivRecoveryKeyResult {
  /** False outside the durable marketplace service, where no data keys exist. */
  isAvailable: boolean;
  status: ExportPrivRecoveryKeyStatus;
  /** Downloads the recovery key file. Resolves true once the download was handed to the browser. */
  exportKey: () => Promise<boolean>;
}

/** Revoking a blob URL in the task that clicked it can cancel the download in some browsers. */
export const RECOVERY_KEY_URL_LIFETIME_MS = 1_000;

function download(file: PrivRecoveryKeyFile): void {
  const url = URL.createObjectURL(new Blob([file.contents], { type: 'application/json' }));
  let handedOff = false;
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    handedOff = true;
  } finally {
    if (handedOff) setTimeout(() => URL.revokeObjectURL(url), RECOVERY_KEY_URL_LIFETIME_MS);
    else URL.revokeObjectURL(url);
  }
}

/**
 * "Export recovery key": fetches the signed-in user's `/priv` data keys and
 * downloads them as a file. The key material exists only in the file and
 * the blob URL, which is revoked {@link RECOVERY_KEY_URL_LIFETIME_MS} after
 * the download is handed to the browser.
 */
export function useExportPrivRecoveryKey(): UseExportPrivRecoveryKeyResult {
  const [status, setStatus] = useState<ExportPrivRecoveryKeyStatus>('idle');

  const exportKey = async (): Promise<boolean> => {
    if (status === 'exporting') return false;
    setStatus('exporting');
    try {
      const result = await CommerceController.exportPrivRecoveryKey();
      if (result.kind !== 'file') {
        setStatus(result.kind);
        return false;
      }
      download(result.file);
      setStatus('exported');
      return true;
    } catch (error) {
      Logger.warn('Exporting the marketplace recovery key failed', privErrorSummary(error));
      setStatus('error');
      return false;
    }
  };

  return { isAvailable: isDurableCommerceMode(getCommerceAdapterMode()), status, exportKey };
}
