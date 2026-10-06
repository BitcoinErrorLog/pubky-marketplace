import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { DropMissionControl } from '@/organisms/Marketplace/DropMissionControl';

export interface DropMissionControlPageProps {
  params: Promise<{
    dropId: string;
  }>;
}

/**
 * Generic gated metadata on purpose: mission control is a personal seller
 * surface, so previews never carry drop specifics.
 */
export async function generateMetadata({ params }: DropMissionControlPageProps) {
  const { dropId } = await params;
  return gatedMarketplaceMetadata(
    'Drop mission control | Pubky Marketplace',
    'Run one of your timed, limited releases on Pubky Marketplace.',
    `${MARKETPLACE_ROUTES.SELL_DROPS}/${dropId}`,
  );
}

export default async function DropMissionControlPage({ params }: DropMissionControlPageProps) {
  const { dropId } = await params;
  return <DropMissionControl dropId={dropId} />;
}
