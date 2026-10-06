import type { NextRequest } from 'next/server';
import { issueCliResultNonce } from '@/server/marketplace-grant/cli-bff';
import { cliGrantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ stateId: string }> }) {
  try {
    const { stateId } = await context.params;
    return noStoreJson(await issueCliResultNonce(request, stateId), 201);
  } catch (error) {
    return cliGrantError(error);
  }
}
