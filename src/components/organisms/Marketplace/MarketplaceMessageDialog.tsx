'use client';

import { useState } from 'react';
import { ImagePlus, MessageCircle, Send, Trash2 } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { useMarketplaceMessages } from '@/hooks/useMarketplaceMessages/useMarketplaceMessages';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { cn } from '@/libs/utils/utils';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceEncryptedConversationDialog } from './MarketplaceEncryptedConversationDialog';
import { MarketplaceMessageAttachment } from './MarketplaceMessageAttachment';

export function MarketplaceMessageDialog({ sellerPubky, listingId }: { sellerPubky: string; listingId: string }) {
  const [open, setOpen] = useState(false);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { requireAuth } = useRequireAuth();
  const messages = useMarketplaceMessages(sellerPubky, listingId);
  const { previewUrl, error: attachmentError, inputRef, onInputChange, choose, remove } = messages.attachment;
  const isSeller = Boolean(currentUserPubky && currentUserPubky === sellerPubky);

  const submit = async () => {
    await messages.submit();
  };

  // Durable modes carry real end-to-end-encrypted messaging over Paykit
  // Encrypted Links. The buyer is the signed-in user; a signed-out visitor
  // gets the auth prompt on open, so a placeholder buyer id is never used to
  // derive a conversation.
  if (isDurableCommerceMode(getCommerceAdapterMode())) {
    if (!currentUserPubky || isSeller) {
      return (
        <div>
          <Button
            variant="secondary"
            size="sm"
            className="w-full rounded-full"
            disabled={isSeller}
            onClick={() => requireAuth(() => undefined)}
          >
            <MessageCircle className="size-4" />
            {MESSAGING_COPY.listingCta}
          </Button>
          {isSeller && (
            <Typography as="p" className="mt-2 text-center text-xs text-muted-foreground">
              {MESSAGING_COPY.listingOwn}
            </Typography>
          )}
        </div>
      );
    }
    return (
      <MarketplaceEncryptedConversationDialog
        sellerPubky={sellerPubky}
        buyerPubky={currentUserPubky}
        listingId={listingId}
        counterpartyPubky={sellerPubky}
        trigger={
          <Button variant="secondary" size="sm" className="w-full rounded-full">
            <MessageCircle className="size-4" />
            {MESSAGING_COPY.listingCta}
          </Button>
        }
      />
    );
  }

  // Modes with no transactional backend at all keep the honest dead end.
  if (!messages.isSandbox) {
    return (
      <div>
        <Button variant="secondary" size="sm" className="w-full rounded-full" disabled>
          <MessageCircle className="size-4" />
          {MESSAGING_COPY.listingCta}
        </Button>
        <Typography as="p" className="mt-2 text-center text-xs text-muted-foreground">
          {MESSAGING_COPY.unavailable}
        </Typography>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false);
          return;
        }
        requireAuth(() => setOpen(true));
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="w-full rounded-full"
          disabled={Boolean(currentUserPubky && currentUserPubky === sellerPubky)}
        >
          <MessageCircle className="size-4" />
          {MESSAGING_COPY.listingCta}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Listing conversation</DialogTitle>
        </DialogHeader>
        <Typography as="p" className="text-xs text-muted-foreground">
          {MESSAGING_COPY.sandboxWarning}
        </Typography>
        <div aria-live="polite" className="max-h-80 space-y-3 overflow-y-auto rounded-md bg-card/50 p-6">
          {messages.conversation?.messages.length ? (
            messages.conversation.messages.map((message) => {
              const mine = message.senderPubky === currentUserPubky;
              return (
                <div key={message.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-2 text-sm',
                      mine ? 'bg-brand text-primary-foreground' : 'bg-secondary text-secondary-foreground',
                    )}
                  >
                    <Typography as="p" overrideDefaults className="text-sm">
                      {message.text}
                    </Typography>
                    {message.attachments.map((attachment) => (
                      <div key={attachment.id} className="mt-2">
                        <MarketplaceMessageAttachment attachment={attachment} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <Typography as="p" className="py-8 text-center text-sm text-muted-foreground">
              {MESSAGING_COPY.listingEmptyThread}
            </Typography>
          )}
        </div>
        <ControlledTextareaField
          name="text"
          control={messages.form.control}
          label="Message"
          placeholder="Is this still available?"
          rows={3}
        />
        <div className="flex items-center gap-3">
          {previewUrl ? (
            <div
              role="img"
              className="h-20 w-24 rounded-lg bg-cover bg-center"
              style={{ backgroundImage: `url(${previewUrl})` }}
              aria-label="Selected private image attachment"
            />
          ) : null}
          <Button type="button" size="sm" variant="secondary" className="rounded-full" onClick={choose}>
            <ImagePlus className="size-4" />
            Add image
          </Button>
          {previewUrl ? (
            <Button type="button" size="icon" variant="ghost" aria-label="Remove attachment" onClick={remove}>
              <Trash2 className="size-4" />
            </Button>
          ) : null}
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onInputChange} />
        </div>
        {attachmentError && (
          <Typography as="p" role="alert" className="text-sm text-destructive">
            {attachmentError === 'invalid-type'
              ? 'Choose a JPEG, PNG, or WebP image.'
              : attachmentError === 'too-large'
                ? 'Image is too large.'
                : 'Image could not be prepared securely.'}
          </Typography>
        )}
        {messages.error && (
          <Typography as="p" role="alert" className="text-sm text-destructive">
            {messages.error}
          </Typography>
        )}
        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button className="rounded-full" onClick={submit}>
            <Send className="size-4" />
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
