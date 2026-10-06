import type { NextRequest } from 'next/server';
import { createFlow, FLOW_COOKIE, SESSION_COOKIE } from '@/server/marketplace-grant/bff';
import { grantCookieOptions, grantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const created = await createFlow(request, request.cookies.get(SESSION_COOKIE)?.value);
    const response = noStoreJson(created.response, 201);
    response.cookies.set(FLOW_COOKIE, created.cookie, { ...grantCookieOptions, maxAge: created.maxAge });
    return response;
  } catch (error) {
    return grantError(error);
  }
}
