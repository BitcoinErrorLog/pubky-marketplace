'use client';

import { Image } from '@/atoms/Image/Image';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceAttachmentUrl } from '@/hooks/useMarketplaceAttachmentUrl/useMarketplaceAttachmentUrl';
import type { MarketplaceConversation } from '@/services/marketplace/marketplace';

type Attachment = MarketplaceConversation['messages'][number]['attachments'][number];

export function MarketplaceMessageAttachment({ attachment }: { attachment: Attachment }) {
  const { url, error } = useMarketplaceAttachmentUrl(attachment.id);

  if (error) {
    return (
      <Typography as="span" className="text-xs text-muted-foreground">
        Attachment unavailable
      </Typography>
    );
  }
  if (!url) return <Skeleton className="h-32 w-48 rounded-xl" />;

  return (
    <Image
      src={url}
      alt="Private marketplace message attachment"
      width={320}
      height={240}
      className="max-h-60 rounded-xl object-cover"
    />
  );
}
