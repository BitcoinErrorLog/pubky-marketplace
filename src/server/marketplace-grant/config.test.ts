import { afterEach, describe, expect, it } from 'vitest';
import { getCliGrantConfig, getMarketplaceGrantConfig, resetMarketplaceGrantConfigForTests } from './config';

const ENV = { ...process.env };

function validEnv(): NodeJS.ProcessEnv {
  return {
    ...ENV,
    SHOP_BFF_GRANT_FLOW_ENABLED: 'true',
    SHOP_ALLOWED_ORIGINS: '["https://shop.example"]',
    SHOP_PUBLIC_ORIGIN: 'https://shop.example',
    MARKETPLACE_SERVICE_URL: 'https://service.example',
    SHOP_BFF_GRANT_STATE_DATABASE_URL: 'postgres://example',
    CRON_SECRET: 'c'.repeat(32),
    SHOP_GRANT_ASSERTION_ISSUER: 'https://shop.example',
    SHOP_GRANT_ASSERTION_KEY_ID: 'shop-bff-test-0001',
    SHOP_GRANT_ASSERTION_KEY_EPOCH: '1',
    SHOP_GRANT_ASSERTION_SIGNING_KEY: '11'.repeat(32),
    MARKETPLACE_SERVICE_REQUEST_KEY_ID: 'shop-bff-request-test-0001',
    MARKETPLACE_SERVICE_REQUEST_KEY_EPOCH: '1',
    MARKETPLACE_SERVICE_REQUEST_SIGNING_KEY: '22'.repeat(32),
    SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
    SHOP_BFF_GRANT_STATE_KEY_EPOCH: '1',
  };
}

describe('marketplace grant BFF config', () => {
  afterEach(() => {
    process.env = { ...ENV };
    resetMarketplaceGrantConfigForTests();
  });

  it('stays disabled without parsing secret inputs', () => {
    process.env = { ...ENV, SHOP_BFF_GRANT_FLOW_ENABLED: 'false' };
    expect(getMarketplaceGrantConfig()).toBeNull();
  });

  it('loads a complete environment with bounded defaults', () => {
    process.env = validEnv();
    expect(getMarketplaceGrantConfig()).toMatchObject({
      allowedOrigins: ['https://shop.example'],
      stateTtlSeconds: 300,
      claimLeaseSeconds: 25,
    });
  });

  it('rejects issuer/origin drift', () => {
    process.env = { ...validEnv(), SHOP_GRANT_ASSERTION_ISSUER: 'https://other.example' };
    expect(() => getMarketplaceGrantConfig()).toThrow();
  });

  it('rejects partial previous-key rotation', () => {
    process.env = {
      ...validEnv(),
      SHOP_BFF_GRANT_STATE_PREVIOUS_ENCRYPTION_KEY_B64: Buffer.alloc(32, 4).toString('base64'),
    };
    expect(() => getMarketplaceGrantConfig()).toThrow();
  });

  it('rejects a claim lease shorter than four service timeouts plus margin', () => {
    process.env = {
      ...validEnv(),
      SHOP_BFF_GRANT_CLAIM_LEASE_SECONDS: '15',
      SHOP_BFF_GRANT_SERVICE_TIMEOUT_MILLISECONDS: '5000',
    };
    expect(() => getMarketplaceGrantConfig()).toThrow(/Claim lease must be at least/);
  });

  it('loads when the claim lease equals four service timeouts plus margin', () => {
    process.env = {
      ...validEnv(),
      SHOP_BFF_GRANT_CLAIM_LEASE_SECONDS: '45',
      SHOP_BFF_GRANT_SERVICE_TIMEOUT_MILLISECONDS: '10000',
    };
    expect(getMarketplaceGrantConfig()).toMatchObject({
      claimLeaseSeconds: 45,
      serviceTimeoutMs: 10000,
    });
  });

  it('keeps CLI routes disabled unless both grant flags are true', () => {
    process.env = { ...validEnv(), SHOP_BFF_CLI_GRANT_ENABLED: 'true', SHOP_BFF_GRANT_FLOW_ENABLED: 'false' };
    expect(getCliGrantConfig()).toBeNull();
    process.env = { ...validEnv(), SHOP_BFF_CLI_GRANT_ENABLED: 'false' };
    resetMarketplaceGrantConfigForTests();
    expect(getCliGrantConfig()).toBeNull();
  });

  it('loads CLI extras only when the CLI flag is on', () => {
    process.env = { ...validEnv(), SHOP_BFF_CLI_GRANT_ENABLED: 'true' };
    expect(getCliGrantConfig()).toMatchObject({
      challengeTtlSeconds: 60,
      createPerIpPerMinute: 10,
      verifyPerIpPerMinute: 10,
      statusPerTokenPerMinute: 60,
      resultPerTokenPerMinute: 30,
      homeserverFetchTimeoutMs: 5000,
      trustedProxyCount: 0,
    });
  });

  it('refuses a CLI challenge TTL outside 30–120 when the CLI flag is on', () => {
    process.env = {
      ...validEnv(),
      SHOP_BFF_CLI_GRANT_ENABLED: 'true',
      SHOP_BFF_CLI_GRANT_CHALLENGE_TTL_SECONDS: '29',
    };
    expect(() => getCliGrantConfig()).toThrow();
  });
});
