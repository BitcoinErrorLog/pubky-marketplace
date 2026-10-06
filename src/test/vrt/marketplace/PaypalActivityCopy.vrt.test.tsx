// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderForVRT } from '@/test-utils/vrt';
import { MarketplaceNotifications } from '@/templates/Marketplace/MarketplaceNotifications';
import { MarketplaceOrders } from '@/templates/Marketplace/MarketplaceOrders';

/**
 * Chromium proof for the first PayPal sale's activity sequence:
 * order_created, payment_method_bound, payment_confirmed, on a paid
 * gateway-notified order. Renders the production surfaces. No screenshot
 * baselines — assertions are the gate.
 */
const EVIDENCE = '/Volumes/vibedrive/vibes-dev/.evidence/paypal-activity-copy';

const ids = vi.hoisted(() => ({
  seller: 's'.repeat(52),
  buyer: 'b'.repeat(52),
}));

const fixtures = vi.hoisted(async () => {
  const { createNotificationFixture } = await import('@/test/fixtures/commerce/notifications');
  const { createOrderFixture, createPaymentFixture, createReceiptFixture } =
    await import('@/test/fixtures/commerce/orders');
  const usd = { amountMinor: 250, currency: 'USD', exponent: 2 };
  const order = createOrderFixture('paid', {
    id: '018f47d2-6a27-7c23-a49d-000000000250',
    buyerPubky: ids.buyer,
    sellerPubky: ids.seller,
    paymentMethod: 'paypal',
    fiatVerification: 'gateway-notified',
    fiatTransactionRef: '5TY05013RG002845M',
    lines: [
      {
        listingAggregateId: `listing:${ids.seller}_american_thugs`,
        listingRevision: 1,
        contentHash: 'a'.repeat(64),
        title: 'American Thugs test image',
        quantity: 1,
        unitPrice: usd,
        subtotal: usd,
      },
    ],
    subtotal: usd,
    shipping: { amountMinor: 0, currency: 'USD', exponent: 2 },
    total: usd,
  });
  return {
    notifications: [
      createNotificationFixture('order_created', {
        id: '018f47d2-6a27-7c23-a62f-000000000001',
        aggregateId: `order:${order.id}`,
        createdAt: '2026-09-23T10:00:00.000Z',
        readAt: null,
      }),
      createNotificationFixture('payment_method_bound', {
        id: '018f47d2-6a27-7c23-a62f-000000000002',
        aggregateId: `order:${order.id}`,
        createdAt: '2026-09-23T10:01:00.000Z',
        readAt: null,
      }),
      createNotificationFixture('payment_confirmed', {
        id: '018f47d2-6a27-7c23-a62f-000000000003',
        aggregateId: `order:${order.id}`,
        actorPubky: 'paypal-ipn',
        createdAt: '2026-09-23T10:02:00.000Z',
        readAt: null,
      }),
    ],
    orders: [
      {
        order,
        payment: createPaymentFixture('confirmed', { orderId: order.id, amount: usd }),
        receipt: createReceiptFixture({
          orderId: order.id,
          contentHash: `9b307f${'a'.repeat(58)}`,
        }),
      },
    ],
  };
});

const notificationView = vi.hoisted(() => ({ notifications: [] as unknown[] }));
const ordersState = vi.hoisted(() => ({
  orders: [] as unknown[],
  isLoading: false,
  error: null as string | null,
  adapterMode: 'transaction-service' as const,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/marketplace/orders',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({
    currentUserPubky: ids.seller,
    session: { pubky: ids.seller },
  }),
}));

vi.mock('@/hooks/useMarketplaceNotifications/useMarketplaceNotifications', () => ({
  useMarketplaceNotifications: () => ({
    notifications: notificationView.notifications,
    preferences: null,
    unreadCount: 0,
    isLoading: false,
    error: null,
    needsSession: false,
    canMarkRead: false,
    markAllRead: vi.fn(),
    updatePreferences: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: [], markAllSeen: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: <T,>(action: () => T) => action() }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: null, isLoading: false }),
}));

vi.mock('@/hooks/useEncryptedConversation/useEncryptedConversation', () => ({
  useEncryptedConversation: () => ({
    status: 'ready',
    errorMessage: null,
    thread: [],
    receiverProvisioned: false,
    draft: '',
    setDraft: vi.fn(),
    bodyBudgetBytes: 620,
    draftBytes: 0,
    isSending: false,
    sendError: null,
    send: vi.fn(async () => 'queued'),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: ordersState.orders,
    isLoading: ordersState.isLoading,
    error: ordersState.error,
    needsSession: false,
    adapterMode: ordersState.adapterMode,
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment', () => ({
  useMarketplaceLocksPayment: () => ({
    enabled: false,
    correlation: null,
    isStarting: false,
    isUnlocking: false,
    delivery: null,
    start: vi.fn(async () => false),
    unlock: vi.fn(async () => false),
    resumePolling: vi.fn(),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

async function saveSurface(selector: string, name: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  const target = `${EVIDENCE}/${name}.png`;
  try {
    const saved = await page.elementLocator(element).screenshot({
      path: target,
      base64: true,
    });
    console.info(`PROOF ${name} path=${saved.path} base64Bytes=${saved.base64.length}`);
  } catch (error) {
    // The Linux gate runs this file in a container that does not mount the
    // host evidence directory. The assertions above are the gate; the PNG
    // write is the host proof.
    const saved = await page.elementLocator(element).screenshot({ base64: true });
    if (saved.base64.length < 1000) throw error;
    console.info(`PROOF ${name} path=skipped base64Bytes=${saved.base64.length}`);
  }
}

describe('PayPal sale activity copy', () => {
  beforeEach(async () => {
    const ready = await fixtures;
    notificationView.notifications = ready.notifications;
    ordersState.orders = ready.orders;
    ordersState.isLoading = false;
    ordersState.error = null;
  });

  it('maps the checkout, bind, and confirmation sequence without an integrity banner', async () => {
    await renderForVRT(<MarketplaceNotifications />, { viewport: { width: 900, height: 900 } });
    const surface = document.querySelector('[data-surface="marketplace-transaction-history"]');
    expect(surface).toBeTruthy();
    expect(surface?.textContent).toContain('Checkout started');
    expect(surface?.textContent).toContain('Payment method connected');
    expect(surface?.textContent).toContain('Payment confirmed');
    expect(surface?.textContent).not.toContain('history may be incomplete');
    expect(surface?.textContent).not.toContain('Integrity notice');
    expect(surface?.textContent).not.toContain('not available yet');
    await saveSurface('[data-surface="marketplace-transaction-history"]', 'activity-history');
  });

  it('wraps the PayPal-verified explanation and hides the receipt hash', async () => {
    await renderForVRT(<MarketplaceOrders />, { viewport: { width: 1100, height: 1400 } });
    const orders = document.querySelector('[data-surface="marketplace-orders"]');
    const card = document.querySelector('[data-surface="marketplace-payment-status-card"]');
    expect(orders).toBeTruthy();
    expect(card).toBeTruthy();
    const explanation = document.querySelector('[data-testid="paypal-verified-explanation"]');
    if (!(explanation instanceof HTMLElement)) throw new Error('missing paypal explanation');
    expect(explanation.textContent).toContain('exact order total');
    expect(explanation.scrollWidth).toBeLessThanOrEqual(explanation.clientWidth + 1);
    const reference = document.querySelector('[data-testid="order-reference-label"]');
    if (!(reference instanceof HTMLElement)) throw new Error('missing order reference');
    expect(reference.textContent).toBe('Order 018f47d2');
    expect(document.querySelector('[data-testid="order-reference-copy"]')?.textContent).toBe('Copy');
    const paypal = document.querySelector('[data-testid="open-in-paypal"]');
    if (!(paypal instanceof HTMLAnchorElement)) throw new Error('missing Open in PayPal');
    expect(paypal.textContent).toContain('Open in PayPal');
    expect(paypal.getAttribute('href')).toBe('https://www.paypal.com/myaccount/activities/details/5TY05013RG002845M');
    const details = document.querySelector('[data-testid="order-receipt-details"]');
    if (!(details instanceof HTMLDetailsElement)) throw new Error('missing receipt details');
    expect(details.open).toBe(false);
    const hashLine = details.querySelector('[data-testid="order-receipt-hash"]');
    if (!(hashLine instanceof HTMLElement)) throw new Error('missing receipt hash line');
    expect(hashLine.getClientRects().length).toBe(0);
    await saveSurface('[data-surface="marketplace-orders"]', 'seller-order-wrapped');
    await userEvent.click(details.querySelector('summary') as HTMLElement);
    expect(details.open).toBe(true);
    expect(hashLine.getClientRects().length).toBeGreaterThan(0);
    expect(hashLine.textContent).toContain('Receipt integrity 9b307f');
  });
});
