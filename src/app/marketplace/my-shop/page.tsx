import { redirect } from 'next/navigation';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export default function LegacyMyShopPage() {
  redirect(MARKETPLACE_ROUTES.MY_SHOP);
}
