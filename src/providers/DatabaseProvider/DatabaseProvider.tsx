'use client';

import { createContext, type ReactNode, useEffect, useRef, useState } from 'react';
import { db } from '@/database/franky/franky';
import { resumePendingMessagingTeardown } from '@/database/franky/franky.helpers';
import { migrateLegacyDatabases } from '@/database/franky/franky.namespace-migration';
import { AppError } from '@/libs/error/error';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { DatabaseErrorScreen } from '@/molecules/DatabaseErrorScreen/DatabaseErrorScreen';
import { type DatabaseContextType } from '@/providers/DatabaseProvider/DatabaseProvider.types';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { useMigrationStore } from '@/stores/migration/migration.store';

export const DatabaseContext = createContext<DatabaseContextType>({
  isReady: false,
  error: null,
  retry: async () => {},
});

/**
 * DatabaseProvider initializes the Dexie database. Page children stay mounted
 * during init so public routes can SSR (marketplace catalog HTML). Callers that
 * read Dexie treat an unresolved cache as loading. The recovery screen still
 * replaces children when initialization fails.
 */
export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Guards against the 'close' event (manually deleteding indexedDB fires this event) that fires during recreateDatabase() → this.close().
  // Without this, the close handler would re-trigger initDatabase and cause an infinite loop.
  const isInitializingRef = useRef(false);

  const initDatabase = async () => {
    isInitializingRef.current = true;
    try {
      setError(null);
      // Existing Shop data moves into the Shop namespace before the namespaced database opens.
      await migrateLegacyDatabases();
      const { wasDbReset, messagingAtRestDegraded } = await db.initialize();
      if (wasDbReset) {
        useMigrationStore.getState().setWasDbReset(true);
      }
      // A failed best-effort wrap sweep must not pass silently: mirror the
      // degraded fact so the messaging enable UI can pause instead of
      // enabling on top of unprotected at-rest key material.
      useMessagingStore.getState().setMessagingAtRestDegraded(messagingAtRestDegraded);
      // A sign-out whose tab closed before other tabs let it clear the
      // messaging keys is finished here; messaging refuses to run until then.
      void resumePendingMessagingTeardown().catch((resumeError: unknown) => {
        Logger.warn('Could not finish clearing messaging keys from an earlier sign-out', { error: resumeError });
      });
      setIsReady(true);
    } catch (err) {
      setIsReady(false);
      if (err instanceof AppError) {
        setError(err);
      } else {
        // If it's not our AppError, it's likely a critical error from Dexie or browser
        setError(
          Err.database(DatabaseErrorCode.INIT_FAILED, 'Unexpected error during database initialization', {
            service: ErrorService.Local,
            operation: 'initDatabase',
            cause: err,
          }),
        );
      }
    } finally {
      isInitializingRef.current = false;
    }
  };

  useEffect(() => {
    initDatabase();

    // Re-initialize when the DB is unexpectedly closed (e.g. user deletes IndexedDB via devtools).
    // Skips expected closes during recreateDatabase() via the isInitializingRef guard.
    const handleUnexpectedClose = () => {
      if (isInitializingRef.current) return;
      setIsReady(false);
      initDatabase();
    };

    db.on('close', handleUnexpectedClose);

    return () => {
      db.on('close').unsubscribe(handleUnexpectedClose);
    };
  }, []);

  // Gate what renders on the database state:
  // - error: block the (broken) app and show a recovery screen wired to retry()
  // - otherwise always emit `children` so public HTML (marketplace catalog SSR)
  //   is not replaced by the IndexedDB spinner. Hooks that read Dexie treat an
  //   unresolved cache as loading and keep server-provided listings mounted.
  let content: ReactNode;
  if (error) {
    content = <DatabaseErrorScreen onRetry={initDatabase} />;
  } else {
    content = children;
  }

  return (
    <DatabaseContext.Provider
      value={{
        isReady,
        error,
        retry: initDatabase,
      }}
    >
      {content}
    </DatabaseContext.Provider>
  );
}
