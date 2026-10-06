import { getExchangeRateApi } from '@/config/network';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError, safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';
import { exchangerateQueryClient } from './exchangerate.query-client';
import { BlockTankResponse, BtcRate } from './exchangerate.types';

/**
 * Exchange rate service class.
 * Handles fetching BTC/USD and SAT/USD exchange rates from external APIs.
 */
export class ExchangerateService {
  private constructor() {} // Prevent instantiation

  /**
   * Fetches the BTC/USD exchange rate from BlockTank API
   *
   * @returns Promise resolving to the BTC/USD exchange rate as a number
   * @throws {AppError} If the API request fails, response is invalid, or BTCUSD ticker is not found
   */
  private static async getBtcUsdRate(): Promise<number> {
    // Browsers go through the same-origin `/api/fx-rate` proxy: the upstream
    // sends no CORS headers, so a direct browser fetch is blocked on every
    // deployed origin. Server-side callers (and the proxy route itself) hit
    // the configured upstream directly.
    const exchangeRateApi = typeof window === 'undefined' ? getExchangeRateApi() : '/api/fx-rate';
    const response = await safeFetch(
      exchangeRateApi,
      { method: HttpMethod.GET },
      ErrorService.Exchangerate,
      'getBtcUsdRate',
    );

    if (!response.ok) {
      throw httpResponseToError(response, ErrorService.Exchangerate, 'getBtcUsdRate', exchangeRateApi);
    }

    const data = await parseResponseOrThrow<BlockTankResponse>(
      response,
      ErrorService.Exchangerate,
      'getBtcUsdRate',
      exchangeRateApi,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );

    if (!data.tickers || !Array.isArray(data.tickers)) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Invalid response format from exchange rate API', {
        service: ErrorService.Exchangerate,
        operation: 'getBtcUsdRate',
        context: { endpoint: exchangeRateApi },
      });
    }

    const btcUsdTicker = data.tickers.find((ticker) => ticker.symbol === 'BTCUSD');

    if (!btcUsdTicker) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'BTCUSD ticker not found in API response', {
        service: ErrorService.Exchangerate,
        operation: 'getBtcUsdRate',
        context: { endpoint: exchangeRateApi, availableSymbols: data.tickers.map((t) => t.symbol) },
      });
    }

    const rate = parseFloat(btcUsdTicker.lastPrice);

    if (isNaN(rate) || rate <= 0) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, `Invalid exchange rate value: ${btcUsdTicker.lastPrice}`, {
        service: ErrorService.Exchangerate,
        operation: 'getBtcUsdRate',
        context: { endpoint: exchangeRateApi, lastPrice: btcUsdTicker.lastPrice },
      });
    }

    return rate;
  }

  /**
   * Gets the current SAT/USD and BTC/USD exchange rate.
   *
   * @returns Promise resolving to the BTC rate with satUsd, btcUsd, and lastUpdatedAt
   * @throws {AppError} If the API request fails, response is invalid, or BTCUSD ticker is not found
   *
   * @example
   * const rate = await ExchangerateService.getSatoshiUsdRate();
   * console.log(`1 SAT = $${rate.satUsd}`);
   */
  static async getSatoshiUsdRate(): Promise<BtcRate> {
    return exchangerateQueryClient.fetchQuery({
      queryKey: ['exchangerate', 'btc-rate'],
      queryFn: ExchangerateService.fetchBtcRate,
    });
  }

  /**
   * The BTC rate for indicative marketplace price estimates. Same source and
   * cache entry as `getSatoshiUsdRate`, but refetched when older than five
   * minutes: an "≈" estimate shown beside every listing price should not be
   * half an hour stale.
   *
   * @throws {AppError} If the API request fails or the response is invalid —
   * callers must render NO estimate in that case, never a fallback number.
   */
  static async getIndicativeBtcRate(): Promise<BtcRate> {
    return exchangerateQueryClient.fetchQuery({
      queryKey: ['exchangerate', 'btc-rate'],
      queryFn: ExchangerateService.fetchBtcRate,
      staleTime: 5 * 60 * 1000,
    });
  }

  private static async fetchBtcRate(): Promise<BtcRate> {
    const btcusd = await ExchangerateService.getBtcUsdRate();
    return {
      satUsd: btcusd / 100_000_000,
      btcUsd: btcusd,
      lastUpdatedAt: new Date(),
    };
  }
}
