// Intentional import order — vi.hoisted + vi.mock factories rely on stable
// Vitest `__vi_import_N__` aliases; reordering causes a TDZ crash in
// @vitest/browser. Do not let `eslint --fix` reorder these imports.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_DENSE_CHROME_SCREENSHOT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { createZustandLikeHook } from '@/test-utils/stores';
import { Header } from '@/organisms/Header/Header';
import { Profile } from '@/templates/Onboarding/Profile/Profile';

// The real app mounts <Header /> from the root layout above every page; on
// /onboarding/* it renders the "Create account" step bar (1–5). Render it here
// so the snapshot matches what the user actually sees.
function ProfileWithHeader() {
  return (
    <>
      <Header />
      <Profile />
    </>
  );
}

// `CreateProfileForm` runs `useProfileForm({ mode: 'create' })`. Its prefill
// read finds no existing profile here, so the render is the empty form with a
// pubky-derived FacehashAvatar (deterministic under the seeded Math.random in
// `renderForVRT`).
vi.mock('@/controllers/profile/profile', () => ({
  ProfileController: {
    readProfileSeed: vi.fn(async () => null),
    commitCreate: vi.fn(),
    commitUpdate: vi.fn(),
  },
}));
vi.mock('next/navigation', () => {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    useRouter: () => router,
    usePathname: () => '/onboarding/profile',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
  };
});

vi.mock('@/molecules/Toaster/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
  toast: vi.fn(),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createZustandLikeHook({
    currentUserPubky: 'vrt000000000000000000000000000000000000000000alice01',
    selectCurrentUserPubky: () => 'vrt000000000000000000000000000000000000000000alice01',
    hasHydrated: true,
  }),
}));

vi.mock('@/stores/onboarding/onboarding.store', () => ({
  useOnboardingStore: createZustandLikeHook({
    secretKey: 'vrt-fixed-secret-key',
    inviteCode: null as string | null,
    setShowWelcomeDialog: vi.fn(),
    setInviteCode: vi.fn(),
    reset: vi.fn(),
    hasHydrated: true,
  }),
}));

// Header reads public-route state (auth store is mocked above).
vi.mock('@/hooks/usePublicRoute/usePublicRoute', () => ({
  usePublicRoute: () => ({ isCoreExploreRoute: false, isDynamicPublicRoute: false }),
}));

describe('Profile (onboarding) — visual regression', () => {
  it('renders the create-profile page at desktop viewport', async () => {
    const screen = await renderForVRT(<ProfileWithHeader />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'onboarding-profile-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the create-profile page at mobile viewport', async () => {
    const screen = await renderForVRT(<ProfileWithHeader />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('onboarding-profile-mobile');
  });
});
