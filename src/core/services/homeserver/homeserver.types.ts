import type { AuthToken, Capabilities, PublicKey, Session } from '@synonymdev/pubky';
import type { TKeypairParams } from '@/application/auth/auth.types';
import { HttpMethod } from '@/libs/http/http.types';

export type FetchOptions = {
  method?: HttpMethod;
  body?: string | Uint8Array;
};

export type THomeserverSignUpParams = TKeypairParams & {
  signupToken: string;
};

export type THomeserverPublicKeyParams = {
  publicKey: PublicKey;
};

/** Homeserver signup token verification outcome from GET /signup_tokens/<token>. */
export type TSignupTokenVerificationStatus = 'valid' | 'used' | 'invalid';

export type THomeserverSessionResult = {
  session: Session;
};

export type TGenerateAuthUrlResult = {
  authorizationUrl: string;
  awaitApproval: Promise<Session>;
  cancelAuthFlow: () => void;
};

export type TGenerateAuthTokenFlowResult = {
  authorizationUrl: string;
  awaitToken: () => Promise<AuthToken>;
  cancelAuthFlow: () => void;
};

export type THomeserverRestoreSessionParams = {
  sessionExport: string;
};

export type CancelableAuthApproval = {
  awaitApproval: Promise<Session>;
  cancel: () => void;
};

/**
 * Type alias for pub path pattern.
 * Represents paths that start with '/pub/' followed by any string.
 *
 * @example
 * ```typescript
 * const validPath: PubPath<string> = '/pub/user/profile';
 * const validPath2: PubPath<string> = '/pub/pubky.app/:rw';
 * ```
 */
export type PubPath<T extends string = string> = `/pub/${T}`;

/**
 * Type alias for private path pattern.
 * Represents paths that start with '/priv/' — the homeserver's authenticated
 * private storage (only the owner's sessions can read, list, or write).
 */
export type PrivPath<T extends string = string> = `/priv/${T}`;

/**
 * A path the current session owns outright: its own `/pub/` or `/priv/` tree.
 */
export type OwnedPath<T extends string = string> = PubPath<T> | PrivPath<T>;

export type TGenerateSignupAuthUrlParams = {
  inviteCode: string;
  caps?: Capabilities;
};

export type THomeserverFetchParams = {
  url: string;
  options?: FetchOptions;
  /** The URL recorded in error context and logs; defaults to `url`. */
  logUrl?: string;
};

export type THomeserverRequestParams = {
  method: HttpMethod;
  url: string;
  bodyJson?: Record<string, unknown>;
  /** The URL recorded in error context and logs; defaults to `url`. Unpublished paths pass a redacted form. */
  logUrl?: string;
  /** A PUT or DELETE makes one attempt and never sleeps; the caller backs off outside its lock. */
  singleAttempt?: boolean;
};

export type THomeserverGetJsonIfFoundParams = {
  url: string;
  /** The URL recorded in error context and logs; defaults to `url`. Unpublished paths pass a redacted form. */
  logUrl?: string;
};

/** A GET that may find nothing: `json` is the parsed body, `undefined` for an empty or non-JSON one. */
export type THomeserverJsonIfFound<T> = { found: false } | { found: true; json: T | undefined };

export type TPutBlobParams = {
  url: string;
  blob: Uint8Array;
  /** The URL recorded in error context and logs; defaults to `url`. Unpublished paths pass a redacted form. */
  logUrl?: string;
};

export type TGetBlobParams = {
  url: string;
  /** The URL recorded in error context and logs; defaults to `url`. Unpublished paths pass a redacted form. */
  logUrl?: string;
  /** The most bytes to read; a larger body is refused before it is held in memory. */
  maxBytes?: number;
};

export type THomeserverListParams = {
  baseDirectory: string;
  cursor?: string;
  reverse?: boolean;
  limit?: number;
  /** Logged and put in error context instead of `baseDirectory`. */
  logUrl?: string;
};

export type THomeserverListAllParams = Pick<THomeserverListParams, 'baseDirectory'>;

export type THomeserverUserEvent = {
  cursor: string;
  eventType: string;
};

// Utility function parameter types
export type TParseResponseOrUndefinedParams = {
  response: Response;
  operation?: string;
  url?: string;
};

export type TResolveOwnedSessionPathParams = {
  url: string;
  session: Session | null;
  ownedPathPrefixes: readonly string[];
};

export type TOwnedSessionPath = {
  session: Session;
  path: OwnedPath<string>;
};

export type TCheckSessionExpirationParams = {
  response: Response;
  url: string;
};

export type TAssertOkParams = {
  response: Response;
  url: string;
  operation: string;
};

export type TGetOwnedResponseParams = {
  session: Session;
  path: OwnedPath<string>;
  url: string;
};

// Error utility function parameter types
export type TThrowSessionExpiredErrorParams = {
  errorMessage: string;
  additionalContext: Record<string, unknown>;
};

export type TThrowInvalidInputErrorParams = {
  errorMessage: string;
  additionalContext: Record<string, unknown>;
};

export type TThrowPkarrLookupErrorParams = {
  errorMessage: string;
  additionalContext: Record<string, unknown>;
};

export type TThrowHomeserverErrorParams = {
  statusCode: number;
  errorMessage: string;
  additionalContext: Record<string, unknown>;
};

export type THandleTypedErrorParams = {
  errorMessage: string;
  errorName: string | undefined;
  statusCode: number;
  additionalContext: Record<string, unknown>;
};

export type THandleErrorParams = {
  error: unknown;
  additionalContext?: Record<string, unknown>;
  statusCode?: number;
  alwaysUseHomeserverError?: boolean;
};
