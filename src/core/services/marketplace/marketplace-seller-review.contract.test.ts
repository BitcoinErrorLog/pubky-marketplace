import { describe, expect, it } from 'vitest';
import endpoints from '@/libs/commerce/contracts/endpoints.json';
import confirmSamples from '@/libs/commerce/contracts/samples/confirm.json';
import projectionSamples from '@/libs/commerce/contracts/samples/projections.json';
import resolveSamples from '@/libs/commerce/contracts/samples/resolve.json';
import {
  sellerPaymentConfirmationSchema,
  sellerPaymentObservationSchema,
  sellerPaymentResolutionSchema,
  sellerPaymentReviewReasonCopy,
  sellerPaymentReviewReasonSchema,
} from '@/libs/commerce/marketplace-payment-review';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';

describe('seller payment review contract mapping', () => {
  it('maps every service ReviewReason to static client copy', () => {
    const reasons = endpoints.flatMap((endpoint) => endpoint.reasons);
    for (const reason of reasons) {
      const parsed = sellerPaymentReviewReasonSchema.safeParse(reason);
      expect(parsed.success, reason).toBe(true);
      if (parsed.success) expect(sellerPaymentReviewReasonCopy[parsed.data], reason).toBeTypeOf('string');
    }
  });

  it('retains the complete service-captured sample set', () => {
    expect(Object.keys(confirmSamples)).toHaveLength(8);
    expect(Object.keys(resolveSamples)).toHaveLength(15);
    expect(Object.keys(projectionSamples)).toHaveLength(6);
    expect(projectionSamples.seller_awaiting_confirmation.response.body.paykit_observation).toEqual(
      expect.objectContaining({
        txid: expect.any(String),
        observed_sats: expect.any(Number),
        confirmations: expect.any(Number),
        amount_matched: expect.any(Boolean),
        disappeared: expect.any(Boolean),
        observed_at: expect.any(String),
      }),
    );
  });

  it('accepts fail-closed null observation leaves without widening the schema', () => {
    expect(
      sellerPaymentObservationSchema.parse({
        txid: null,
        observedSats: null,
        confirmations: null,
        amountMatched: null,
        disappeared: null,
        observedAt: null,
      }),
    ).toEqual({
      txid: null,
      observedSats: null,
      confirmations: null,
      amountMatched: null,
      disappeared: null,
      observedAt: null,
    });
  });

  it('parses captured success and replay response facts after real wire casing', () => {
    const confirmation = confirmSamples.success.response.body.confirmation;
    const replayConfirmation = confirmSamples.replay.response.body.confirmation;
    sellerPaymentConfirmationSchema.parse(toCamelCaseWire(hydrate(confirmation)));
    sellerPaymentConfirmationSchema.parse(toCamelCaseWire(hydrate(replayConfirmation)));
    sellerPaymentResolutionSchema.parse(toCamelCaseWire(hydrate(resolveSamples.paid.response.body.resolution)));
    sellerPaymentResolutionSchema.parse(toCamelCaseWire(hydrate(resolveSamples.replay.response.body.resolution)));
  });
});

function hydrate(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== 'string') return item;
      if (item.startsWith('<uuid:')) {
        const number = item.match(/\d+/)?.[0] ?? '1';
        return `018f47d2-6a27-7c23-a49d-${number.padStart(12, '0')}`;
      }
      if (item === '<pubky:buyer>') return 'b'.repeat(52);
      if (item === '<pubky:seller>') return 's'.repeat(52);
      return item;
    }),
  );
}
