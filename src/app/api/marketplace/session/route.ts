import { type NextRequest, NextResponse } from 'next/server';
import { clearSession, FLOW_COOKIE, pairSession, SESSION_COOKIE } from '@/server/marketplace-grant/bff';
import { grantCookieOptions, grantError } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const paired = await pairSession(request, request.headers.get('authorization'));
    const response = new NextResponse(null, { status: 204 });
    response.headers.set('cache-control', 'no-store, private');
    response.cookies.set(SESSION_COOKIE, paired.cookie, { ...grantCookieOptions, maxAge: paired.maxAge });
    response.cookies.delete(FLOW_COOKIE);
    return response;
  } catch (error) {
    return grantError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cleared = await clearSession(request, request.cookies.get(SESSION_COOKIE)?.value);
    const response = new NextResponse(null, { status: 204 });
    response.headers.set('cache-control', 'no-store, private');
    if (cleared) {
      response.cookies.delete(SESSION_COOKIE);
      response.cookies.delete(FLOW_COOKIE);
    }
    return response;
  } catch (error) {
    return grantError(error);
  }
}
