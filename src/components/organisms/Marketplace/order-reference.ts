const PAYPAL_TXN_ID = /^[A-Za-z0-9]{8,64}$/;

/** First eight characters of the order id, shown as the copyable reference. */
export function shortOrderReference(orderId: string): string {
  return orderId.slice(0, 8);
}

/**
 * Seller activity page for a stored PayPal txn_id.
 * The id must be alphanumeric; anything else is not a link.
 */
export function paypalActivityUrl(txnId: string): string | null {
  if (!PAYPAL_TXN_ID.test(txnId)) return null;
  return `https://www.paypal.com/myaccount/activities/details/${encodeURIComponent(txnId)}`;
}

export function sellerPaypalActivityUrl(
  order: { paymentMethod?: string | null; fiatTransactionRef?: string | null },
  isBuyer: boolean,
): string | null {
  if (isBuyer || order.paymentMethod !== 'paypal') return null;
  const ref = order.fiatTransactionRef;
  if (!ref) return null;
  return paypalActivityUrl(ref);
}
