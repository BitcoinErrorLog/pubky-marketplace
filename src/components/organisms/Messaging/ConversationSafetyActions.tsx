'use client';

import { BellOff, Flag, VolumeX } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { useMessagingSafety } from '@/hooks/useMessagingSafety/useMessagingSafety';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { MessagingKeysToggle } from './MessagingKeys';

/**
 * Mute, Report and Messaging keys for one conversation. Mute is saved in the
 * account's private mute list; Report only copies details to the clipboard;
 * Messaging keys shows both keys for comparison out of band.
 */
export function ConversationSafetyActions({
  counterpartyPubky,
  conversationId,
  counterpartyLabel,
  canMute,
  onMuted,
}: {
  counterpartyPubky: string;
  conversationId: string;
  counterpartyLabel: string;
  /** False where this Shop has no private storage for mutes. */
  canMute: boolean;
  onMuted: () => void;
}) {
  const safety = useMessagingSafety();

  return (
    <div
      role="group"
      aria-label={MESSAGING_COPY.conversationActions}
      className="flex flex-wrap items-center gap-2"
      data-testid="conversation-safety-actions"
    >
      {canMute ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-full text-muted-foreground"
          disabled={safety.isPending}
          aria-label={`${MESSAGING_COPY.mute} ${counterpartyLabel}`}
          onClick={async () => {
            if (await safety.mute(counterpartyPubky)) onMuted();
          }}
        >
          <VolumeX className="mr-1.5 size-4" aria-hidden />
          {MESSAGING_COPY.mute}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        aria-label={`${MESSAGING_COPY.report} ${counterpartyLabel}`}
        onClick={() => void safety.report(conversationId)}
      >
        <Flag className="mr-1.5 size-4" aria-hidden />
        {MESSAGING_COPY.report}
      </Button>
      <MessagingKeysToggle counterpartyPubky={counterpartyPubky} />
    </div>
  );
}

/** What a muted conversation shows instead of the thread: the fact and the way back. */
export function MutedConversationPanel({
  counterpartyPubky,
  counterpartyLabel,
  onUnmuted,
}: {
  counterpartyPubky: string;
  counterpartyLabel: string;
  onUnmuted: () => void;
}) {
  const safety = useMessagingSafety();

  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center"
      data-testid="muted-conversation"
    >
      <BellOff className="size-8 text-muted-foreground" aria-hidden />
      <Typography as="p" role="status" className="text-sm text-muted-foreground">
        {MESSAGING_COPY.mutedThread}
      </Typography>
      <Button
        type="button"
        variant="secondary"
        className="rounded-full"
        disabled={safety.isPending}
        aria-label={`${MESSAGING_COPY.unmute} ${counterpartyLabel}`}
        onClick={async () => {
          if (await safety.unmute(counterpartyPubky)) onUnmuted();
        }}
      >
        {MESSAGING_COPY.unmute}
      </Button>
    </div>
  );
}
