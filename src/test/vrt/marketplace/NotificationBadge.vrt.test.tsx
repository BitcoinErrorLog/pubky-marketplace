// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';
import { HeaderSignIn } from '@/molecules/HeaderSignIn/HeaderSignIn';
import { useNotificationStore } from '@/stores/notification/notification.store';

// The app-wide unread badge (header avatar) reads the REAL notification
// store's total selector, so these scenarios drive the store directly: the
// badge must show social + marketplace unread as one count, and no badge at
// all when both are 0 — a durable-mode marketplace contribution is always 0
// because immutable outbox rows cannot be marked read.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({
    userDetails: { name: 'Satoshi', image: null, indexed_at: 0 },
    currentUserPubky: 'v'.repeat(52),
  }),
}));

vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));

// The search organism drags in stores and autocomplete plumbing that are
// irrelevant to the badge; a fixed-size placeholder keeps layout stable.
vi.mock('@/organisms/SearchInput/SearchInput', () => ({
  SearchInput: () => <div style={{ width: 240, height: 40 }} />,
}));

describe('Notification badge with marketplace unread — visual regression', () => {
  afterEach(() => {
    useNotificationStore.getState().reset();
  });

  it('shows one combined badge for social plus marketplace unread at desktop viewport', async () => {
    useNotificationStore.getState().setUnread(2);
    useNotificationStore.getState().setMarketplaceUnread(3);

    const screen = await renderForVRT(<HeaderSignIn />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('notification-badge-combined-desktop');
  });

  it('shows no badge when social and marketplace unread are both 0 (durable marketplace rows never count)', async () => {
    useNotificationStore.getState().setUnread(0);
    useNotificationStore.getState().setMarketplaceUnread(0);

    const screen = await renderForVRT(<HeaderSignIn />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('notification-badge-empty-desktop');
  });
});
