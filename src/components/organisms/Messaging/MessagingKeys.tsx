'use client';

import { useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import type { EncryptedConversationKeyChange } from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { formatMessagingKey } from '@/hooks/useEncryptedConversation/useEncryptedConversation.utils';
import { useMessagingKeys } from '@/hooks/useMessagingKeys/useMessagingKeys';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';

function KeyLine({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-0.5">
      <Typography as="p" overrideDefaults className="text-xs font-medium text-muted-foreground">
        {label}
      </Typography>
      <Typography as="p" overrideDefaults className="font-mono text-sm break-words">
        {value ? formatMessagingKey(value) : MESSAGING_COPY.messagingKeysNone}
      </Typography>
    </div>
  );
}

/**
 * This device's messaging key and the key pinned for the other person, so
 * both can compare them through a channel they already trust.
 */
export function MessagingKeysPanel({ counterpartyPubky }: { counterpartyPubky: string }) {
  const { keys, status } = useMessagingKeys(counterpartyPubky, true);

  return (
    <div className="grid gap-3 rounded-xl border p-4" data-testid="messaging-keys">
      <Typography as="p" className="text-sm text-muted-foreground">
        {MESSAGING_COPY.messagingKeysHelp}
      </Typography>
      {status === 'ready' && keys ? (
        <>
          <KeyLine label={MESSAGING_COPY.messagingKeysYours} value={keys.ownKey} />
          <KeyLine label={MESSAGING_COPY.messagingKeysTheirs} value={keys.pinnedKey} />
        </>
      ) : null}
      {status === 'error' ? (
        <Typography as="p" role="alert" className="text-sm text-destructive">
          {MESSAGING_COPY.inboxSyncFailed}
        </Typography>
      ) : null}
    </div>
  );
}

/** Toggle for {@link MessagingKeysPanel}, shown with a conversation's other options. */
export function MessagingKeysToggle({ counterpartyPubky }: { counterpartyPubky: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <KeyRound className="mr-1.5 size-4" aria-hidden />
        {MESSAGING_COPY.messagingKeys}
      </Button>
      {open ? (
        <div className="basis-full">
          <MessagingKeysPanel counterpartyPubky={counterpartyPubky} />
        </div>
      ) : null}
    </>
  );
}

/**
 * Shown while a conversation is held because the other person now publishes
 * a different messaging key than the one pinned on this device. Nothing is
 * sent until the user accepts; Verify shows both keys for comparison first.
 */
export function MessagingKeyChangedNotice({
  keyChange,
  onAccept,
  isAccepting,
}: {
  keyChange: EncryptedConversationKeyChange;
  onAccept: () => void;
  isAccepting: boolean;
}) {
  const [verifying, setVerifying] = useState(false);

  return (
    <div
      role="alert"
      className="grid gap-3 rounded-xl border border-destructive/40 p-4"
      data-testid="messaging-key-changed"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="grid gap-1">
          <Typography as="p" overrideDefaults className="text-sm font-semibold">
            {MESSAGING_COPY.keyChangedTitle}
          </Typography>
          <Typography as="p" overrideDefaults className="text-sm text-muted-foreground">
            {MESSAGING_COPY.keyChangedBody}
          </Typography>
        </div>
      </div>
      {verifying ? (
        <div className="grid gap-3 rounded-lg border p-3" data-testid="messaging-key-verify">
          <Typography as="p" overrideDefaults className="text-sm text-muted-foreground">
            {MESSAGING_COPY.keyChangedVerifyHelp}
          </Typography>
          <KeyLine label={MESSAGING_COPY.keyChangedNewKey} value={keyChange.observedKey} />
          <KeyLine label={MESSAGING_COPY.keyChangedPreviousKey} value={keyChange.pinnedKey} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          aria-expanded={verifying}
          onClick={() => setVerifying((value) => !value)}
        >
          {verifying ? MESSAGING_COPY.keyChangedHideVerify : MESSAGING_COPY.keyChangedVerify}
        </Button>
        <Button
          type="button"
          className="rounded-full"
          disabled={isAccepting}
          aria-busy={isAccepting}
          onClick={onAccept}
        >
          {MESSAGING_COPY.keyChangedAccept}
        </Button>
      </div>
    </div>
  );
}
