'use client';

import { Container } from '@/atoms/Container/Container';
import { useSignInStore } from '@/stores/signIn/signIn.store';
import { DialogRestoreEncryptedFile } from '../DialogRestoreEncryptedFile/DialogRestoreEncryptedFile';
import { DialogRestoreRecoveryPhrase } from '../DialogRestoreRecoveryPhrase/DialogRestoreRecoveryPhrase';

export const SignInNavigation = () => {
  const authUrlResolved = useSignInStore((state) => state.authUrlResolved);

  if (authUrlResolved) return null;

  // RouteGuardProvider owns post-auth navigation: it consumes a stored return
  // path, otherwise AUTHENTICATED.redirectTo is HOME (`/home`) when the user is
  // still on `/sign-in` (not in AUTHENTICATED.allowedRoutes). Pushing HOME here
  // raced the guard and clobbered a stored return path.
  const handleRestore = () => {};

  return (
    <Container className="flex-col-reverse justify-start gap-3 md:flex-row lg:gap-6">
      <Container className="mx-0 w-auto flex-col items-start justify-start gap-3 sm:mx-auto sm:w-full sm:flex-row">
        <DialogRestoreRecoveryPhrase onRestore={handleRestore} />
        <DialogRestoreEncryptedFile onRestore={handleRestore} />
      </Container>
    </Container>
  );
};
