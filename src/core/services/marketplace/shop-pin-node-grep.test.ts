// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');

describe('Shop pin node: grep', () => {
  it('fails when the browser entry or the client bundle quotes a node: builtin', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const out = execFileSync(process.execPath, ['scripts/shop-pin-node-grep.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('self_test=pass');
    expect(out).toContain(`pin=${pkg.dependencies['@bitcoinerrorlog/pubky-shop']}`);
    expect(out).toContain('browser_node_specifiers=0');
    expect(out).toContain('browser_external_specifiers=0');
    expect(out).toContain('browser_missing=0');
    expect(out).toContain('shop_node_export_imports=0');
    if (out.includes('static_dir=missing')) return;
    expect(out).toMatch(/static_quoted_node_specifiers=0(?:\n|$)/);
  });
});
