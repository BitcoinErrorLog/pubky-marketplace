'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';

export function useMarketplaceAttachmentUrl(attachmentId: string) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!currentUserPubky) return;
    let active = true;
    let objectUrl: string | null = null;
    CommerceController.fetchMarketplaceAttachment(attachmentId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, currentUserPubky]);

  return { url, error };
}
