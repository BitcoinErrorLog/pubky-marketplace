'use client';

import { KeyRound } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';

export const REVOKE_SESSION_COPY = 'This ends the session on the service and drops the matching slot on this device.';

export function MarketplaceInventoryRevokeDialog({
  open,
  onClose,
  onConfirm,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending?: boolean;
}) {
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
        data-testid="inventory-revoke-confirm"
      >
        <DialogHeader>
          <DialogTitle>Revoke session</DialogTitle>
        </DialogHeader>
        <Typography as="p" className="text-sm text-muted-foreground">
          {REVOKE_SESSION_COPY}
        </Typography>
        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" className="rounded-full" onClick={onConfirm} disabled={pending}>
            <KeyRound className="mr-2 size-4" />
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
