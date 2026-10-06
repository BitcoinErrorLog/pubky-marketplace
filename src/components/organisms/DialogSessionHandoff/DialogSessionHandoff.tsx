'use client';

import { Button } from '@/atoms/Button/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { useSessionHandoff } from '@/hooks/useSessionHandoff/useSessionHandoff';
import { formatPublicKey, withPubkyPrefix } from '@/libs/utils/utils';

/**
 * Asks before a `#s=` link signs this tab in. Closing the dialog any way other
 * than Continue declines the hand-off.
 */
export function DialogSessionHandoff() {
  const { pendingPubky, accept, decline } = useSessionHandoff();
  if (!pendingPubky) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) decline();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="session-handoff-dialog">
        <DialogHeader className="pr-6">
          <DialogTitle>Continue as this account?</DialogTitle>
          <DialogDescription>
            The link you opened signs this browser in to the Shop. Continue only if you opened it from your own Pubky
            account.
          </DialogDescription>
        </DialogHeader>
        <Typography
          as="p"
          className="rounded-md bg-muted px-3 py-2 font-mono text-sm break-all"
          data-testid="session-handoff-pubky"
          title={withPubkyPrefix(pendingPubky)}
        >
          {formatPublicKey({ key: pendingPubky, length: 16, includePrefix: true })}
        </Typography>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={decline} data-testid="session-handoff-decline">
            Not me
          </Button>
          <Button onClick={accept} data-testid="session-handoff-accept">
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
