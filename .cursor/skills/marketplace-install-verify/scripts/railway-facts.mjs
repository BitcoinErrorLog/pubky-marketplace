#!/usr/bin/env node
// Writes the non-secret wiring facts of a Railway-hosted stack as config lines for verify.mjs,
// so the old (Railway) stack can be verified, or compared with a new one, the same way.
//
//   node railway-facts.mjs service=<project>:<environment>:<service> paykit=… locks=… fiat=…
//
// Only allowlisted keys are read out of each service's variables: URLs, origins, public keys,
// the Bitcoin network and boolean switches. Secret values never leave this process.
import { execFileSync } from 'node:child_process';
import { parseTomlFlat } from './lib.mjs';

const ROLES = {
  service: (vars) => ({
    SERVICE_PAYKIT_SERVER_URL: vars.PAYKIT_SERVER_URL,
    SERVICE_LOCKS_SERVER_URL: vars.LOCKS_SERVER_URL,
    SERVICE_ALLOWED_ORIGINS: vars.ALLOWED_ORIGINS,
    SERVICE_SANDBOX_PAYMENTS_ENABLED: vars.SANDBOX_PAYMENTS_ENABLED ?? 'false',
  }),
  paykit: (vars) => {
    const toml = parseTomlFlat(vars.PAYKIT_CONFIG_TOML ?? '');
    return {
      PAYKIT_TRUSTED_LOCKS_KEY: toml['locks.trusted_public_key'],
      PAYKIT_SETUP_ALLOWED_ORIGINS: toml['setup.allowed_origins'] && JSON.stringify(toml['setup.allowed_origins']),
      PAYKIT_BITCOIN_NETWORK: toml['bitcoin.network'],
      PAYKIT_LOG_AUTHORIZATION_URL:
        toml['setup.log_authorization_url'] === undefined ? undefined : String(toml['setup.log_authorization_url']),
    };
  },
  locks: (vars) => ({
    LOCKS_PUBLIC_KEY: vars.LOCKS_PUBLIC_KEY,
    LOCKS_PAYKIT_SERVER_URL: vars.LOCKS_PAYKIT_SERVER_URL,
    LOCKS_ALLOWED_RETURN_ORIGINS: vars.LOCKS_ALLOWED_RETURN_ORIGINS,
  }),
  fiat: (vars) => ({
    FIAT_PAYKIT_SERVER_URL: vars.FIAT_PAYKIT_SERVER_URL,
    FIAT_TRUSTED_LOCKS_KEY: vars.FIAT_TRUSTED_LOCKS_PUBLIC_KEY,
    FIAT_BUYER_RETURN_ORIGINS: vars.BUYER_RETURN_ORIGINS,
  }),
};

const specs = process.argv.slice(2);
if (!specs.length || specs.some((spec) => !/^(service|paykit|locks|fiat)=[^:]+:[^:]+:[^:]+$/.test(spec))) {
  console.error('usage: railway-facts.mjs <role>=<project>:<environment>:<service> … (roles: service, paykit, locks, fiat)');
  process.exit(2);
}
const lines = [`# Railway wiring facts, ${new Date().toISOString()}. Non-secret values only.`];
for (const spec of specs) {
  const [role, target] = spec.split('=');
  const [project, environment, service] = target.split(':');
  const vars = JSON.parse(
    execFileSync('railway', ['variables', '--json', '-p', project, '-e', environment, '-s', service], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  for (const [key, value] of Object.entries(ROLES[role](vars))) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}=${String(value).includes('"') ? `'${value}'` : `"${value}"`}`);
  }
}
console.log(lines.join('\n'));
