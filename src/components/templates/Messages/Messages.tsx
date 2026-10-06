'use client';

import { LockKeyhole, MessageCircle, Store } from 'lucide-react';
import { getDmConversationRoute, getMarketplaceListingRoute } from '@/app/routes';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { useEncryptedInbox } from '@/hooks/useEncryptedInbox/useEncryptedInbox';
import { useGrantSigner } from '@/hooks/useGrantSigner/useGrantSigner';
import { useUserDetails } from '@/hooks/useUserDetails/useUserDetails';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { marketplaceCounterpartyLabel, MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { GrantSessionMessagingNotice } from '@/molecules/GrantSessionRefusal/GrantSessionRefusal';
import { AvatarWithFallback } from '@/organisms/AvatarWithFallback/AvatarWithFallback';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceEncryptedConversationDialog } from '@/organisms/Marketplace/MarketplaceEncryptedConversationDialog';
import { MarketplaceMessagingEnableDialog } from '@/organisms/Marketplace/MarketplaceMessagingEnableDialog';
import {
  isMuteListUnconfirmed,
  MessagingMutesNotice,
  MessagingRequests,
} from '@/organisms/Messaging/MessagingRequests';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * The general messages area (`/messages`): every encrypted conversation on
 * this device — direct messages keyed by counterparty and marketplace listing
 * conversations, each labeled with its context. Deliberately NOT gated on the
 * commerce adapter mode: encrypted messaging needs only a signed-in user, the
 * browser WASM binding, and the homeserver.
 */
export function Messages() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const inbox = useEncryptedInbox();
  const isGrantSignIn = useGrantSigner() !== null;

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-3xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6">
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Messages
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            End-to-end encrypted direct messages and listing conversations. History is stored on this device.
          </Typography>
        </div>

        {!currentUserPubky ? (
          <EmptyState
            title="Sign in to see your messages"
            body="Encrypted conversations belong to a signed-in account on this device."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {inbox.status === 'needs-enable' &&
              (isGrantSignIn ? (
                <GrantSessionMessagingNotice />
              ) : (
                <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5">
                  <div className="flex items-center gap-2">
                    <LockKeyhole className="size-5 text-muted-foreground" />
                    <Heading level={2} size="md">
                      {inbox.receiverProvisioned ? 'Reconnect encrypted messaging' : 'Enable encrypted messaging'}
                    </Heading>
                  </div>
                  <Typography as="p" className="text-sm text-muted-foreground">
                    {inbox.receiverProvisioned ? MESSAGING_COPY.inboxNeedsReconnect : MESSAGING_COPY.inboxNeedsEnable}
                  </Typography>
                  <MarketplaceMessagingEnableDialog reconnect={inbox.receiverProvisioned} onEnabled={inbox.refresh} />
                </div>
              ))}

            {inbox.status === 'error' && (
              <div className="flex flex-col items-start gap-3">
                <div role="alert" className="w-full rounded-xl border border-destructive/40 p-4">
                  {inbox.errorMessage}
                </div>
                <Button variant="secondary" className="rounded-full" onClick={inbox.refresh}>
                  Try again
                </Button>
              </div>
            )}

            <MessagingMutesNotice status={inbox.mutesStatus} onRetry={inbox.refresh} />

            {inbox.conversations.length ? (
              <div className="flex flex-col gap-3">
                <Typography as="p" className="text-xs text-muted-foreground">
                  End-to-end encrypted · history stored on this device · both sides must have enabled encrypted
                  messaging. The local storage includes the keys that decrypt it — clearing site data deletes both.
                </Typography>
                {inbox.conversations
                  .filter((conversation) => conversation.origin !== 'request')
                  .map((conversation) =>
                    conversation.kind === 'dm' ? (
                      <DmConversationRow key={conversation.id} conversation={conversation} />
                    ) : (
                      <ListingConversationRow key={conversation.id} conversation={conversation} />
                    ),
                  )}
                <MessagingRequests
                  requests={inbox.conversations.filter((conversation) => conversation.origin === 'request')}
                  canMute={isDurableCommerceMode(getCommerceAdapterMode())}
                  onChanged={inbox.refresh}
                />
              </div>
            ) : inbox.status === 'loading' ? (
              <Skeleton className="h-32 w-full" />
            ) : inbox.status === 'ready' && !isMuteListUnconfirmed(inbox.mutesStatus) ? (
              <EmptyState
                title="No messages yet"
                body="Open someone's profile and message them, or message a seller from a listing. Messages from people you don't know yet arrive under Requests."
              />
            ) : null}
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function conversationPreview(conversation: MessagingConversationSummary): string {
  const { lastMessage, lastQueued } = conversation;
  // The newest item can be a device-locally QUEUED message — say so instead
  // of pretending it was sent.
  if (lastQueued && (!lastMessage || lastQueued.queued_at > lastMessage.recorded_at)) {
    return `${MESSAGING_COPY.queued}: ${lastQueued.body}`;
  }
  return lastMessage
    ? `${lastMessage.direction === 'sent' ? 'You: ' : ''}${lastMessage.body}`
    : 'Conversation started — no messages yet';
}

/**
 * Device-local unread fact for one row: the last message was RECEIVED and
 * persisted after this conversation's read checkpoint.
 */
function hasUnread(conversation: MessagingConversationSummary): boolean {
  return Boolean(
    conversation.lastMessage &&
    conversation.lastMessage.direction === 'received' &&
    conversation.lastMessage.recorded_at > (conversation.last_read_at ?? 0),
  );
}

function RowTimestamp({ conversation }: { conversation: MessagingConversationSummary }) {
  if (!conversation.lastMessage) return null;
  return (
    <time dateTime={new Date(conversation.lastMessage.sent_at).toISOString()} className="text-xs text-muted-foreground">
      {new Date(conversation.lastMessage.sent_at).toLocaleDateString('en-US')}
    </time>
  );
}

function UnreadDot() {
  return <span aria-label="Unread messages" className="size-2.5 shrink-0 rounded-full bg-brand" />;
}

/** A direct-message thread — links to its own page, labeled with the counterparty. */
function DmConversationRow({ conversation }: { conversation: MessagingConversationSummary }) {
  const { userDetails } = useUserDetails(conversation.counterparty_pubky);
  const displayName = userDetails?.name?.trim() || 'Direct message';

  return (
    <Link href={getDmConversationRoute(conversation.counterparty_pubky)} overrideDefaults>
      <Card className="border py-4 transition-colors hover:border-brand/40">
        <CardContent className="flex items-center gap-4 px-4">
          <AvatarWithFallback
            avatarUrl={undefined}
            name={displayName}
            fallbackSeed={conversation.counterparty_pubky}
            size="lg"
            alt={displayName}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Typography as="p" className="truncate font-semibold">
                {displayName}
              </Typography>
              <Typography as="span" overrideDefaults className="text-xs text-muted-foreground uppercase">
                Direct message
              </Typography>
            </div>
            <Typography as="p" className="truncate text-sm text-muted-foreground">
              {conversationPreview(conversation)}
            </Typography>
          </div>
          {hasUnread(conversation) && <UnreadDot />}
          <RowTimestamp conversation={conversation} />
        </CardContent>
      </Card>
    </Link>
  );
}

/** A marketplace listing conversation — opens the proven dialog, labeled with its listing link. */
function ListingConversationRow({ conversation }: { conversation: MessagingConversationSummary }) {
  const parsed = parseConversationAggregateId(conversation.conversation_id);
  const { userDetails } = useUserDetails(conversation.counterparty_pubky);
  if (!parsed) return null;
  const listingRoute = getMarketplaceListingRoute(parsed.sellerPubky, parsed.listingId);
  const counterpartyLabel = marketplaceCounterpartyLabel({
    profileName: userDetails?.name,
    counterpartyIsSeller: conversation.counterparty_pubky === parsed.sellerPubky,
  });

  return (
    <MarketplaceEncryptedConversationDialog
      sellerPubky={parsed.sellerPubky}
      buyerPubky={parsed.buyerPubky}
      listingId={parsed.listingId}
      counterpartyPubky={conversation.counterparty_pubky}
      trigger={
        <button type="button" className="w-full text-left" aria-label="Open encrypted listing conversation">
          <Card className="border py-4 transition-colors hover:border-brand/40">
            <CardContent className="flex items-center gap-4 px-4">
              <div className="rounded-full bg-brand/15 p-3 text-brand">
                <Store className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Typography as="p" className="truncate font-semibold">
                    {counterpartyLabel}
                  </Typography>
                  <Link
                    href={listingRoute}
                    overrideDefaults
                    className="text-xs text-muted-foreground uppercase underline-offset-2 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Listing conversation
                  </Link>
                </div>
                <Typography as="p" className="truncate text-sm text-muted-foreground">
                  {conversationPreview(conversation)}
                </Typography>
              </div>
              {hasUnread(conversation) && <UnreadDot />}
              <RowTimestamp conversation={conversation} />
            </CardContent>
          </Card>
        </button>
      }
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
      <MessageCircle className="mb-3 size-10 text-muted-foreground" />
      <Heading level={2} size="md">
        {title}
      </Heading>
      <Typography as="p" className="mt-2 max-w-lg text-muted-foreground">
        {body}
      </Typography>
    </div>
  );
}
