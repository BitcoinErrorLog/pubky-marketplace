'use client';

import { useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import {
  type ExportPrivRecoveryKeyStatus,
  useExportPrivRecoveryKey,
} from '@/hooks/useExportPrivRecoveryKey/useExportPrivRecoveryKey';
import { SettingsSection } from '@/molecules/Settings/SettingsSection/SettingsSection';
import { SettingsSectionCard } from '@/molecules/Settings/SettingsSectionCard/SettingsSectionCard';
import { MarketplaceReauthDialog } from '@/organisms/Marketplace/MarketplaceReauthDialog';

const STATUS_COPY: Partial<Record<ExportPrivRecoveryKeyStatus, string>> = {
  exported: 'Recovery key downloaded. Store it offline, away from this device.',
  needs_reauth:
    'The marketplace releases your recovery key only to a purchase session that includes your private Shop data. Approve one, then export again.',
  unavailable: 'The marketplace cannot provide your recovery key right now. Try again later.',
  error: 'The recovery key could not be exported. Try again.',
};

export function MarketplaceRecoveryKey() {
  const { isAvailable, status, exportKey } = useExportPrivRecoveryKey();
  const [isOpen, setIsOpen] = useState(false);
  const isExporting = status === 'exporting';

  if (!isAvailable) return null;

  const handleDownload = async () => {
    await exportKey();
    setIsOpen(false);
  };

  return (
    <SettingsSectionCard icon={KeyRound} title={'Marketplace data'}>
      <SettingsSection
        title={'Export recovery key'}
        description={
          'Your watchlist and order receipts are stored encrypted on your homeserver. The recovery key lets you read them without the marketplace.'
        }
        buttonText={'Export recovery key'}
        buttonIcon={KeyRound}
        buttonId="export-recovery-key-btn"
        buttonDisabled={isExporting}
        buttonOnClick={() => setIsOpen(true)}
      />
      {STATUS_COPY[status] && (
        <Typography as="p" size="sm" className="text-secondary-foreground" data-testid="export-recovery-key-status">
          {STATUS_COPY[status]}
        </Typography>
      )}
      {status === 'needs_reauth' && (
        <div>
          <MarketplaceReauthDialog triggerLabel="Approve private data" refusal="purchase_session" />
        </div>
      )}
      <Dialog open={isOpen} onOpenChange={(open) => !isExporting && setIsOpen(open)}>
        <DialogContent className="max-w-md sm:max-w-lg" hiddenTitle={'Export recovery key'}>
          <DialogHeader>
            <DialogTitle>{'Export recovery key'}</DialogTitle>
          </DialogHeader>
          <Typography className="text-base leading-6 font-normal tracking-wide text-white/80">
            {
              'Anyone who has this file can read your encrypted watchlist and order receipts. Keep it offline and never share it.'
            }
          </Typography>
          <DialogFooter>
            <Button
              id="export-recovery-key-confirm-btn"
              size="lg"
              onClick={() => void handleDownload()}
              disabled={isExporting}
              className="order-1 sm:order-2"
            >
              <Download className="h-4 w-4" />
              {isExporting ? 'Exporting...' : 'Download recovery key'}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setIsOpen(false)}
              disabled={isExporting}
              className="order-2 sm:order-1"
            >
              {'Cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSectionCard>
  );
}
