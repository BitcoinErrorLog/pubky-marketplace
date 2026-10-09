import { NextResponse } from 'next/server';
import { getFrameAncestors } from '@/libs/runtime-config/runtime-config';
import { buildFramingHeaders } from '@/libs/security/headers';

/**
 * Sets the framing and opener headers on every document and API response.
 *
 * The `frame-ancestors` allow-list is a runtime value, so it cannot live in
 * `next.config.ts` `headers()`, which Next.js evaluates once at build time. One
 * image therefore serves a locked-down deployment and an embeddable one,
 * depending only on `PUBKY_RUNTIME_FRAME_ANCESTORS`.
 */
export function proxy() {
  const response = NextResponse.next();
  for (const { key, value } of buildFramingHeaders(getFrameAncestors())) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  // Static build output and optimised images are not documents, so framing policy is moot
  // there; skipping them keeps the proxy off the CDN-served asset path.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
