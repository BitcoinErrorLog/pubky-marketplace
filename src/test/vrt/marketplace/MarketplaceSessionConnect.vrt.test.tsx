// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadImages, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';

// The QR encodes the authorization URL verbatim, so it must be a FIXED fake
// for a byte-stable matrix across runs and OSes. It is never dereferenced.
const VRT_AUTH_URL =
  'pubkyauth:///?relay=https%3A%2F%2Fvrt.invalid%2Flink%2F&capabilities=%2Fpub%2Fpubky.app%2F%3Arw&secret=vrt-fixed-secret';

const QR_LOGO_URLS = ['/images/ring-logo.svg'];

// The session-connect dialog in its three real states: awaiting approval
// (QR + deeplink affordances), the failure state with the transport's actual
// error and a fresh-flow retry, and the session-required card that durable
// surfaces render in place of the old dead end.
const view = vi.hoisted(() => ({
  status: 'awaiting' as
    | 'idle'
    | 'creating'
    | 'awaiting'
    | 'verifying'
    | 'claiming'
    | 'connected'
    | 'mismatch'
    | 'expired'
    | 'cancelled'
    | 'error',
  authorizationUrl: '',
  errorMessage: null as string | null,
  isOpeningRing: false,
  grantEnabled: false,
  bootstrap: false,
}));

const VRT_BOOTSTRAP_URL =
  'pubkyauth://signin_grant?caps=%2Fpub%2Fpubky.app%2Fmarketplace-service%2Fv1%2F%3Arw&relay=https%3A%2F%2Fvrt.invalid%2Finbox&secret=vrt-fixed-secret&cid=vrt.invalid&cpk=vrt-fixed-cpk';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/orders',
}));

// Bridged / narrow-grant arrival: the dialog asks for a Shop purchase
// approval. Direct Shop sign-in never mounts this surface with a full grant
// already in hand.
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    hasFullHomeserverGrant: () => false,
  },
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: view.status,
    authorizationUrl: view.authorizationUrl,
    errorMessage: view.errorMessage,
    // Bridged / narrow-grant arrival: the full-grant copy (mirrors the
    // CommerceController.hasFullHomeserverGrant mock above).
    requestsFullGrant: true,
    requestsGrantReconnect: view.grantEnabled && !view.bootstrap,
    requestsGrantBootstrap: view.bootstrap,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: view.isOpeningRing,
  }),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getMarketplaceGrantFlowEnabled: () => view.grantEnabled,
}));

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error('Dialog has not opened yet.');
  });
}

function Harness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

describe('Marketplace session connect — visual regression', () => {
  beforeEach(() => {
    view.status = 'awaiting';
    view.authorizationUrl = '';
    view.errorMessage = null;
    view.isOpeningRing = false;
    view.grantEnabled = false;
    view.bootstrap = false;
  });

  it('renders the Bitkit purchase bootstrap approval at desktop viewport', async () => {
    view.grantEnabled = true;
    view.bootstrap = true;
    view.authorizationUrl = VRT_BOOTSTRAP_URL;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve purchases" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve purchases' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-bitkit-bootstrap-desktop');
  });

  it('renders the awaiting-approval QR state at desktop viewport', async () => {
    view.authorizationUrl = VRT_AUTH_URL;

    await preloadImages(QR_LOGO_URLS);
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve in Pubky Ring" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-awaiting-desktop');
  });

  it('renders the awaiting-approval QR state at mobile viewport', async () => {
    view.authorizationUrl = VRT_AUTH_URL;

    await preloadImages(QR_LOGO_URLS);
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve in Pubky Ring" />
      </Harness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-awaiting-mobile');
  });

  it('renders the generating state before a URL exists at desktop viewport', async () => {
    view.status = 'idle';

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve in Pubky Ring" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-generating-desktop');
  });

  it('renders the failure state with the real error and retry at desktop viewport', async () => {
    view.status = 'error';
    view.errorMessage = 'The authorization request expired before it was approved. Start a new connection attempt.';

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve in Pubky Ring" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-error-desktop');
  });

  it('renders the signer-neutral BFF creating state at desktop viewport', async () => {
    view.grantEnabled = true;
    view.status = 'creating';
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve purchases" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve purchases' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-bff-creating-desktop');
  });

  it('renders the signer-neutral identity mismatch at desktop viewport', async () => {
    view.grantEnabled = true;
    view.status = 'mismatch';
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionConnectDialog triggerLabel="Approve purchases" />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Approve purchases' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-connect-bff-mismatch-desktop');
  });

  it('renders the session-required card that replaces durable-mode dead ends at desktop viewport', async () => {
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionRequiredCard />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-required-card-desktop');
  });

  it('renders the session-required card at mobile viewport', async () => {
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceSessionRequiredCard />
      </Harness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('session-required-card-mobile');
  });
});
