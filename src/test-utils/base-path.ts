import { Env } from '@/libs/env/env';

/**
 * Sets the baked `NEXT_PUBLIC_BASE_PATH` for the current test. `@/config/base-path` reads it
 * per call, so code run afterwards sees the new mount path. Call `setBasePath('')` in
 * `afterEach` to restore the default (served from the origin root).
 */
export function setBasePath(basePath: string): void {
  Env.NEXT_PUBLIC_BASE_PATH = basePath;
}
