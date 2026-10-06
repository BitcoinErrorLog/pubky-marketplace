'use client';

import { useEffect, useState } from 'react';
import { AuthController } from '@/controllers/auth/auth';

/**
 * Whether this browser can offer the Bitkit grant sign-in. Read after mount:
 * the check needs `window` (secure context, IndexedDB, WebCrypto).
 */
export function useGrantSignInAvailable(): boolean {
  const [isAvailable, setIsAvailable] = useState(false);
  useEffect(() => {
    setIsAvailable(AuthController.isGrantSignInAvailable());
  }, []);
  return isAvailable;
}
