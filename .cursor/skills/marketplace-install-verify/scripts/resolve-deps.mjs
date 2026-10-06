// Resolves optional dependencies (@synonymdev/pubky, pubky-app-specs, playwright) from the
// repository's node_modules, or from MIV_DEPS_FROM (any package.json whose node_modules has them).
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export function requireOptional(get, name) {
  const from = get('MIV_DEPS_FROM') ?? join(REPO_ROOT, 'package.json');
  try {
    return createRequire(from)(name);
  } catch (error) {
    throw new Error(`${name} not found from ${from}: run "npm ci" in the repository, or set MIV_DEPS_FROM (${error.code ?? error.message})`);
  }
}
