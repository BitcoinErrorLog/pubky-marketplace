import { readBuildInfo } from '@/libs/build-info/build-info';

// Generated once at build time from the values `next.config.ts` inlines; never from a hand-edited file.
export const dynamic = 'force-static';

export function GET() {
  return Response.json(readBuildInfo(), {
    headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
  });
}
