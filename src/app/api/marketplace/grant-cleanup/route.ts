import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getMarketplaceGrantConfig } from '@/server/marketplace-grant/config';
import { cleanupGrantState } from '@/server/marketplace-grant/db';
import { noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

function authorized(request: NextRequest, secret: string): boolean {
  const presented = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const actual = Buffer.from(presented);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: NextRequest) {
  const config = getMarketplaceGrantConfig();
  if (!config) return noStoreJson({ error: 'not_found' }, 404);
  if (!authorized(request, config.cronSecret)) return noStoreJson({ error: 'unauthorized' }, 401);
  await cleanupGrantState(config);
  return noStoreJson({ ok: true });
}
