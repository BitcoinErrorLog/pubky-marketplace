// node --test .cursor/skills/marketplace-install-verify/scripts/lib.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  compareMigrations,
  expectedMigration,
  extractRuntimeConfig,
  frameAncestorsAllow,
  isTruthy,
  missingOrigins,
  normalizeBase,
  parseBearerChallenge,
  parseEnvFile,
  parseImageRef,
  parseJsonLenient,
  parseList,
  parseMigrationRows,
  parseSourceRef,
  parseTomlFlat,
  redact,
} from './lib.mjs';

test('parseEnvFile reads quotes, comments and export prefixes', () => {
  const env = parseEnvFile(
    [
      '# comment',
      'A=plain   # trailing comment',
      'export B="quoted # not a comment"',
      "C='[\"https://a.example\"]'",
      'D=ssh vm docker inspect --format \'{{index .Config.Labels "x"}}\' svc',
      '',
    ].join('\n'),
  );
  assert.equal(env.A, 'plain');
  assert.equal(env.B, 'quoted # not a comment');
  assert.equal(env.C, '["https://a.example"]');
  assert.equal(env.D, 'ssh vm docker inspect --format \'{{index .Config.Labels "x"}}\' svc');
  assert.throws(() => parseEnvFile('A=1\nhunter2 secret'), (error) => {
    assert.equal(error.message, 'line 2 is not KEY=VALUE');
    return true;
  });
});

test('frame-ancestors matches exact origins only', () => {
  const csp = "default-src 'none'; frame-ancestors https://shop.example.evil.com https://Shop.example:443";
  assert.equal(frameAncestorsAllow(csp, 'https://shop.example'), true);
  assert.equal(frameAncestorsAllow('frame-ancestors https://shop.example.evil.com', 'https://shop.example'), false);
  assert.equal(frameAncestorsAllow('', 'https://shop.example'), false);
  assert.equal(isTruthy('Yes'), true);
  assert.equal(isTruthy('0'), false);
});

test('parseTomlFlat reads the Paykit and Locks keys the checks use', () => {
  const toml = parseTomlFlat(`
bind_addr = "127.0.0.1:3000"
[credentials]
lock_server_secret_key = "/data/secret.sess" # path, never read by the checks
lock_server_public_key = "pubkyabc"
[locks]
trusted_public_key = "pubkyabc"
[setup]
allowed_origins = [
  "https://shop.example", # production
  'https://staging.shop.example',
]
log_authorization_url = false
[creator_authority_acquisition.legacy_connect]
allowed_return_origins = ["https://shop.example"]
[content_locks]
max_resource_bytes = 10_000_000
`);
  assert.equal(toml.bind_addr, '127.0.0.1:3000');
  assert.equal(toml['locks.trusted_public_key'], 'pubkyabc');
  assert.deepEqual(toml['setup.allowed_origins'], ['https://shop.example', 'https://staging.shop.example']);
  assert.equal(toml['setup.log_authorization_url'], false);
  assert.deepEqual(toml['creator_authority_acquisition.legacy_connect.allowed_return_origins'], ['https://shop.example']);
  assert.equal(toml['content_locks.max_resource_bytes'], 10000000);
});

test('origin lists accept JSON, TOML and comma forms and compare by origin', () => {
  assert.deepEqual(parseList('["https://a.example","https://b.example"]'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseList("['https://a.example']"), ['https://a.example']);
  assert.deepEqual(parseList('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(missingOrigins('https://A.example/,https://b.example', ['https://a.example', 'https://c.example']), [
    'https://c.example',
  ]);
  assert.equal(normalizeBase('https://paykit.example/setup/'), 'https://paykit.example/setup');
  assert.equal(normalizeBase('http://paykit.internal:3001'), 'http://paykit.internal:3001');
});

test('migrations compare by version, success and SHA-384 of the file bytes', () => {
  const sql = Buffer.from('CREATE TABLE t (id int);\n');
  const checksum = createHash('sha384').update(sql).digest('hex');
  const expected = [
    expectedMigration('0001_init.sql', sql),
    expectedMigration('0002_more.up.sql', Buffer.from('x')),
    expectedMigration('0002_more.down.sql', Buffer.from('y')),
    expectedMigration('README.md', Buffer.from('z')),
  ].filter(Boolean);
  assert.equal(expected.length, 2);
  assert.equal(expected[0].checksum, checksum);
  const applied = parseMigrationRows(
    ['Using SSH key from file', `MIV|1|t|${checksum}`, `MIV|2|t|${expected[1].checksum}`, 'ROLLBACK'].join('\n'),
  );
  assert.deepEqual(compareMigrations(expected, applied).ok, true);
  const fork = parseMigrationRows(`MIV|1|t|${'0'.repeat(96)}\nMIV|2|f|${expected[1].checksum}\nMIV|3|t|aa`);
  const diff = compareMigrations(expected, fork);
  assert.deepEqual([diff.ok, diff.mismatched, diff.failed, diff.extra, diff.missing], [false, [1], [2], [3], []]);
  assert.deepEqual(compareMigrations(expected, []).missing, [1, 2]);
});

test('extractRuntimeConfig reads the frozen config object from page HTML', () => {
  const html =
    '<script>self.__PUBKY_CONFIG__=Object.freeze({"marketplaceUrl":"https://api.example","note":"brace } in \\"string\\"","n":{"a":1}});</script>';
  assert.deepEqual(extractRuntimeConfig(html), {
    marketplaceUrl: 'https://api.example',
    note: 'brace } in "string"',
    n: { a: 1 },
  });
  assert.equal(extractRuntimeConfig('<html></html>'), null);
});

test('parseJsonLenient accepts raw control characters inside strings only', () => {
  assert.deepEqual(parseJsonLenient('[{"description":"line one\nline\ttwo"}]'), [{ description: 'line one\nline\ttwo' }]);
  assert.deepEqual(parseJsonLenient('{\n  "a": 1\n}'), { a: 1 });
  assert.throws(() => parseJsonLenient('{"a":'));
});

test('source and image references parse', () => {
  assert.deepEqual(parseSourceRef('pubky/locks@b3dc87c9'), { owner: 'pubky', repo: 'locks', ref: 'b3dc87c9' });
  assert.equal(parseSourceRef('locks@main'), null);
  assert.deepEqual(parseImageRef('ghcr.io/pubky/marketplace-nexus@sha256:abc'), {
    registry: 'ghcr.io',
    repository: 'pubky/marketplace-nexus',
    reference: 'sha256:abc',
  });
  assert.deepEqual(parseImageRef('synonymsoft/paykit-server:v0.1.0-rc8'), {
    registry: 'registry-1.docker.io',
    repository: 'synonymsoft/paykit-server',
    reference: 'v0.1.0-rc8',
  });
  assert.deepEqual(parseImageRef('us-docker.pkg.dev/proj/repo/locks:1'), {
    registry: 'us-docker.pkg.dev',
    repository: 'proj/repo/locks',
    reference: '1',
  });
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="x"'), {
    realm: 'https://ghcr.io/token',
    service: 'ghcr.io',
    scope: 'x',
  });
});

test('redact removes connection strings, bearer tokens and secret parameters', () => {
  const text = redact('psql: postgres://u:p@db.internal:5432/x failed; Authorization: Bearer abc.def; url?secret=s3cr3t&x=1');
  assert.doesNotMatch(text, /u:p@|abc\.def|s3cr3t/);
  assert.match(text, /postgres:\/\/\[redacted\]/);
});
