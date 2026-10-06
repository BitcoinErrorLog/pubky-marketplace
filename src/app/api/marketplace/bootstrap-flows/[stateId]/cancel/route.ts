import type { NextRequest } from 'next/server';
import { BOOTSTRAP_FLOW_COOKIE, cancelBrowserFlow } from '@/server/marketplace-grant/browser-bff';
import { grantError, noStoreEmpty } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    await cancelBrowserFlow(request, request.cookies.get(BOOTSTRAP_FLOW_COOKIE)?.value, stateId);
    const response = noStoreEmpty(204);
    response.cookies.delete(BOOTSTRAP_FLOW_COOKIE);
    return response;
  } catch (error) {
    return grantError(error);
  }
}
