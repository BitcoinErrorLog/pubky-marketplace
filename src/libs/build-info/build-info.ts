import { execFileSync } from 'node:child_process';

export interface BuildInfo {
  name: string;
  version: string;
  commit: string;
  built_at: string;
}

type BuildEnv = Record<string, string | undefined>;

/** Runs a git command in the repository; undefined when git or the checkout is missing. */
type GitRunner = (args: string[]) => string | undefined;

const SHOP_TAG_PATTERN = 'shop-v*';

const runGit: GitRunner = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Resolves what this build is, at build time (called from `next.config.ts`).
 *
 * - commit: Vercel's `VERCEL_GIT_COMMIT_SHA`, then the `GIT_SHA` build arg (Docker), then `git rev-parse HEAD`.
 * - version: `SHOP_VERSION` (the release tag, passed by the deploy), then the nearest `shop-v*` tag from git,
 *   then the package version. A Vercel build has no `.git`, so a deploy that is not given `SHOP_VERSION`
 *   reports the package version.
 */
export function resolveBuildInfo({
  env,
  packageName,
  packageVersion,
  git = runGit,
  now = new Date(),
}: {
  env: BuildEnv;
  packageName: string;
  packageVersion: string;
  git?: GitRunner;
  now?: Date;
}): BuildInfo {
  const fromEnv = (key: string) => env[key]?.trim() || undefined;
  return {
    name: packageName,
    version: fromEnv('SHOP_VERSION') ?? git(['describe', '--tags', '--match', SHOP_TAG_PATTERN]) ?? packageVersion,
    commit: fromEnv('VERCEL_GIT_COMMIT_SHA') ?? fromEnv('GIT_SHA') ?? git(['rev-parse', 'HEAD']) ?? 'unknown',
    built_at: now.toISOString(),
  };
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
