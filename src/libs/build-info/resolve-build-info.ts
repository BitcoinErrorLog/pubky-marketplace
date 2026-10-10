import { execFileSync } from 'node:child_process';
import type { BuildInfo } from './build-info';

/** Build-time only (`next.config.ts`): shells out to git, so keep it out of anything the app bundles. */
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
 * - commit: Vercel's `VERCEL_GIT_COMMIT_SHA`, then the `GIT_SHA` build arg (Docker), then `git rev-parse HEAD`,
 *   suffixed `-dirty` when the worktree has uncommitted changes (the artifact is then not reproducible from that commit).
 * - version: `SHOP_VERSION` (the release tag, passed by the deploy), then the nearest `shop-v*` tag from git,
 *   then the package version. A Vercel build has no `.git`, so a deploy that is not given `SHOP_VERSION`
 *   reports the package version. The Docker builder image has no git, so it needs `GIT_SHA` and `SHOP_VERSION`.
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
  const gitCommit = () => {
    const head = git(['rev-parse', 'HEAD']);
    return head && git(['status', '--porcelain']) ? `${head}-dirty` : head;
  };
  return {
    name: packageName,
    version: fromEnv('SHOP_VERSION') ?? git(['describe', '--tags', '--match', SHOP_TAG_PATTERN]) ?? packageVersion,
    commit: fromEnv('VERCEL_GIT_COMMIT_SHA') ?? fromEnv('GIT_SHA') ?? gitCommit() ?? 'unknown',
    built_at: now.toISOString(),
  };
}
