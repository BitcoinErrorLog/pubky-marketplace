import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { commerceAggregateIdSchema, commercePubkySchema } from '../../../src/libs/commerce/transaction-contracts';
import { InMemoryMarketplaceRepository, MarketplaceTransactionService } from './transaction-service';

export type MarketplaceServerMode = 'disabled' | 'sandbox';

export interface MarketplaceServerOptions {
  mode: MarketplaceServerMode;
  service?: MarketplaceTransactionService;
  maxBodyBytes?: number;
  allowedOrigin?: string;
}

export function createMarketplaceHttpServer({
  mode,
  service = new MarketplaceTransactionService(new InMemoryMarketplaceRepository()),
  maxBodyBytes = 1_000_000,
  allowedOrigin = '*',
}: MarketplaceServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      if (mode === 'sandbox') {
        response.setHeader('access-control-allow-origin', allowedOrigin);
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'content-type, x-pubky-actor, x-recipient-pubky');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === 'GET' && request.url === '/health/live') {
        writeJson(response, 200, { status: 'live' }, mode);
        return;
      }

      if (request.method === 'GET' && request.url === '/health/ready') {
        const ready = mode === 'sandbox';
        writeJson(
          response,
          ready ? 200 : 503,
          {
            status: ready ? 'ready' : 'not_ready',
            mode,
            storage: 'memory',
          },
          mode,
        );
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/commands') {
        if (mode !== 'sandbox') {
          writeJson(
            response,
            503,
            { error: { code: 'UNAVAILABLE', message: 'Marketplace commands are disabled.' } },
            mode,
          );
          return;
        }

        const actor = request.headers['x-pubky-actor'];
        if (Array.isArray(actor) || actor === undefined) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'A sandbox actor header is required.' } },
            mode,
          );
          return;
        }

        const body = await readJsonBody(request, maxBodyBytes);
        const result = await service.execute(actor, body);
        const status = result.ok ? 200 : statusForFailure(result.error.code);
        writeJson(response, status, result, mode);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/attachments') {
        if (mode !== 'sandbox') {
          writeJson(
            response,
            503,
            { error: { code: 'UNAVAILABLE', message: 'Marketplace attachments are disabled.' } },
            mode,
          );
          return;
        }
        const actor = request.headers['x-pubky-actor'];
        const recipient = request.headers['x-recipient-pubky'];
        const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
        if (Array.isArray(actor) || Array.isArray(recipient) || !actor || !recipient) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'Attachment participants are required.' } },
            mode,
          );
          return;
        }
        const bytes = await readBytesBody(request, 5 * 1024 * 1024);
        const result = service.storeAttachment(actor, recipient, mimeType, bytes);
        writeJson(
          response,
          result.ok ? 201 : result.code === 'UNAUTHORIZED' ? 401 : 400,
          result.ok ? result.attachment : { error: { code: result.code, message: result.message } },
          mode,
        );
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/attachments/')) {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        const attachmentId = request.url.slice('/v1/attachments/'.length);
        if (!actorResult.success) {
          writeJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Attachment actor is required.' } }, mode);
          return;
        }
        const attachment = service.getAttachment(actorResult.data, attachmentId);
        if (!attachment) {
          writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Attachment not found.' } }, mode);
          return;
        }
        response.writeHead(200, {
          'content-type': attachment.mimeType,
          'content-length': attachment.byteSize,
          'cache-control': 'private, no-store',
          'x-content-hash': attachment.contentHash,
          'x-marketplace-mode': mode,
        });
        response.end(attachment.bytes);
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/listings?')) {
        const aggregateId = new URL(request.url, 'http://marketplace.local').searchParams.get('aggregateId');
        const parsed = commerceAggregateIdSchema.safeParse(aggregateId);
        if (!parsed.success) {
          writeJson(
            response,
            400,
            { error: { code: 'INVALID_COMMAND', message: 'A valid listing aggregate id is required.' } },
            mode,
          );
          return;
        }
        const listing = service.getListingProjection(parsed.data);
        writeJson(
          response,
          listing ? 200 : 404,
          listing ?? { error: { code: 'NOT_FOUND', message: 'Listing not found.' } },
          mode,
        );
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/offers')) {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        const aggregateId = new URL(request.url, 'http://marketplace.local').searchParams.get('aggregateId');
        const aggregateResult = aggregateId === null ? null : commerceAggregateIdSchema.safeParse(aggregateId);
        if (!actorResult.success || (aggregateResult !== null && !aggregateResult.success)) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'Valid offer participant identity is required.' } },
            mode,
          );
          return;
        }
        writeJson(
          response,
          200,
          {
            offers:
              aggregateResult?.success === true
                ? service.getParticipantOffers(actorResult.data, aggregateResult.data)
                : service.getOffers(actorResult.data),
          },
          mode,
        );
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/conversations') {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        if (!actorResult.success) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'Valid conversation participant identity is required.' } },
            mode,
          );
          return;
        }
        writeJson(response, 200, { conversations: service.getParticipantConversations(actorResult.data) }, mode);
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/notifications') {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        if (!actorResult.success) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'Valid notification recipient identity is required.' } },
            mode,
          );
          return;
        }
        writeJson(response, 200, { notifications: service.getNotifications(actorResult.data) }, mode);
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/notification-preferences') {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        if (!actorResult.success) {
          writeJson(
            response,
            401,
            { error: { code: 'UNAUTHORIZED', message: 'Valid notification owner identity is required.' } },
            mode,
          );
          return;
        }
        writeJson(response, 200, service.getNotificationPreferences(actorResult.data), mode);
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/orders') {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        if (!actorResult.success) {
          writeJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Order actor is required.' } }, mode);
          return;
        }
        writeJson(response, 200, { orders: service.getOrders(actorResult.data) }, mode);
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/payments/')) {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        const paymentId = request.url.slice('/v1/payments/'.length);
        const payment = actorResult.success ? service.getPayment(actorResult.data, paymentId) : null;
        writeJson(
          response,
          payment ? 200 : actorResult.success ? 404 : 401,
          payment ?? {
            error: { code: actorResult.success ? 'NOT_FOUND' : 'UNAUTHORIZED', message: 'Payment unavailable.' },
          },
          mode,
        );
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/receipts/')) {
        const actor = request.headers['x-pubky-actor'];
        const actorResult = commercePubkySchema.safeParse(Array.isArray(actor) ? null : actor);
        const receiptId = request.url.slice('/v1/receipts/'.length);
        const receipt = actorResult.success ? service.getReceipt(actorResult.data, receiptId) : null;
        writeJson(
          response,
          receipt ? 200 : actorResult.success ? 404 : 401,
          receipt ?? {
            error: { code: actorResult.success ? 'NOT_FOUND' : 'UNAUTHORIZED', message: 'Receipt unavailable.' },
          },
          mode,
        );
        return;
      }

      writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, mode);
    } catch (error) {
      const code = error instanceof RequestBodyError ? error.code : 'INTERNAL_ERROR';
      const status = error instanceof RequestBodyError ? error.status : 500;
      const message = error instanceof RequestBodyError ? error.message : 'Marketplace request failed.';
      writeJson(response, status, { error: { code, message } }, mode);
    }
  });
}

class RequestBodyError extends Error {
  constructor(
    readonly code: 'INVALID_JSON' | 'BODY_TOO_LARGE',
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const bytes = await readBytesBody(request, maxBodyBytes);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new RequestBodyError('INVALID_JSON', 400, 'Request body must be valid JSON.');
  }
}

async function readBytesBody(request: IncomingMessage, maxBodyBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new RequestBodyError('BODY_TOO_LARGE', 413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function writeJson(response: ServerResponse, status: number, body: object, mode: MarketplaceServerMode): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-marketplace-mode': mode,
  });
  response.end(JSON.stringify(body));
}

function statusForFailure(code: string): number {
  switch (code) {
    case 'INVALID_COMMAND':
      return 400;
    case 'UNAUTHORIZED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'REVISION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'INSUFFICIENT_INVENTORY':
    case 'INVARIANT_VIOLATION':
    case 'INVALID_STATE':
    case 'BID_TOO_LOW':
      return 409;
    case 'OFFER_EXPIRED':
    case 'AUCTION_CLOSED':
      return 410;
    default:
      return 500;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode: MarketplaceServerMode = process.env.MARKETPLACE_MODE === 'sandbox' ? 'sandbox' : 'disabled';
  const port = Number.parseInt(process.env.MARKETPLACE_PORT ?? '3100', 10);
  const host = process.env.MARKETPLACE_HOST ?? '127.0.0.1';
  const server = createMarketplaceHttpServer({ mode });
  server.listen(port, host, () => {
    console.info(`[marketplace] listening on ${host}:${port} (${mode})`);
  });
}
