export interface BuildInfo {
  name: string;
  version: string;
  commit: string;
  built_at: string;
}

/**
 * Literal `process.env.SHOP_BUILD_*` reads: Next inlines them from `next.config.ts` `env` at build time,
 * and only literal member accesses are replaced.
 */
export function readBuildInfo(): BuildInfo {
  return {
    name: process.env.SHOP_BUILD_NAME ?? 'unknown',
    version: process.env.SHOP_BUILD_VERSION ?? 'unknown',
    commit: process.env.SHOP_BUILD_COMMIT ?? 'unknown',
    built_at: process.env.SHOP_BUILD_BUILT_AT ?? 'unknown',
  };
}

export function buildInfoToEnv(info: BuildInfo): Record<string, string> {
  return {
    SHOP_BUILD_NAME: info.name,
    SHOP_BUILD_VERSION: info.version,
    SHOP_BUILD_COMMIT: info.commit,
    SHOP_BUILD_BUILT_AT: info.built_at,
  };
}
