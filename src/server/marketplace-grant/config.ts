import { z } from 'zod';

const exactOrigin = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value, 'Expected an exact origin');
const positiveSmallInt = z.coerce.number().int().min(1).max(32767);
const canonicalBase64Key = z.string().refine((value) => {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 32 && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}, 'Expected canonical padded Base64 for 32 bytes');
const signingSeed = z.string().regex(/^[0-9a-f]{64}$/);
const keyId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const CLAIM_LEASE_MARGIN_SECONDS = 5;
export const CLAIM_SERVICE_CALLS = 4;

const configSchema = z
  .object({
    allowedOrigins: z.string().transform((value, ctx) => {
      try {
        return z.array(exactOrigin).min(1).parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'SHOP_ALLOWED_ORIGINS must be a JSON array of exact origins' });
        return z.NEVER;
      }
    }),
    publicOrigin: exactOrigin,
    serviceUrl: exactOrigin,
    databaseUrl: z.string().min(1),
    cronSecret: z.string().min(32),
    assertionIssuer: exactOrigin,
    assertionKeyId: keyId,
    assertionKeyEpoch: positiveSmallInt,
    assertionSigningKey: signingSeed,
    requestKeyId: keyId,
    requestKeyEpoch: positiveSmallInt,
    requestSigningKey: signingSeed,
    stateKey: canonicalBase64Key,
    stateKeyEpoch: positiveSmallInt,
    previousStateKey: canonicalBase64Key.optional(),
    previousStateKeyEpoch: positiveSmallInt.optional(),
    stateTtlSeconds: z.coerce.number().int().min(60).max(600).default(300),
    claimLeaseSeconds: z.coerce.number().int().min(10).max(90).default(25),
    databaseTimeoutMs: z.coerce.number().int().min(1000).max(5000).default(2000),
    serviceTimeoutMs: z.coerce.number().int().min(2000).max(10000).default(5000),
  })
  .superRefine((value, ctx) => {
    if (value.assertionIssuer !== value.publicOrigin) {
      ctx.addIssue({ code: 'custom', path: ['assertionIssuer'], message: 'Issuer must equal SHOP_PUBLIC_ORIGIN' });
    }
    const hasPreviousKey = value.previousStateKey !== undefined;
    const hasPreviousEpoch = value.previousStateKeyEpoch !== undefined;
    if (hasPreviousKey !== hasPreviousEpoch) {
      ctx.addIssue({ code: 'custom', message: 'Previous BFF state key and epoch must be supplied together' });
    }
    if (value.previousStateKeyEpoch !== undefined && value.previousStateKeyEpoch !== value.stateKeyEpoch - 1) {
      ctx.addIssue({ code: 'custom', message: 'Previous BFF state epoch must be active minus one' });
    }
    const minimumLeaseSeconds =
      Math.ceil((CLAIM_SERVICE_CALLS * value.serviceTimeoutMs) / 1000) + CLAIM_LEASE_MARGIN_SECONDS;
    if (value.claimLeaseSeconds < minimumLeaseSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['claimLeaseSeconds'],
        message: `Claim lease must be at least ${CLAIM_SERVICE_CALLS}× service timeout plus ${CLAIM_LEASE_MARGIN_SECONDS}s (${minimumLeaseSeconds}s)`,
      });
    }
  });

export type MarketplaceGrantConfig = z.infer<typeof configSchema>;

const cliExtrasSchema = z.object({
  challengeTtlSeconds: z.coerce.number().int().min(30).max(120).default(60),
  createPerIpPerMinute: z.coerce.number().int().min(1).default(10),
  verifyPerIpPerMinute: z.coerce.number().int().min(1).default(10),
  statusPerTokenPerMinute: z.coerce.number().int().min(1).default(60),
  resultPerTokenPerMinute: z.coerce.number().int().min(1).default(30),
  homeserverFetchTimeoutMs: z.coerce.number().int().min(2000).max(10000).default(5000),
  trustedProxyCount: z.coerce.number().int().min(0).max(8).default(0),
});

export type CliGrantConfig = MarketplaceGrantConfig & z.infer<typeof cliExtrasSchema>;

let cached: MarketplaceGrantConfig | null | undefined;
let cachedCli: CliGrantConfig | null | undefined;
let cachedBrowser: CliGrantConfig | null | undefined;

function cliExtrasFromEnv(): z.infer<typeof cliExtrasSchema> {
  return cliExtrasSchema.parse({
    challengeTtlSeconds: process.env.SHOP_BFF_CLI_GRANT_CHALLENGE_TTL_SECONDS,
    createPerIpPerMinute: process.env.SHOP_BFF_CLI_GRANT_CREATE_PER_IP_PER_MINUTE,
    verifyPerIpPerMinute: process.env.SHOP_BFF_CLI_GRANT_VERIFY_PER_IP_PER_MINUTE,
    statusPerTokenPerMinute: process.env.SHOP_BFF_CLI_GRANT_STATUS_PER_TOKEN_PER_MINUTE,
    resultPerTokenPerMinute: process.env.SHOP_BFF_CLI_GRANT_RESULT_PER_TOKEN_PER_MINUTE,
    homeserverFetchTimeoutMs: process.env.SHOP_BFF_CLI_HOMESERVER_FETCH_TIMEOUT_MILLISECONDS,
    trustedProxyCount: process.env.SHOP_BFF_CLI_TRUSTED_PROXY_COUNT,
  });
}

export function marketplaceGrantEnabled(): boolean {
  return process.env.SHOP_BFF_GRANT_FLOW_ENABLED === 'true';
}

export function marketplaceCliGrantEnabled(): boolean {
  return marketplaceGrantEnabled() && process.env.SHOP_BFF_CLI_GRANT_ENABLED === 'true';
}

export function getMarketplaceGrantConfig(): MarketplaceGrantConfig | null {
  if (cached !== undefined) return cached;
  if (!marketplaceGrantEnabled()) {
    cached = null;
    return null;
  }
  cached = configSchema.parse({
    allowedOrigins: process.env.SHOP_ALLOWED_ORIGINS,
    publicOrigin: process.env.SHOP_PUBLIC_ORIGIN,
    serviceUrl: process.env.MARKETPLACE_SERVICE_URL,
    databaseUrl: process.env.SHOP_BFF_GRANT_STATE_DATABASE_URL,
    cronSecret: process.env.CRON_SECRET,
    assertionIssuer: process.env.SHOP_GRANT_ASSERTION_ISSUER,
    assertionKeyId: process.env.SHOP_GRANT_ASSERTION_KEY_ID,
    assertionKeyEpoch: process.env.SHOP_GRANT_ASSERTION_KEY_EPOCH,
    assertionSigningKey: process.env.SHOP_GRANT_ASSERTION_SIGNING_KEY,
    requestKeyId: process.env.MARKETPLACE_SERVICE_REQUEST_KEY_ID,
    requestKeyEpoch: process.env.MARKETPLACE_SERVICE_REQUEST_KEY_EPOCH,
    requestSigningKey: process.env.MARKETPLACE_SERVICE_REQUEST_SIGNING_KEY,
    stateKey: process.env.SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64,
    stateKeyEpoch: process.env.SHOP_BFF_GRANT_STATE_KEY_EPOCH,
    previousStateKey: process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_ENCRYPTION_KEY_B64,
    previousStateKeyEpoch: process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_KEY_EPOCH,
    stateTtlSeconds: process.env.SHOP_BFF_GRANT_STATE_TTL_SECONDS,
    claimLeaseSeconds: process.env.SHOP_BFF_GRANT_CLAIM_LEASE_SECONDS,
    databaseTimeoutMs: process.env.SHOP_BFF_GRANT_DB_TIMEOUT_MILLISECONDS,
    serviceTimeoutMs: process.env.SHOP_BFF_GRANT_SERVICE_TIMEOUT_MILLISECONDS,
  });
  return cached;
}

export function getCliGrantConfig(): CliGrantConfig | null {
  if (cachedCli !== undefined) return cachedCli;
  if (!marketplaceCliGrantEnabled()) {
    cachedCli = null;
    return null;
  }
  const base = getMarketplaceGrantConfig();
  if (!base) {
    cachedCli = null;
    return null;
  }
  cachedCli = { ...base, ...cliExtrasFromEnv() };
  return cachedCli;
}

/**
 * Browser purchase bootstrap (Bitkit sign-in): the CLI verifier's parameters,
 * gated only by `SHOP_BFF_GRANT_FLOW_ENABLED`, never by the CLI flag.
 */
export function getBrowserBootstrapConfig(): CliGrantConfig | null {
  if (cachedBrowser !== undefined) return cachedBrowser;
  const base = getMarketplaceGrantConfig();
  cachedBrowser = base ? { ...base, ...cliExtrasFromEnv() } : null;
  return cachedBrowser;
}

export function resetMarketplaceGrantConfigForTests(): void {
  cached = undefined;
  cachedCli = undefined;
  cachedBrowser = undefined;
}
