import type { MarketplaceSessionFlow } from '@/services/marketplace/marketplace-session';

export type { TRestorePersistedSessionResult } from '@/application/auth/auth.types';

/**
 * The bridged first-commerce flow as handed to hooks. `joined: true` marks a
 * handle that JOINS a ceremony another surface already owns (e.g. a direct
 * sign-in in progress, whose approval URL this dialog never sees
 * synchronously): the hook must show an "already in progress elsewhere" state
 * instead of a blank QR. An own (non-joined) flow always carries its URL.
 */
export type TBridgedCommerceSessionFlow = MarketplaceSessionFlow & { joined?: boolean };

export interface TSignUpParams {
  secretKey: string;
  signupToken: string;
}

export interface TLoginWithMnemonicParams {
  mnemonic: string;
}

export interface TLoginWithEncryptedFileParams {
  encryptedFile: File;
  password: string;
}
