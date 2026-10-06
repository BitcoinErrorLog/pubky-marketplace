// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceRecoveryKey } from '@/organisms/Settings/MarketplaceRecoveryKey/MarketplaceRecoveryKey';

const hook = vi.hoisted(() => ({
  isAvailable: true,
  status: 'idle' as string,
  exportKey: async () => true,
}));

vi.mock('@/hooks/useExportPrivRecoveryKey/useExportPrivRecoveryKey', () => ({
  useExportPrivRecoveryKey: () => hook,
}));

function SettingsHarness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">{children}</main>;
}

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error('Dialog has not opened yet.');
  });
}

describe('Settings marketplace recovery key — visual regression', () => {
  it('renders the export section at desktop viewport', async () => {
    hook.status = 'idle';
    const screen = await renderForVRT(
      <SettingsHarness>
        <MarketplaceRecoveryKey />
      </SettingsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('settings-recovery-key-desktop');
  });

  it('renders the confirmation dialog at desktop viewport', async () => {
    hook.status = 'idle';
    const screen = await renderForVRT(
      <SettingsHarness>
        <MarketplaceRecoveryKey />
      </SettingsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Export recovery key' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('settings-recovery-key-dialog-desktop');
  });

  it('renders the re-approval state at mobile viewport', async () => {
    hook.status = 'needs_reauth';
    const screen = await renderForVRT(
      <SettingsHarness>
        <MarketplaceRecoveryKey />
      </SettingsHarness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('settings-recovery-key-needs-reauth-mobile');
  });
});
