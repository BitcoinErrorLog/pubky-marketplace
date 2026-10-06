import type { NextRequest } from 'next/server';
import { createCliChallenge } from '@/server/marketplace-grant/cli-bff';
import { cliGrantError, noStoreJson } from '@/server/marketplace-grant/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    return noStoreJson(await createCliChallenge(request), 201);
  } catch (error) {
    return cliGrantError(error);
  }
}
