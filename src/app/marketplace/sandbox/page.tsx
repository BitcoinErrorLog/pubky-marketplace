import { notFound } from 'next/navigation';
import { getCommerceAdapterMode } from '@/config/commerce';
import { MarketplaceSandboxSeed } from './MarketplaceSandboxSeed';

/**
 * Sandbox demo-data seeding — reachable only when the commerce adapter is explicitly
 * configured as `sandbox`; 404 everywhere else (production defaults to `unavailable`).
 *
 * Gating reads runtime config, which only exists at request time (PUBKY_RUNTIME_*).
 * Force dynamic rendering so the gate is evaluated per request and never baked into a
 * static page at build time.
 */
export const dynamic = 'force-dynamic';

export default function MarketplaceSandboxPage() {
  if (getCommerceAdapterMode() !== 'sandbox') {
    notFound();
  }

  return <MarketplaceSandboxSeed />;
}
