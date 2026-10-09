import { ArrowLeft } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Link } from '@/atoms/Link/Link';

export function BackToMyShop() {
  return (
    <Link
      href={MARKETPLACE_ROUTES.DASHBOARD}
      overrideDefaults
      className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      My shop
    </Link>
  );
}
