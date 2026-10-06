'use client';

import { usePathname } from 'next/navigation';
import { APP_ROUTES } from '@/app/routes';
import { getCommerceAdapterMode, getDeployEnv } from '@/libs/runtime-config/runtime-config';

export function EnvironmentLabel() {
  const pathname = usePathname();
  const isMarketplace = pathname === APP_ROUTES.MARKETPLACE || pathname?.startsWith(`${APP_ROUTES.MARKETPLACE}/`);
  const mode = isMarketplace ? getCommerceAdapterMode() : undefined;
  const label = [
    getDeployEnv() === 'staging' ? 'STAGING' : null,
    mode === 'sandbox' ? 'SANDBOX' : mode === 'unavailable' ? 'READ ONLY' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (!label) return null;

  return (
    <span className="absolute top-full left-7 text-xs tracking-[1.2px] whitespace-nowrap text-brand">{label}</span>
  );
}
