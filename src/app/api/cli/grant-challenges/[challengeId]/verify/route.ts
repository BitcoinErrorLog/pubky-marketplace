import type { NextRequest } from 'next/server';
import { verifyCliChallenge } from '@/server/marketplace-grant/cli-bff';
import { cliGrantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ challengeId: string }> }) {
  try {
    const { challengeId } = await context.params;
    return noStoreJson(await verifyCliChallenge(request, challengeId), 201);
  } catch (error) {
    return cliGrantError(error);
  }
}
