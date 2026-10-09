/**
 * The service S6 wire contract for USDT refunds, pinned exactly as the plan
 * states it (docs/usdt-shop-plan.md §2.6; Shop docs/ecommerce/usdt-payments.md).
 * Hand-written from the contract because the S6 service PR is built in
 * parallel; replace with a capture from the service once it lands.
 */

/** A real EIP-55 checksummed address (the EIP-55 specification's first test vector). */
export const REFUND_FIXTURE_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
export const REFUND_FIXTURE_OTHER_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
export const REFUND_FIXTURE_TX_HASH = `0x${'ab12'.repeat(16)}`;

/** `POST /v1/commands` body the Shop sends for `refund.confirm_destination` (snake_case on the wire). */
export const CONFIRM_REFUND_DESTINATION_WIRE_COMMAND = {
  version: 1,
  command_id: '018f47d2-6a27-7c23-a49d-0000000009a1',
  aggregate_id: 'order:018f47d2-6a27-7c23-a49d-0000000009a0',
  expected_revision: 4,
  issued_at: '2026-10-09T16:00:00.000Z',
  kind: 'refund.confirm_destination',
  payload: {
    order_id: '018f47d2-6a27-7c23-a49d-0000000009a0',
    address: REFUND_FIXTURE_ADDRESS,
  },
};

/** The participant order projection fields an S6 service adds to a USDT order. */
export const USDT_ORDER_REFUND_DESTINATION_WIRE = {
  payment_method: 'usdt',
  payment_asset: 'USDT',
  payment_network: 'arbitrum-one',
  payment_amount_minor: 137_000_000,
  payment_exponent: 6,
  payment_quote_basis: 'parity',
  refund_destination: {
    address: REFUND_FIXTURE_ADDRESS,
    network: 'arbitrum-one',
    asset: 'USDT',
    source: 'buyer_entered',
    confirmed_at: '2026-10-09T16:00:00.000Z',
  },
};

/** `refund.record_external` on a USDT order: the reference is the lowercase Arbitrum transaction hash. */
export const RECORD_USDT_REFUND_WIRE_PAYLOAD = {
  order_id: '018f47d2-6a27-7c23-a49d-0000000009a0',
  amount_minor: 13_700,
  transaction_id: REFUND_FIXTURE_TX_HASH,
};

/** The closed refusal reasons S6 adds (plan §2.7), as `error.reason` on a refused command. */
export const USDT_REFUND_REFUSAL_REASONS = [
  'refund_destination_required',
  'invalid_refund_destination',
  'invalid_refund_reference',
] as const;
