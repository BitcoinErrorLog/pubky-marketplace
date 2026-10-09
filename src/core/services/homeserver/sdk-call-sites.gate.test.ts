// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry) || /\.(test|vrt\.test)\.(ts|tsx)$/.test(entry)) return [];
    return [path];
  });
}

describe('@synonymdev/pubky call sites', () => {
  const files = sourceFiles(SRC).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

  it('no Pubky.restoreSession call site in src', () => {
    const offenders = files
      .filter(({ text }) => /\b(pubkySdk|getPubkySdk\(\))\.restoreSession\(/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('no removed 0.8 cookie API names on the pubky SDK', () => {
    const offenders = files
      .filter(({ text }) => /\b(pubkySdk|getPubkySdk\(\))\.startAuthFlow\(|\bsigner\.(signin|signup)\(/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('one @synonymdev/pubky in the lockfile, and the pubky-shop package follows the root dependency', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/@synonymdev/pubky'));
    expect(copies.map(([path]) => path)).toEqual(['node_modules/@synonymdev/pubky']);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      overrides: Record<string, Record<string, string>>;
    };
    // The SDK is pinned in exactly one place: the root dependency. The override
    // makes @bitcoinerrorlog/pubky-shop resolve the same copy, so moving the
    // pin (a vendored tarball today, the npm release after) is one edit.
    expect(pkg.dependencies['@synonymdev/pubky']).toBeTruthy();
    expect(pkg.overrides['@bitcoinerrorlog/pubky-shop']['@synonymdev/pubky']).toBe('$@synonymdev/pubky');
  });

  it('the pinned SDK carries scoped encryption keys (the e action and EncryptionKeys)', () => {
    const declarations = readFileSync(join(ROOT, 'node_modules/@synonymdev/pubky/pubky.d.ts'), 'utf8');
    expect(declarations).toContain('export class EncryptionKeys');
    expect(declarations).toContain('approvalFormat?: GrantApprovalFormat');
    expect(declarations).toMatch(/export type CapabilityAction = [^;]*"rwe"/);
  });

  it('routes every direct session-storage write through HomeserverService retry policy', () => {
    const offenders = files
      .filter(({ path, text }) => {
        if (path === 'src/core/services/homeserver/homeserver.ts') return false;
        return /\.storage\.(?:putJson|putBytes|delete)\(/.test(text);
      })
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
