'use client';

import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { usePassportSignIn } from '@/hooks/usePassportSignIn/usePassportSignIn';

/**
 * "Continue with Google" through Pubky Passport. Renders nothing where the
 * grant key cannot be held (no secure context, IndexedDB or WebCrypto
 * Ed25519) or the deploy turned Passport off.
 */
export function PassportSignInButton({ showAppleOption = false }: { showAppleOption?: boolean }) {
  const passport = usePassportSignIn();
  if (!passport.isAvailable) return null;
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3" data-testid="sign-in-passport-option">
      <Button
        className="w-full"
        size="lg"
        variant="secondary"
        onClick={passport.start}
        disabled={passport.isPending}
        aria-busy={passport.isPending}
        data-testid="sign-in-passport-button"
      >
        {passport.isPending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
            <Typography as="span" overrideDefaults aria-live="polite">
              {'Waiting for Pubky Passport...'}
            </Typography>
          </>
        ) : (
          <>
            <Image src="/images/sign-in/google.svg" alt="" width={16} height={16} />
            Continue with Google
          </>
        )}
      </Button>
      {showAppleOption && (
        <Button className="w-full disabled:opacity-40" size="lg" variant="secondary" disabled>
          <Image src="/images/sign-in/apple.svg" alt="" width={16} height={16} />
          Continue with Apple
        </Button>
      )}
    </div>
  );
}
