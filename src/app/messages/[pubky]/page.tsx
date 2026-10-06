import { stripPubkyPrefix } from '@/libs/utils/utils';
import { MessagesConversation } from '@/templates/Messages/MessagesConversation';

interface DmConversationPageProps {
  params: Promise<{ pubky: string }>;
}

export default async function DmConversationPage({ params }: DmConversationPageProps) {
  const { pubky } = await params;
  const counterpartyPubky = stripPubkyPrefix(decodeURIComponent(pubky));
  return <MessagesConversation counterpartyPubky={counterpartyPubky} />;
}
