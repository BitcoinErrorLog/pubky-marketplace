'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LockKeyhole, MessageCircle } from 'lucide-react';
import { APP_ROUTES, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
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
import { useMarketplaceInbox } from '@/hooks/useMarketplaceInbox/useMarketplaceInbox';
import { useUserDetails } from '@/hooks/useUserDetails/useUserDetails';
import {
  reportRejectedConversationQuery,
  resolveMarketplaceConversationQuery,
} from '@/libs/commerce/marketplace-conversation-query';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { marketplaceCounterpartyLabel, MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { buildMarketplaceConversationAggregateId } from '@/libs/commerce/transaction-commands';
import { GrantSessionMessagingNotice } from '@/molecules/GrantSessionRefusal/GrantSessionRefusal';
import { MarketplaceEmptyState } from '@/molecules/Marketplace/MarketplaceEmptyState';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceEncryptedConversationDialog } from '@/organisms/Marketplace/MarketplaceEncryptedConversationDialog';
import { MarketplaceMessagingEnableDialog } from '@/organisms/Marketplace/MarketplaceMessagingEnableDialog';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import {
  isMuteListUnconfirmed,
  MessagingMutesNotice,
  MessagingRequests,
} from '@/organisms/Messaging/MessagingRequests';
import { useAuthStore } from '@/stores/auth/auth.store';

export function MarketplaceInbox() {
  const encrypted = isDurableCommerceMode(getCommerceAdapterMode());

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6" data-surface="marketplace-inbox">
        <MarketplaceSectionNav />
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Messages
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {encrypted ? 'Your conversations with buyers and sellers.' : MESSAGING_COPY.sandboxWarning}
          </Typography>
        </div>

        {encrypted ? <EncryptedInbox /> : <SandboxInbox />}
      </Container>
    </ContentLayout>
  );
}

function useConsumedConversationQuery(currentUserPubky: string | null | undefined) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [capturedValues] = useState(() => searchParams.getAll('conversation'));

  useEffect(() => {
    if (searchParams.getAll('conversation').length === 0) return;
    router.replace(MARKETPLACE_ROUTES.MESSAGES);
  }, [router, searchParams]);

  return resolveMarketplaceConversationQuery({
    values: capturedValues,
    currentUserPubky,
  });
}

function EncryptedInbox() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const inbox = useEncryptedInbox();
  const isGrantSignIn = useGrantSigner() !== null;
  const query = useConsumedConversationQuery(currentUserPubky);
  const reportedRejection = useRef(false);

  useEffect(() => {
    if (query.status === 'invalid' || query.status === 'other-account') {
      if (!reportedRejection.current) {
        reportedRejection.current = true;
        reportRejectedConversationQuery();
      }
      return;
    }
    reportedRejection.current = false;
  }, [query.status]);

  const openQuery = query.status === 'open' ? query : null;
  const openConversationId = openQuery
    ? buildMarketplaceConversationAggregateId(openQuery.sellerPubky, openQuery.buyerPubky, openQuery.listingId)
    : null;
  const listingConversations = inbox.conversations.filter((conversation) =>
    parseConversationAggregateId(conversation.conversation_id),
  );
  const inboxRows = listingConversations.filter((conversation) => conversation.origin !== 'request');
  const requestRows = listingConversations.filter((conversation) => conversation.origin === 'request');
  const matchingOpenRow = openConversationId
    ? inboxRows.some((conversation) => conversation.conversation_id === openConversationId)
    : false;

  if (!currentUserPubky && query.status !== 'invalid' && query.status !== 'other-account') {
    return <EmptyState title={MESSAGING_COPY.inboxSignedOutTitle} body={MESSAGING_COPY.inboxSignedOutBody} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {query.status === 'invalid' && (
        <div role="alert" className="rounded-md border border-destructive/40 p-4">
          {MESSAGING_COPY.deepLinkInvalid}
        </div>
      )}
      {query.status === 'other-account' && (
        <div role="alert" className="rounded-md border border-destructive/40 p-4">
          {MESSAGING_COPY.deepLinkOtherAccount}
        </div>
      )}

      {openQuery && !matchingOpenRow && (
        <MarketplaceEncryptedConversationDialog
          sellerPubky={openQuery.sellerPubky}
          buyerPubky={openQuery.buyerPubky}
          listingId={openQuery.listingId}
          counterpartyPubky={currentUserPubky === openQuery.sellerPubky ? openQuery.buyerPubky : openQuery.sellerPubky}
          defaultOpen
          trigger={
            <button type="button" className="sr-only">
              Open conversation
            </button>
          }
        />
      )}

      {inbox.status === 'error' && (
        <div className="flex flex-col items-start gap-3">
          <div role="alert" className="w-full rounded-md border border-destructive/40 p-4">
            {inbox.errorMessage}
          </div>
          <Button variant="secondary" className="rounded-full" onClick={inbox.refresh}>
            {MESSAGING_COPY.inboxRetry}
          </Button>
        </div>
      )}

      {inboxRows.length || requestRows.length ? (
        <div className="flex flex-col gap-6">
          {inboxRows.map((conversation) => (
            <EncryptedConversationRow
              key={conversation.id}
              conversation={conversation}
              defaultOpen={Boolean(openConversationId && conversation.conversation_id === openConversationId)}
            />
          ))}
          <MessagingRequests requests={requestRows} canMute onChanged={inbox.refresh} />
        </div>
      ) : inbox.status === 'loading' ? (
        <Skeleton className="h-32 w-full" />
      ) : inbox.status === 'ready' && !isMuteListUnconfirmed(inbox.mutesStatus) ? (
        <EmptyState title="No messages yet" body={MESSAGING_COPY.inboxEmptyBody} />
      ) : inbox.status !== 'error' && inbox.mutesStatus !== 'error' ? (
        <EmptyState title="Your conversations appear here" body={MESSAGING_COPY.inboxEmptyBody} />
      ) : null}

      {inbox.status === 'needs-enable' &&
        (isGrantSignIn ? (
          <GrantSessionMessagingNotice />
        ) : (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <Typography as="p" className="text-sm text-muted-foreground">
              Authorize to send and receive messages.
            </Typography>
            <MarketplaceMessagingEnableDialog
              reconnect={inbox.receiverProvisioned}
              onEnabled={inbox.refresh}
              triggerVariant="outline"
            />
          </div>
        ))}

      {inbox.status !== 'needs-enable' && (
        <MessagingMutesNotice status={inbox.mutesStatus} onRetry={inbox.refresh} compact />
      )}
    </div>
  );
}

function EncryptedConversationRow({
  conversation,
  defaultOpen,
}: {
  conversation: MessagingConversationSummary;
  defaultOpen: boolean;
}) {
  const parsed = parseConversationAggregateId(conversation.conversation_id);
  const { userDetails } = useUserDetails(conversation.counterparty_pubky);
  if (!parsed) return null;
  const { lastMessage, lastQueued } = conversation;
  const preview =
    lastQueued && (!lastMessage || lastQueued.queued_at > lastMessage.recorded_at)
      ? `${MESSAGING_COPY.queued}: ${lastQueued.body}`
      : lastMessage
        ? `${lastMessage.direction === 'sent' ? 'You: ' : ''}${lastMessage.body}`
        : '';
  const unread = Boolean(
    lastMessage && lastMessage.direction === 'received' && lastMessage.recorded_at > (conversation.last_read_at ?? 0),
  );
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
      defaultOpen={defaultOpen}
      trigger={
        <button type="button" className="w-full text-left" aria-label={`Open conversation with ${counterpartyLabel}`}>
          <Card className="rounded-md p-0 transition-colors hover:bg-muted">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-full bg-brand/15 p-3 text-brand">
                <LockKeyhole className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <Typography as="p" className="font-semibold">
                  {counterpartyLabel}
                </Typography>
                {preview ? (
                  <Typography as="p" className="truncate text-sm text-muted-foreground">
                    {preview}
                  </Typography>
                ) : null}
              </div>
              {unread ? (
                <span aria-label="Unread messages" className="size-2.5 shrink-0 rounded-full bg-brand" />
              ) : null}
              {conversation.lastMessage && (
                <time
                  dateTime={new Date(conversation.lastMessage.sent_at).toISOString()}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {new Date(conversation.lastMessage.sent_at).toLocaleDateString('en-US')}
                </time>
              )}
            </CardContent>
          </Card>
        </button>
      }
    />
  );
}

function SandboxInbox() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { conversations, isLoading, error, isSandbox } = useMarketplaceInbox();
  const query = useConsumedConversationQuery(currentUserPubky);
  const reportedRejection = useRef(false);

  useEffect(() => {
    if (query.status === 'invalid' || query.status === 'other-account') {
      if (!reportedRejection.current) {
        reportedRejection.current = true;
        reportRejectedConversationQuery();
      }
      return;
    }
    reportedRejection.current = false;
  }, [query.status]);

  if (!isSandbox) {
    return <EmptyState title={MESSAGING_COPY.unavailable} body="" />;
  }

  if (!currentUserPubky && query.status !== 'invalid' && query.status !== 'other-account') {
    return <EmptyState title={MESSAGING_COPY.inboxSignedOutTitle} body={MESSAGING_COPY.inboxSignedOutBody} />;
  }

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-destructive/40 p-4">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {query.status === 'invalid' && (
        <div role="alert" className="rounded-md border border-destructive/40 p-4">
          {MESSAGING_COPY.deepLinkInvalid}
        </div>
      )}
      {query.status === 'other-account' && (
        <div role="alert" className="rounded-md border border-destructive/40 p-4">
          {MESSAGING_COPY.deepLinkOtherAccount}
        </div>
      )}
      {!conversations.length ? (
        <EmptyState title="No messages yet" body={MESSAGING_COPY.inboxEmptyBody} />
      ) : (
        conversations.map((conversation) => {
          const last = conversation.messages.at(-1);
          const counterpart =
            currentUserPubky === conversation.sellerPubky ? conversation.buyerPubky : conversation.sellerPubky;
          const listingRoute = listingRouteFromAggregate(conversation.listingAggregateId);
          const counterpartyIsSeller = counterpart === conversation.sellerPubky;
          return (
            <SandboxConversationRow
              key={conversation.id}
              href={listingRoute}
              counterpart={counterpart}
              counterpartyIsSeller={counterpartyIsSeller}
              preview={last?.text ?? ''}
              timestamp={last?.createdAt}
            />
          );
        })
      )}
    </div>
  );
}

function SandboxConversationRow({
  href,
  counterpart,
  counterpartyIsSeller,
  preview,
  timestamp,
}: {
  href: string;
  counterpart: string;
  counterpartyIsSeller: boolean;
  preview: string;
  timestamp?: string;
}) {
  const { userDetails } = useUserDetails(counterpart);
  const label = marketplaceCounterpartyLabel({
    profileName: userDetails?.name,
    counterpartyIsSeller,
  });

  return (
    <Link href={href} overrideDefaults>
      <Card className="rounded-md p-0 transition-colors hover:bg-muted">
        <CardContent className="flex items-center gap-4 p-6">
          <div className="rounded-full bg-brand/15 p-3 text-brand">
            <MessageCircle className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Typography as="p" className="font-semibold">
              {label}
            </Typography>
            {preview ? (
              <Typography as="p" className="truncate text-sm text-muted-foreground">
                {preview}
              </Typography>
            ) : null}
          </div>
          <time dateTime={timestamp} className="text-xs font-medium text-muted-foreground">
            {timestamp ? new Date(timestamp).toLocaleDateString('en-US') : ''}
          </time>
        </CardContent>
      </Card>
    </Link>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <MarketplaceEmptyState icon={MessageCircle} title={title} description={body} />;
}

function listingRouteFromAggregate(aggregateId: string): string {
  const value = aggregateId.startsWith('listing:') ? aggregateId.slice('listing:'.length) : '';
  const sellerPubky = value.slice(0, 52);
  const listingId = value.slice(53);
  return sellerPubky && listingId ? getMarketplaceListingRoute(sellerPubky, listingId) : APP_ROUTES.MARKETPLACE;
}
