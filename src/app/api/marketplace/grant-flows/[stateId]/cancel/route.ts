import { type NextRequest, NextResponse } from 'next/server';
import { cancelFlow, FLOW_COOKIE, SESSION_COOKIE } from '@/server/marketplace-grant/bff';
import { grantError } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    await cancelFlow(
      request,
      request.cookies.get(SESSION_COOKIE)?.value,
      request.cookies.get(FLOW_COOKIE)?.value,
      stateId,
    );
    const response = new NextResponse(null, { status: 204 });
    response.headers.set('cache-control', 'no-store, private');
    response.cookies.delete(FLOW_COOKIE);
    return response;
  } catch (error) {
    return grantError(error);
  }
}
