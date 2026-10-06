'use client';

import { type ReactNode } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import type {
  ConversationThreadItem,
  UseEncryptedConversationReturn,
} from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { MESSAGING_COPY, queuedSendFailedText } from '@/libs/commerce/messaging-copy';
import { cn } from '@/libs/utils/utils';

/**
 * Shared thread + composer for Encrypted Link conversations. Queued bubbles
 * stay labeled Queued (never sent), with the reason once a send of them
 * failed. The composer is always available: while
 * the handshake is pending, sends queue device-locally.
 */
export function EncryptedConversationBody({
  conversation,
  composerPlaceholder = 'Is this still available?',
  emptyPrompt = MESSAGING_COPY.listingEmptyThread,
  children,
}: {
  conversation: UseEncryptedConversationReturn;
  composerPlaceholder?: string;
  emptyPrompt?: string;
  children?: ReactNode;
}) {
  const overBudget = conversation.draftBytes > conversation.bodyBudgetBytes;

  return (
    <>
      <div aria-live="polite" className="max-h-80 space-y-3 overflow-y-auto rounded-xl border bg-card/50 p-4">
        {conversation.thread.length ? (
          conversation.thread.map((item) =>
            item.deliveryState === 'sent' ? (
              <SentThreadBubble key={item.message.id} item={item} />
            ) : (
              <QueuedThreadBubble key={item.queued.id} item={item} onCancel={conversation.cancelQueued} />
            ),
          )
        ) : (
          <Typography as="p" className="py-8 text-center text-sm text-muted-foreground">
            {emptyPrompt}
          </Typography>
        )}
      </div>

      {children}

      <div className="grid gap-1">
        <label htmlFor="encrypted-message-body" className="text-sm font-medium">
          Message
        </label>
        <textarea
          id="encrypted-message-body"
          rows={3}
          value={conversation.draft}
          onChange={(event) => conversation.setDraft(event.target.value)}
          placeholder={composerPlaceholder}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1"
        />
        {overBudget ? (
          <Typography as="p" overrideDefaults aria-live="polite" className="text-sm text-destructive">
            {MESSAGING_COPY.composerOverLimit}
          </Typography>
        ) : null}
      </div>

      {conversation.sendError && (
        <Typography as="p" role="alert" className="text-sm text-destructive">
          {conversation.sendError}
        </Typography>
      )}

      {conversation.firstContactNotice ? (
        <Typography as="p" role="status" className="text-sm text-muted-foreground">
          {conversation.firstContactNotice}
        </Typography>
      ) : null}

      {conversation.followOnSend ? (
        <Typography as="p" overrideDefaults className="text-sm text-muted-foreground" data-testid="follow-on-send">
          {MESSAGING_COPY.followOnSend}
        </Typography>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Typography as="p" overrideDefaults className="text-xs text-muted-foreground">
          {MESSAGING_COPY.noAttachments}
        </Typography>
        <Button
          className="rounded-full"
          onClick={() => void conversation.send()}
          disabled={conversation.isSending || !conversation.draft.trim() || overBudget}
          aria-busy={conversation.isSending}
        >
          {conversation.isSending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
          {conversation.isSending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </>
  );
}

function SentThreadBubble({ item }: { item: Extract<ConversationThreadItem, { deliveryState: 'sent' }> }) {
  const mine = item.message.direction === 'sent';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2 text-sm',
          mine ? 'bg-brand text-primary-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        <Typography as="p" overrideDefaults className="text-sm break-words whitespace-pre-wrap">
          {item.message.body}
        </Typography>
      </div>
    </div>
  );
}

function QueuedThreadBubble({
  item,
  onCancel,
}: {
  item: Extract<ConversationThreadItem, { deliveryState: 'queued' }>;
  onCancel: (id: string) => Promise<void>;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        <div className="rounded-2xl border border-dashed bg-secondary/50 px-4 py-2 text-sm text-secondary-foreground">
          <Typography as="p" overrideDefaults className="text-sm break-words whitespace-pre-wrap">
            {item.queued.body}
          </Typography>
        </div>
        {item.queued.last_error ? (
          <Typography as="p" role="status" overrideDefaults className="text-right text-xs text-muted-foreground">
            {queuedSendFailedText(item.queued.last_error)}
          </Typography>
        ) : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{MESSAGING_COPY.queued}</span>
          <button
            type="button"
            aria-label="Cancel queued message"
            onClick={() => void onCancel(item.queued.id)}
            className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
