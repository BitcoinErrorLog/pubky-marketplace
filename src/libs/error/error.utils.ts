import { getDeployEnv } from '@/config/network';
import { AppError, isAppError } from './error';
import { AuthErrorCode, ClientErrorCode, DatabaseErrorCode, ServerErrorCode } from './error.codes';
import { Err } from './error.factories';
import { ErrorCategory, ErrorService } from './error.types';

// Re-export isAppError for convenience
export { isAppError };

// =============================================================================
// Category Checks
// =============================================================================

/** Check if error is a network error (connection-level failures) */
export const isNetworkError = (e: AppError): boolean => e.category === ErrorCategory.Network;

/** Check if error is a timeout error */
export const isTimeoutError = (e: AppError): boolean => e.category === ErrorCategory.Timeout;

/** Check if error is a server error (5xx) */
export const isServerError = (e: AppError): boolean => e.category === ErrorCategory.Server;

/** Check if error is a client error (4xx) */
export const isClientError = (e: AppError): boolean => e.category === ErrorCategory.Client;

/** Check if error is an auth error (401, 403) */
export const isAuthError = (e: AppError): boolean => e.category === ErrorCategory.Auth;

/** Check if error is a rate limit error (429) */
export const isRateLimitError = (e: AppError): boolean => e.category === ErrorCategory.RateLimit;

/** The homeserver's 403 body when the account's storage allow-list excludes the path (pubky-homeserver `http_error.rs`). */
const HOMESERVER_WRITE_PATH_NOT_ALLOWED = 'Write to this path is not allowed';

/**
 * The homeserver refused a write because this account may not store data at
 * that path, whatever the session's capabilities. Signing in again cannot
 * fix it: accounts created through Homegate's IP signup only allow
 * `/pub/paykit/` and `/pub/bitkit.to/`.
 */
export const isWritePathNotAllowedError = (e: AppError): boolean =>
  e.category === ErrorCategory.Auth &&
  e.code === AuthErrorCode.FORBIDDEN &&
  e.message.includes(HOMESERVER_WRITE_PATH_NOT_ALLOWED);

/** Check if error is a validation error (local) */
export const isValidationError = (e: AppError): boolean => e.category === ErrorCategory.Validation;

/** Check if error is a database error (local storage) */
export const isDatabaseError = (e: AppError): boolean => e.category === ErrorCategory.Database;

// =============================================================================
// Decision Helpers
// =============================================================================

/**
 * Should we retry this error?
 *
 * Retryable: network issues, timeouts, server errors (5xx), rate limits (with backoff)
 * Not retryable: client errors (4xx), auth errors, validation, database
 */
export const isRetryable = (error: AppError): boolean => {
  switch (error.category) {
    case ErrorCategory.Network:
    case ErrorCategory.Timeout:
    case ErrorCategory.Server:
    case ErrorCategory.RateLimit:
      return true;
    case ErrorCategory.Client:
    case ErrorCategory.Auth:
    case ErrorCategory.Validation:
    case ErrorCategory.Database:
      return false;
    default:
      return false;
  }
};

/**
 * Should we redirect to login?
 * Returns true for UNAUTHORIZED or SESSION_EXPIRED errors.
 */
export const requiresLogin = (error: AppError): boolean => {
  return (
    error.category === ErrorCategory.Auth &&
    (error.code === AuthErrorCode.UNAUTHORIZED || error.code === AuthErrorCode.SESSION_EXPIRED)
  );
};

/** True when sign-in/restore was rejected for a homeserver/environment mismatch on staging. */
export const isWrongEnvironmentHomeserverError = (error: unknown): error is AppError => {
  return isAppError(error) && error.code === AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER;
};

export const getWrongEnvironmentHomeserverMessage = (): string =>
  `This key is linked to a different homeserver. Use a ${getDeployEnv()} account on this site.`;

/**
 * True when the durable marketplace transport refused an operation because its
 * bearer session is missing, expired locally, or was rejected server-side
 * (401 — the transport drops the local copy before throwing). This is the one
 * marketplace error whose remedy is a fresh signer approval, so surfaces that
 * catch it must offer the session-connect affordance instead of a dead end.
 */
export const isMarketplaceSessionRequiredError = (error: unknown): error is AppError => {
  if (!isAppError(error) || error.service !== ErrorService.Marketplace) return false;
  return (
    error.code === AuthErrorCode.SESSION_EXPIRED ||
    error.code === AuthErrorCode.UNAUTHORIZED ||
    error.context?.statusCode === 401
  );
};

/**
 * True when the HOMESERVER refused a write because the browser's session
 * cookie lacks the needed capability scope ("Session does not have write
 * access to path"). The homeserver keeps one session cookie per user, so a
 * session approved under an older, narrower grant (e.g. a paykit-only
 * messaging approval from before the combined grant) silently replaces the
 * app session and breaks every pubky.app write. The ONLY remedy is a fresh
 * sign-in, so surfaces catching this must say exactly that instead of
 * showing the raw 403.
 */
export const isHomeserverWriteScopeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('Session does not have write access');
};

/** The one honest remedy line for {@link isHomeserverWriteScopeError} surfaces. */
export const HOMESERVER_WRITE_SCOPE_REMEDY =
  'Your session no longer has write access (an older approval replaced it). Sign out and sign back in with Pubky Ring to restore it.';

/**
 * Is this a "not found" error?
 * Checks both client NOT_FOUND and database RECORD_NOT_FOUND.
 */
export const isNotFound = (error: AppError): boolean => {
  return error.code === ClientErrorCode.NOT_FOUND || error.code === DatabaseErrorCode.RECORD_NOT_FOUND;
};

/**
 * Did this AppError originate from a specific HTTP status?
 *
 * Keep this separate from semantic helpers like isNotFound(): callers that only
 * mean "remote HTTP 404" should not accidentally swallow local/domain misses.
 */
export const hasHttpStatus = (error: unknown, statusCode: number): error is AppError => {
  return isAppError(error) && error.context?.statusCode === statusCode;
};

/**
 * Get retry delay from context (for rate limiting).
 * Returns the retry-after value in seconds if present.
 */
export const getRetryAfter = (error: AppError): number | undefined => {
  return error.context?.retryAfter as number | undefined;
};

// =============================================================================
// Error Normalization
// =============================================================================

/**
 * Ensures any error becomes an AppError.
 * Used at service boundaries to normalize unknown errors.
 *
 * NOTE: Does NOT use fragile string heuristics. Unknown errors become UNKNOWN_ERROR.
 *
 * @param error - The unknown error to normalize
 * @param service - Which service produced the error
 * @param operation - Which operation failed
 * @param traceId - Optional trace ID for correlation
 * @returns AppError (either the original if already AppError, or a new wrapped one)
 *
 * @example
 * ```typescript
 * try {
 *   await someOperation();
 * } catch (error) {
 *   throw toAppError(error, ErrorService.Local, 'someOperation');
 * }
 * ```
 */
export const toAppError = (error: unknown, service: ErrorService, operation: string, traceId?: string): AppError => {
  // Preserve existing AppError as-is; traceId should be set at origin
  if (isAppError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error occurred.';

  return Err.server(ServerErrorCode.UNKNOWN_ERROR, message, {
    service,
    operation,
    cause: error,
    traceId,
  });
};

/**
 * Extracts a user-friendly message from an error.
 * For AppError, returns the message. For other errors, returns a generic message.
 */
export const getErrorMessage = (error: unknown): string => {
  if (isAppError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error occurred.';
};
