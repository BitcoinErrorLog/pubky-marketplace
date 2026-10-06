import { connection } from 'next/server';

/**
 * Prerendered HTML inlines the runtime config read at build time. Only Vercel
 * guarantees that the build and the server share one env (strict parse at
 * build, redeploy on change). Every other build (the CI artifact that
 * launch-e2e starts with its own env, Docker images, local builds) renders each
 * route per request so RootContainer inlines the server's PUBKY_RUNTIME_* config.
 */
export async function renderPerRequestOutsideVercel(): Promise<void> {
  if (process.env.VERCEL !== '1') await connection();
}
