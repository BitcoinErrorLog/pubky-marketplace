// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { DropMissionControl } from '@/organisms/Marketplace/DropMissionControl';

const SELLER = vi.hoisted(() => 'y'.repeat(52));

// Frozen VRT clock is 2026-01-01T12:00:00Z (see vrt.setup.ts): the live
// scenario's endsAt is exactly twelve hours out, so the corrected countdown
// renders a stable 12:00:00 with offset 0.
const view = vi.hoisted(() => ({
  state: 'live' as string,
  drop: null as Record<string, unknown> | null,
}));

const baseDrop = vi.hoisted(() => ({
  sellerPubky: 'y'.repeat(52),
  dropId: 'drop1',
  aggregateId: `drop:${'y'.repeat(52)}_drop1`,
  format: 'fcfs',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-01-02T00:00:00.000Z',
  stockDisplay: 'exact',
  totalQuantity: 100,
  perBuyerLimit: 2,
  revision: 3,
  serverTime: '2026-01-01T12:00:00.000Z',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell/drops/drop1',
}));

vi.mock('@/hooks/useOwnDrop/useOwnDrop', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useOwnDrop/useOwnDrop')>('@/hooks/useOwnDrop/useOwnDrop');
  return {
    ...actual,
    useOwnDrop: () => ({
      drop: view.drop,
      record: { dropId: 'drop1', ownerPubky: SELLER, title: 'Winter capsule — 100 numbered pieces' },
      isLoading: false,
      isDurable: true,
      offsetMs: 0,
      refresh: async () => undefined,
      cancel: async () => ({ ok: false, conflict: false, message: null }),
      releaseListings: async () => ({ ok: false, conflict: false, message: null }),
      syncRegistration: async () => undefined,
      isActing: false,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace drop mission control — visual regression', () => {
  it('renders the LIVE dashboard (countdown, exact numbers, kill switch) at desktop viewport', async () => {
    view.drop = { ...baseDrop, state: 'live', remaining: 37, paidQuantity: 63, buyerCount: 51 };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-live-desktop');
  });

  it('renders the LIVE dashboard at mobile viewport', async () => {
    view.drop = { ...baseDrop, state: 'live', remaining: 37, paidQuantity: 63, buyerCount: 51 };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-live-mobile');
  });

  it('renders the ANNOUNCED dashboard with the pre-launch countdown at desktop viewport', async () => {
    view.drop = {
      ...baseDrop,
      state: 'announced',
      startsAt: '2026-01-02T00:00:00.000Z',
      endsAt: '2026-01-03T00:00:00.000Z',
      remaining: 100,
      paidQuantity: 0,
      buyerCount: 0,
    };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-announced-desktop');
  });

  it('renders the ENDED sold-out results and release panel at desktop viewport', async () => {
    view.drop = { ...baseDrop, state: 'ended_sold_out', remaining: 0, paidQuantity: 100, buyerCount: 74 };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-sold-out-desktop');
  });

  it('renders the ENDED cancelled state honestly at desktop viewport', async () => {
    view.drop = { ...baseDrop, state: 'ended_cancelled', remaining: 41, paidQuantity: 59, buyerCount: 48 };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-cancelled-desktop');
  });

  it('renders the ENDED closed state honestly at desktop viewport', async () => {
    view.drop = { ...baseDrop, state: 'ended_closed', remaining: 2, paidQuantity: 98, buyerCount: 74 };

    const screen = await renderForVRT(<DropMissionControl dropId="drop1" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-mission-control-closed-desktop');
  });
});
