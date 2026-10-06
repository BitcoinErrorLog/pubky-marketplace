import type { useMobileAuth } from '@/hooks/useMobileAuth/useMobileAuth';

export type SignerAuth = ReturnType<typeof useMobileAuth>;

/** What one signer's QR and deeplink button say. */
export type SignerAuthCopy = {
  name: string;
  hint: string;
  identityHint: string | null;
  copyLabel: string;
  reloadLabel: string;
  openingLabel: string;
  showRingLogo: boolean;
};

export type SignerAuthOptionProps = {
  copy: SignerAuthCopy;
  auth: SignerAuth;
  onCopied: () => Promise<void>;
  testId: string;
  /** Sentence shown under the QR when its approval also produces a marketplace session. */
  disclosure?: string | null;
};

export type SignerAuthorizeButtonProps = {
  copy: SignerAuthCopy;
  auth: SignerAuth;
  testId: string;
};
