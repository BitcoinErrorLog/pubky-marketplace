import { Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { BasePathImage as Image } from '@/atoms/BasePathImage/BasePathImage';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Typography } from '@/atoms/Typography/Typography';
import { Bitkit, PubkyIcon } from '@/icons';
import { cn } from '@/libs/utils/utils';
import type { QrCodeSlotProps } from './QrCodeSlot.types';

const DEFAULT_QR_SIZE = 176;
const HOVER_OPACITY = 'transition-opacity group-hover:opacity-90 group-active:opacity-80';

export function QrCodeSlot({
  isLoading,
  isExpired,
  url,
  generatingLabel,
  clickToReloadLabel,
  size = DEFAULT_QR_SIZE,
  fillWidth = false,
  activeQrHasHoverEffect = false,
  expiredReloadAction,
  showRingLogo = true,
  logo = showRingLogo ? 'ring' : undefined,
}: QrCodeSlotProps) {
  if (isLoading || (!url && !isExpired)) {
    return (
      <Container className="items-center gap-2">
        <Loader2 className="size-8 animate-spin text-background" />
        <Typography as="small" size="sm" className="text-background">
          {generatingLabel}
        </Typography>
      </Container>
    );
  }

  if (isExpired) {
    const blurredQr = (
      <>
        <Image
          src="/images/qr-blurred.png"
          alt=""
          width={size}
          height={size}
          className={cn('rounded-md', fillWidth && 'h-auto w-full', HOVER_OPACITY)}
        />
        <Button
          asChild
          variant="secondary"
          size="sm"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <span>{clickToReloadLabel}</span>
        </Button>
      </>
    );

    if (expiredReloadAction) {
      return (
        <button
          type="button"
          onClick={expiredReloadAction.onClick}
          aria-label={expiredReloadAction.ariaLabel}
          className="group absolute inset-0 flex cursor-pointer items-center justify-center p-4"
        >
          {blurredQr}
        </button>
      );
    }

    return blurredQr;
  }

  // The URL carries the relay channel secret: it is drawn into the QR only,
  // never written to a DOM attribute where a CSS attribute selector can read it.
  return (
    <span data-testid="qr-auth-url" className="contents">
      <QRCodeSVG
        value={url}
        size={size}
        className={cn(fillWidth && 'h-auto w-full', activeQrHasHoverEffect && HOVER_OPACITY)}
      />
      {logo && (
        <span
          className={cn(
            'absolute top-1/2 left-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#05050A]',
            activeQrHasHoverEffect && HOVER_OPACITY,
          )}
        >
          {logo === 'bitkit' ? (
            <Bitkit size={24} className="size-6" role="img" aria-label="Bitkit" />
          ) : (
            <PubkyIcon
              size={24}
              className="size-6 text-white [&_path]:fill-current"
              role="img"
              aria-label="Pubky Ring"
            />
          )}
        </span>
      )}
    </span>
  );
}
