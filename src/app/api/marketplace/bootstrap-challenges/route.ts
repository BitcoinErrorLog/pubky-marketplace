import type { NextRequest } from 'next/server';
import { createBrowserChallenge } from '@/server/marketplace-grant/browser-bff';
import { grantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    return noStoreJson(await createBrowserChallenge(request), 201);
  } catch (error) {
    return grantError(error);
  }
}
