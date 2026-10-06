import type { NextRequest } from 'next/server';
import { BOOTSTRAP_FLOW_COOKIE, pollBrowserFlow } from '@/server/marketplace-grant/browser-bff';
import { grantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    return noStoreJson(await pollBrowserFlow(request, request.cookies.get(BOOTSTRAP_FLOW_COOKIE)?.value, stateId));
  } catch (error) {
    return grantError(error);
  }
}
