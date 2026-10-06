'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { usePassportSignIn } from '@/hooks/usePassportSignIn/usePassportSignIn';

export const PASSPORT_SIGN_IN_HINT =
  'Pubky Passport signs you in with your Google account and creates your Pubky identity if you have none. Messages are not available with Passport sign-ins yet.';

/**
 * "Continue with Google" through Pubky Passport. Renders nothing where the
 * grant key cannot be held (no secure context, IndexedDB or WebCrypto
 * Ed25519) or the deploy turned Passport off.
 */
export function PassportSignInButton() {
  const passport = usePassportSignIn();
  if (!passport.isAvailable) return null;
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-2" data-testid="sign-in-passport-option">
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
          'Continue with Google'
        )}
      </Button>
      <Typography as="p" className="text-center text-sm text-muted-foreground">
        {PASSPORT_SIGN_IN_HINT}
      </Typography>
    </div>
  );
}
