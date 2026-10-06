'use client';

import { useState } from 'react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Input } from '@/atoms/Input/Input';
import { Typography } from '@/atoms/Typography/Typography';
import { copyToClipboard } from '@/libs/utils/utils';

export const WEBHOOK_SECRET_COPY = 'Copy this secret now. It cannot be shown again.';

export function MarketplaceInventoryOnceSecretDialog({
  open,
  secret,
  message = WEBHOOK_SECRET_COPY,
  onClose,
}: {
  open: boolean;
  secret: string;
  message?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="border-border bg-popover"
        data-surface="inventory-studio"
        data-testid="inventory-once-secret"
      >
        <DialogHeader>
          <DialogTitle>Webhook secret</DialogTitle>
        </DialogHeader>
        <Typography as="p" className="text-sm text-muted-foreground">
          {message}
        </Typography>
        <Input type="password" readOnly value={secret} aria-label="Webhook secret" autoComplete="off" />
        <DialogFooter>
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={async () => {
              await copyToClipboard({ text: secret });
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button className="rounded-full" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
