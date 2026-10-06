import type { NextRequest } from 'next/server';
import { FLOW_COOKIE, pollFlow, SESSION_COOKIE } from '@/server/marketplace-grant/bff';
import { grantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    return noStoreJson(
      await pollFlow(
        request,
        request.cookies.get(SESSION_COOKIE)?.value,
        request.cookies.get(FLOW_COOKIE)?.value,
        stateId,
      ),
    );
  } catch (error) {
    return grantError(error);
  }
}
