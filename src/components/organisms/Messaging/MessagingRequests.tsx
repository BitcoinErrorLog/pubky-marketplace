'use client';

import { UserRound } from 'lucide-react';
import { getDmConversationRoute } from '@/app/routes';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useMessagingSafety } from '@/hooks/useMessagingSafety/useMessagingSafety';
import { useUserDetails } from '@/hooks/useUserDetails/useUserDetails';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { marketplaceCounterpartyLabel, MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { MarketplaceEncryptedConversationDialog } from '@/organisms/Marketplace/MarketplaceEncryptedConversationDialog';
import { MarketplaceReauthDialog } from '@/organisms/Marketplace/MarketplaceReauthDialog';

/**
 * Conversations from people the account does not know yet. They never show
 * an unread dot. Each can be opened and read, accepted into the inbox, or
 * muted.
 */
export function MessagingRequests({
  requests,
  canMute,
  onChanged,
}: {
  requests: MessagingConversationSummary[];
  canMute: boolean;
  onChanged: () => void;
}) {
  if (requests.length === 0) return null;
  return (
    <section aria-label={MESSAGING_COPY.requestsTitle} className="flex flex-col gap-3" data-testid="messaging-requests">
      <div>
        <Heading level={2} size="md">
          {MESSAGING_COPY.requestsTitle}
        </Heading>
        <Typography as="p" className="mt-1 text-sm text-muted-foreground">
          {MESSAGING_COPY.requestsBody}
        </Typography>
      </div>
      {requests.map((request) => (
        <MessagingRequestRow key={request.id} request={request} canMute={canMute} onChanged={onChanged} />
      ))}
    </section>
  );
}

function MessagingRequestRow({
  request,
  canMute,
  onChanged,
}: {
  request: MessagingConversationSummary;
  canMute: boolean;
  onChanged: () => void;
}) {
  const safety = useMessagingSafety();
  const { userDetails } = useUserDetails(request.counterparty_pubky);
  const listing = parseConversationAggregateId(request.conversation_id);
  const label = listing
    ? marketplaceCounterpartyLabel({
        profileName: userDetails?.name,
        counterpartyIsSeller: request.counterparty_pubky === listing.sellerPubky,
      })
    : userDetails?.name?.trim() || MESSAGING_COPY.thisBuyer;
  const preview = request.lastMessage?.body ?? MESSAGING_COPY.requestPreview;

  const summary = (
    <div className="flex min-w-0 flex-1 items-center gap-4">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <UserRound className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <Typography as="p" className="font-semibold">
          {label}
        </Typography>
        <Typography as="p" className="truncate text-sm text-muted-foreground">
          {preview}
        </Typography>
      </div>
    </div>
  );

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center">
        {listing ? (
          <MarketplaceEncryptedConversationDialog
            sellerPubky={listing.sellerPubky}
            buyerPubky={listing.buyerPubky}
            listingId={listing.listingId}
            counterpartyPubky={request.counterparty_pubky}
            trigger={
              <button type="button" className="min-w-0 flex-1 text-left" aria-label={`Open request from ${label}`}>
                {summary}
              </button>
            }
          />
        ) : (
          <Link
            href={getDmConversationRoute(request.counterparty_pubky)}
            overrideDefaults
            className="min-w-0 flex-1"
            aria-label={`Open request from ${label}`}
          >
            {summary}
          </Link>
        )}
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={safety.isPending}
            aria-label={`${MESSAGING_COPY.requestAccept} ${label}`}
            onClick={async () => {
              if (await safety.accept(request.counterparty_pubky)) onChanged();
            }}
          >
            {MESSAGING_COPY.requestAccept}
          </Button>
          {canMute ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={safety.isPending}
              aria-label={`${MESSAGING_COPY.mute} ${label}`}
              onClick={async () => {
                if (await safety.mute(request.counterparty_pubky)) onChanged();
              }}
            >
              {MESSAGING_COPY.mute}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Whether a mute read outcome leaves the list unconfirmed (nothing is listed or received then). */
export function isMuteListUnconfirmed(status: string | null | undefined): boolean {
  return status === 'needs_approval' || status === 'needs_reauth' || status === 'error';
}

/**
 * Shown while the mute list cannot be confirmed, so nothing is received or
 * listed: approval states offer the approval, other failures a retry.
 */
export function MessagingMutesNotice({
  status,
  onRetry,
  compact = false,
}: {
  status: 'ready' | 'unavailable' | 'needs_approval' | 'needs_reauth' | 'error' | null;
  onRetry: () => void;
  compact?: boolean;
}) {
  if (!isMuteListUnconfirmed(status)) return null;
  const approval = status === 'needs_approval' || status === 'needs_reauth';
  return (
    <div
      className={
        compact
          ? 'flex flex-col items-center gap-4 py-6 text-center'
          : 'flex flex-col items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4'
      }
      data-testid="messaging-mutes-notice"
    >
      <Typography as="p" role="status" className="text-sm text-muted-foreground">
        {approval
          ? compact
            ? 'Authorize to send and receive messages.'
            : MESSAGING_COPY.mutesNeedApproval
          : MESSAGING_COPY.mutesUnavailable}
      </Typography>
      {approval ? (
        <MarketplaceReauthDialog
          triggerLabel={compact ? 'Enable messages' : MESSAGING_COPY.approvePrivateSync}
          triggerVariant={compact ? 'outline' : 'default'}
          intent={compact ? 'messages' : undefined}
          refusal={status === 'needs_reauth' ? 'homeserver' : 'purchase_session'}
          onReauthenticated={onRetry}
        />
      ) : (
        <Button variant="secondary" className="rounded-full" onClick={onRetry}>
          {MESSAGING_COPY.inboxRetry}
        </Button>
      )}
    </div>
  );
}
