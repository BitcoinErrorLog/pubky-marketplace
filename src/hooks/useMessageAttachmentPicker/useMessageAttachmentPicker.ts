'use client';

import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { IMAGE_MAX_RAW_SIZE, IMAGE_MAX_UPLOAD_SIZE } from '@/config/images';
import { CommerceController } from '@/controllers/commerce/commerce';
import { stripImageMetadata } from '@/libs/image/stripImageMetadata';
import type { MarketplaceAttachmentMetadata } from '@/services/marketplace/marketplace';

export type MessageAttachmentPickerError = 'invalid-type' | 'too-large' | 'processing-failed';

export function useMessageAttachmentPicker() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<MessageAttachmentPickerError | null>(null);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const remove = () => {
    setFile(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    if (!selected) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) {
      setError('invalid-type');
      return;
    }
    if (selected.size > IMAGE_MAX_RAW_SIZE) {
      setError('too-large');
      return;
    }
    remove();
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const upload = async (recipientPubky: string): Promise<MarketplaceAttachmentMetadata | null> => {
    if (!file) return null;
    try {
      const sanitized = await stripImageMetadata(file);
      if (sanitized.size > IMAGE_MAX_UPLOAD_SIZE) {
        setError('too-large');
        return null;
      }
      const attachment = await CommerceController.uploadMarketplaceAttachment(recipientPubky, sanitized);
      setError(null);
      return attachment;
    } catch {
      setError('processing-failed');
      return null;
    }
  };

  return {
    file,
    previewUrl,
    error,
    inputRef,
    onInputChange,
    choose: () => inputRef.current?.click(),
    remove,
    reset: remove,
    upload,
  };
}
