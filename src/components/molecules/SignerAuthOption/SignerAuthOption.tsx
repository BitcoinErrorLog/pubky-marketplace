'use client';

import { Key, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { cn } from '@/libs/utils/utils';
import { MarketplaceApprovalDisclosure } from '@/molecules/MarketplaceApprovalDisclosure/MarketplaceApprovalDisclosure';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import type { SignerAuthCopy, SignerAuthOptionProps, SignerAuthorizeButtonProps } from './SignerAuthOption.types';

export const BITKIT_IDENTITY_HINT =
  "New Bitkit users must create a Pubky identity in Bitkit's profile before scanning.";

/**
 * Sign-up copy. The Pubky Ring create QR is the one sign-up QR: Pubky Ring and
 * Bitkit both turn it into a new pubky and its homeserver account. Someone
 * whose pubky already lives in Bitkit or Pubky Ring signs in instead (#49).
 */
export const SIGN_UP_COPY = {
  subtitleDesktop: 'Scan with Pubky Ring or Bitkit to create a new pubky.',
  subtitleMobile: 'Tap the button to create a new pubky in Pubky Ring or Bitkit.',
  hint: "In Pubky Ring, tap 'add pubky' and scan.",
  existingPubky: 'Already have a pubky in Pubky Ring or Bitkit?',
  signInLink: 'Sign in instead',
} as const;

/** Sign-in copy for the two signers the Shop offers side by side. */
export const SIGNER_AUTH_COPY = {
  signIn: {
    ring: {
      name: 'Pubky Ring',
      hint: 'Scan with Pubky Ring.',
      identityHint: null,
      copyLabel: 'Copy authentication link',
      reloadLabel: 'Reload sign-in QR code',
      openingLabel: 'Opening Pubky Ring...',
      showRingLogo: true,
    },
    bitkit: {
      name: 'Bitkit',
      hint: 'Scan with Bitkit.',
      identityHint: BITKIT_IDENTITY_HINT,
      copyLabel: 'Copy Bitkit authentication link',
      reloadLabel: 'Reload Bitkit sign-in QR code',
      openingLabel: 'Opening Bitkit...',
      showRingLogo: false,
    },
  },
} as const satisfies Record<'signIn', Record<'ring' | 'bitkit', SignerAuthCopy>>;

/** The one sign-up QR, which either phone signer can scan. */
export const SIGN_UP_SIGNER_COPY = {
  name: 'Pubky Ring or Bitkit',
  hint: SIGN_UP_COPY.hint,
  identityHint: null,
  copyLabel: 'Copy sign-up link',
  reloadLabel: 'Reload sign-up QR code',
  openingLabel: 'Opening signer...',
  showRingLogo: false,
} as const satisfies SignerAuthCopy;

/** One signer's labelled QR in the side-by-side desktop layout. */
export function SignerAuthOption({
  copy,
  auth,
  onCopied,
  testId,
  disclosure = null,
  qrOnly = false,
}: SignerAuthOptionProps) {
  const { url, isLoading, isExpired, fetchUrl } = auth;
  const handleQRClick = async () => {
    if (!url) return;
    await onCopied();
  };
  const qrButton = (
    <button
      type="button"
      data-testid={qrOnly ? testId : undefined}
      className={cn(
        'group relative flex cursor-pointer items-center justify-center rounded-md bg-foreground p-2',
        qrOnly ? 'aspect-square w-full' : 'size-48',
      )}
      onClick={isExpired ? fetchUrl : handleQRClick}
      disabled={isLoading || (!url && !isExpired)}
      aria-label={isExpired ? copy.reloadLabel : copy.copyLabel}
    >
      <span className={qrOnly ? 'relative flex aspect-square w-full items-center justify-center' : 'contents'}>
        <QrCodeSlot
          isLoading={isLoading}
          isExpired={isExpired}
          url={url}
          generatingLabel={'Generating QR Code...'}
          clickToReloadLabel={'Click to reload'}
          activeQrHasHoverEffect
          fillWidth={qrOnly}
          logo={copy.showRingLogo ? 'ring' : 'bitkit'}
        />
      </span>
    </button>
  );
  if (qrOnly) return qrButton;
  return (
    <div className="flex flex-col items-center gap-4" data-testid={testId}>
      <Typography as="h2" className="text-xl font-bold text-foreground">
        {copy.name}
      </Typography>
      {qrButton}
      <Typography as="span" className="text-center text-muted-foreground">
        {copy.hint}
      </Typography>
      {copy.identityHint ? (
        <Typography as="p" className="max-w-48 text-center text-sm text-muted-foreground">
          {copy.identityHint}
        </Typography>
      ) : null}
      <MarketplaceApprovalDisclosure sentence={disclosure} className="max-w-48" />
    </div>
  );
}

/** One signer's deeplink button in the stacked mobile layout. */
export function SignerAuthorizeButton({ copy, auth, testId, authorizeLabel }: SignerAuthorizeButtonProps) {
  const { url, isLoading, isExpired, isOpeningRing, onAuthorizeClick } = auth;
  const isMobileLaunching = isLoading || isOpeningRing;
  return (
    <Button
      className="w-full"
      size="lg"
      onClick={onAuthorizeClick}
      disabled={isMobileLaunching || (!url && !isExpired)}
      aria-busy={isMobileLaunching}
      data-testid={testId}
    >
      {isMobileLaunching ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          <Typography as="span" overrideDefaults aria-live="polite">
            {isOpeningRing ? copy.openingLabel : 'Generating...'}
          </Typography>
        </>
      ) : isExpired ? (
        <>
          <RefreshCw className="mr-2 size-4" />
          {'Click to reload'}
        </>
      ) : (
        <>
          <Key className="mr-2 size-4" />
          {authorizeLabel ?? `Authorize with ${copy.name}`}
        </>
      )}
    </Button>
  );
}
