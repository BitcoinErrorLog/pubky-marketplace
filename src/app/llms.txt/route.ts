import { getMarketplaceNexusUrl } from '@/config/nexus';
import { renderAgentGuide } from './agent-guide';

export const dynamic = 'force-dynamic';

export function GET() {
  const indexUrl = getMarketplaceNexusUrl().replace(/\/+$/, '');
  return new Response(renderAgentGuide(indexUrl), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
