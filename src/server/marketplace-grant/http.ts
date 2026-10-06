import { NextResponse } from 'next/server';
import { mapBffError } from './bff';
import { mapCliBffError } from './cli-bff';

export function noStoreJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('cache-control', 'no-store, private');
  return response;
}

export function noStoreEmpty(status: number): NextResponse {
  const response = new NextResponse(null, { status });
  response.headers.set('cache-control', 'no-store, private');
  return response;
}

function applyMappedError(
  mapped: { status: number; code: string; retryAfterSeconds?: number },
  logLabel: string,
  error: unknown,
): NextResponse {
  const category =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'UnknownError';
  console.warn(logLabel, { category });
  const response = noStoreJson({ error: mapped.code }, mapped.status);
  if (mapped.status === 429) {
    response.headers.set('retry-after', String(mapped.retryAfterSeconds ?? 60));
  }
  return response;
}

export function grantError(error: unknown): NextResponse {
  return applyMappedError(mapBffError(error), '[marketplace-grant] request failed', error);
}

export function cliGrantError(error: unknown): NextResponse {
  return applyMappedError(mapCliBffError(error), '[marketplace-grant-cli] request failed', error);
}

export const grantCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: true,
  path: '/',
};
