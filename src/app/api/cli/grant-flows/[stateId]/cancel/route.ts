import type { NextRequest } from 'next/server';
import { cancelCliFlow } from '@/server/marketplace-grant/cli-bff';
import { cliGrantError, noStoreEmpty } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    await cancelCliFlow(request, stateId);
    return noStoreEmpty(204);
  } catch (error) {
    return cliGrantError(error);
  }
}
