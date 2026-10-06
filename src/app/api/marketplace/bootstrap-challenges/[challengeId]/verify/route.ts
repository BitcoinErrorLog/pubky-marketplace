import type { NextRequest } from 'next/server';
import { BOOTSTRAP_FLOW_COOKIE, verifyBrowserChallenge } from '@/server/marketplace-grant/browser-bff';
import { grantCookieOptions, grantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ challengeId: string }> }) {
  try {
    const { challengeId } = await context.params;
    const verified = await verifyBrowserChallenge(request, challengeId);
    const response = noStoreJson(verified.response, 201);
    response.cookies.set(BOOTSTRAP_FLOW_COOKIE, verified.cookie, { ...grantCookieOptions, maxAge: verified.maxAge });
    return response;
  } catch (error) {
    return grantError(error);
  }
}
