import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { MarketplaceConversation } from '@/services/marketplace/marketplace';

export const CONVERSATION_FIXTURE_BUYER = 'b'.repeat(52);
export const CONVERSATION_FIXTURE_SELLER = 's'.repeat(52);

type ConversationMessage = MarketplaceConversation['messages'][number];
type ConversationAttachment = ConversationMessage['attachments'][number];

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `018f47d2-6a27-7c23-d730-${hex}`;
}

export function createConversationAttachmentFixture(
  overrides: Partial<ConversationAttachment> = {},
): ConversationAttachment {
  return {
    id: uuid(900),
    senderPubky: CONVERSATION_FIXTURE_BUYER,
    recipientPubky: CONVERSATION_FIXTURE_SELLER,
    mimeType: 'image/png',
    byteSize: 24_000,
    contentHash: 'e'.repeat(64),
    createdAt: '2026-08-18T10:05:00.000Z',
    ...overrides,
  };
}

export function createConversationMessageFixture(
  seed: number,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: uuid(seed),
    senderPubky: CONVERSATION_FIXTURE_BUYER,
    recipientPubky: CONVERSATION_FIXTURE_SELLER,
    text: 'Is this still available?',
    attachments: [],
    createdAt: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

export function createConversationFixture(overrides: Partial<MarketplaceConversation> = {}): MarketplaceConversation {
  return {
    id: uuid(500),
    listingAggregateId: buildMarketplaceListingAggregateId(CONVERSATION_FIXTURE_SELLER, 'leather_boots'),
    sellerPubky: CONVERSATION_FIXTURE_SELLER,
    buyerPubky: CONVERSATION_FIXTURE_BUYER,
    revision: 3,
    lastMessageAt: '2026-08-18T10:10:00.000Z',
    messages: [
      createConversationMessageFixture(1, {
        text: 'Is this still available? Could you share a photo of the sole wear?',
      }),
      createConversationMessageFixture(2, {
        senderPubky: CONVERSATION_FIXTURE_BUYER,
        recipientPubky: CONVERSATION_FIXTURE_SELLER,
        text: 'Here is the state of mine for comparison.',
        attachments: [createConversationAttachmentFixture()],
        createdAt: '2026-08-18T10:05:00.000Z',
      }),
      createConversationMessageFixture(3, {
        senderPubky: CONVERSATION_FIXTURE_SELLER,
        recipientPubky: CONVERSATION_FIXTURE_BUYER,
        text: 'Yes, still available. Soles are barely worn — happy to ship tomorrow.',
        createdAt: '2026-08-18T10:10:00.000Z',
      }),
    ],
    ...overrides,
  };
}

/** A small inbox with distinct counterparts, latest activity, and previews. */
export function createInboxConversationsFixture(): MarketplaceConversation[] {
  return [
    createConversationFixture(),
    createConversationFixture({
      id: uuid(501),
      listingAggregateId: buildMarketplaceListingAggregateId('n'.repeat(52), 'rangefinder_camera'),
      sellerPubky: 'n'.repeat(52),
      lastMessageAt: '2026-08-17T15:00:00.000Z',
      messages: [
        createConversationMessageFixture(11, {
          recipientPubky: 'n'.repeat(52),
          text: 'Does the rangefinder come with the original leather case?',
          createdAt: '2026-08-17T15:00:00.000Z',
        }),
      ],
    }),
    createConversationFixture({
      id: uuid(502),
      listingAggregateId: buildMarketplaceListingAggregateId('d'.repeat(52), 'ceramic_vase'),
      sellerPubky: 'd'.repeat(52),
      lastMessageAt: '2026-08-16T09:30:00.000Z',
      messages: [],
    }),
  ];
}
