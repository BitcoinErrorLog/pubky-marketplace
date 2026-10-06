'use client';

import { useState } from 'react';
import { digitalFileTooLargeCopy } from '@/libs/commerce/digital';

/** The first-release file cap (`DIGITAL_DELIVERY_MAX_BYTES`) when the service does not report one. */
export const DIGITAL_FILE_DEFAULT_MAX_BYTES = 52_428_800;

export interface UseDigitalFilePickerResult {
  file: File | null;
  error: string | null;
  /** Takes the chosen file (or none), refusing one over the deployment's cap or an empty one. */
  choose: (file: File | null) => void;
  reset: () => void;
}

/**
 * The seller's chosen deliverable file (digital delivery design §2 "Size").
 * The file stays a browser `File` until the save encrypts it; nothing is
 * read, stored or previewed here.
 */
export function useDigitalFilePicker(maxBytes: number | null): UseDigitalFilePickerResult {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cap = maxBytes ?? DIGITAL_FILE_DEFAULT_MAX_BYTES;

  const choose = (next: File | null) => {
    if (!next) {
      setFile(null);
      setError(null);
      return;
    }
    if (next.size > cap) {
      setFile(null);
      setError(digitalFileTooLargeCopy(cap));
      return;
    }
    if (next.size === 0) {
      setFile(null);
      setError('Choose a file that is not empty.');
      return;
    }
    setFile(next);
    setError(null);
  };

  const reset = () => {
    setFile(null);
    setError(null);
  };

  return { file, error, choose, reset };
}
