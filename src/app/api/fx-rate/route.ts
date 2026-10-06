import { NextResponse } from 'next/server';
import { getExchangeRateApi } from '@/config/network';
import { handleApiError } from '@/libs/api/route-error-handler';
import { safeFetch } from '@/libs/error/error.http';
import { httpResponseToError } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';

/**
 * Same-origin proxy for the BTC/USD indicative-rate source. The upstream
 * (BlockTank) sends no Access-Control-Allow-Origin header, so browsers on
 * shop.pubky.app cannot fetch it directly — the "≈" estimates silently died
 * behind a CORS error. This route fetches server-side and re-serves the
 * body verbatim; the service layer keeps all shape validation.
 *
 * Cache mirrors the service's five-minute rate cache so the CDN absorbs
 * repeat lookups; an indicative display estimate does not need to be
 * fresher than that.
 */
const CACHE_HEADERS = {
  headers: {
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
  },
};

export async function GET() {
  try {
    const upstream = getExchangeRateApi();
    const response = await safeFetch(upstream, { method: HttpMethod.GET }, ErrorService.Exchangerate, 'fxRateProxy');
    if (!response.ok) {
      throw httpResponseToError(response, ErrorService.Exchangerate, 'fxRateProxy', upstream);
    }
    const body = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Exchangerate,
      'fxRateProxy',
      upstream,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );
    return NextResponse.json(body, CACHE_HEADERS);
  } catch (error) {
    return handleApiError(error, 'fxRateProxy');
  }
}
