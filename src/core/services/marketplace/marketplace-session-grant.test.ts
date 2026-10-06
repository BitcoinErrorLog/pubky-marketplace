import { describe, expect, it } from 'vitest';
import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import captured from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import ringCookie from '@/test/fixtures/auth/ring-cookie-signin.pubky-common-0.11.json';
import ringCapture from '@/test/fixtures/auth/ring-signin-url.sdk-0.8.0.json';
import {
  capabilitiesCoverScope,
  isMarketplaceSessionGrant,
  isMarketplaceSessionGrantUrl,
  MARKETPLACE_CLAIMABLE_GRANTS,
  MARKETPLACE_DISCLOSURE_INVENTORY,
  MARKETPLACE_DISCLOSURE_PRIVATE_DATA,
  MARKETPLACE_DISCLOSURE_RING_SIGN_IN,
  MARKETPLACE_DISCLOSURE_SIGN_IN,
  MARKETPLACE_PREVIOUS_SESSION_GRANT,
  MARKETPLACE_PRIVATE_DATA_SCOPE,
  MARKETPLACE_SESSION_GRANT,
  marketplaceApprovalDisclosure,
  sessionReplacementRejection,
} from './marketplace-session-grant';

type CapturedRequest = { scheme: string; host: string; params: string[]; caps: string; cid: string };

function urlFor(request: CapturedRequest, overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    caps: request.caps,
    relay: 'https://relay.example/inbox',
    secret: 's',
    cid: request.cid,
    cpk: 'k',
    ...overrides,
  };
  return `${request.scheme}//${request.host}?${request.params
    .map((name) => `${name}=${encodeURIComponent(values[name])}`)
    .join('&')}`;
}

describe('marketplace session grant', () => {
  it('is the grant Bitkit showed and the staging homeserver verified', () => {
    expect(captured.parity_request.caps).toBe(MARKETPLACE_SESSION_GRANT);
    expect(captured.parity_request.bitkit_shown).toBe(MARKETPLACE_SESSION_GRANT);
    expect(captured.parity_request.homeserver_verified).toBe(MARKETPLACE_SESSION_GRANT);
    expect(captured.previous_request.caps).toBe(MARKETPLACE_PREVIOUS_SESSION_GRANT);
  });

  it('accepts the captured parity and previous service requests', () => {
    expect(isMarketplaceSessionGrantUrl(urlFor(captured.parity_request))).toBe(true);
    expect(isMarketplaceSessionGrantUrl(urlFor(captured.previous_request))).toBe(true);
  });

  it('refuses any other capability request', () => {
    for (const caps of [
      captured.shop_signin_request.caps,
      `${MARKETPLACE_SESSION_GRANT},/pub/paykit/:rw`,
      '/:rw',
      '/priv/:rw,/pub/pubky.app/marketplace-service/v1/:rw',
      '/priv/pubky.app/:rw',
      '',
    ]) {
      expect(isMarketplaceSessionGrantUrl(urlFor(captured.parity_request, { caps })), caps).toBe(false);
    }
    const duplicated = `${urlFor(captured.parity_request)}&caps=${encodeURIComponent('/:rw')}`;
    expect(isMarketplaceSessionGrantUrl(duplicated)).toBe(false);
    expect(isMarketplaceSessionGrantUrl('not a url')).toBe(false);
  });

  it('discloses each captured grant in one plain sentence', () => {
    expect(marketplaceApprovalDisclosure(urlFor(captured.parity_request))).toBe(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
    expect(marketplaceApprovalDisclosure(urlFor(captured.previous_request))).toBe(MARKETPLACE_DISCLOSURE_INVENTORY);
    expect(marketplaceApprovalDisclosure(urlFor(captured.shop_signin_request))).toBe(MARKETPLACE_DISCLOSURE_SIGN_IN);
  });

  it('discloses the Ring connect QR and the Ring sign-in QR from their captured shapes', () => {
    const ringUrl = (caps: string) =>
      `${ringCapture.scheme}//${ringCapture.host}?${ringCapture.params
        .map((name) => `${name}=${encodeURIComponent(name === 'caps' ? caps : 'x')}`)
        .join('&')}`;
    expect(marketplaceApprovalDisclosure(ringUrl(MARKETPLACE_SESSION_GRANT))).toBe(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
    expect(marketplaceApprovalDisclosure(ringUrl(ringCapture.caps))).toBe(MARKETPLACE_DISCLOSURE_SIGN_IN);
    expect(marketplaceApprovalDisclosure(ringUrl(RING_COOKIE_CAPABILITIES))).toBe(MARKETPLACE_DISCLOSURE_RING_SIGN_IN);
    expect(marketplaceApprovalDisclosure(ringUrl(RING_COOKIE_CAPABILITIES.split(',').reverse().join(',')))).toBe(
      MARKETPLACE_DISCLOSURE_RING_SIGN_IN,
    );
    expect(marketplaceApprovalDisclosure(ringUrl(ringCookie.pubky_app_signin))).toBeNull();
  });

  it("says a Ring cookie approval also keeps Pubky App's social and Locks access working", () => {
    expect(MARKETPLACE_DISCLOSURE_RING_SIGN_IN).toMatch(/^Approving signs you in to Pubky Shop, /);
    expect(MARKETPLACE_DISCLOSURE_RING_SIGN_IN).toContain(
      'the marketplace the same access, including your private Shop data',
    );
    expect(MARKETPLACE_DISCLOSURE_RING_SIGN_IN).toMatch(/keeps Pubky App's social and Locks access working\.$/);
    expect(MARKETPLACE_DISCLOSURE_SIGN_IN).not.toMatch(/Pubky App/);
  });

  it('never names a capability path, a client host, or a signer', () => {
    for (const sentence of [
      MARKETPLACE_DISCLOSURE_PRIVATE_DATA,
      MARKETPLACE_DISCLOSURE_INVENTORY,
      MARKETPLACE_DISCLOSURE_SIGN_IN,
      MARKETPLACE_DISCLOSURE_RING_SIGN_IN,
    ]) {
      expect(sentence).not.toMatch(/\/|:rw|pubky\.app|marketplace-service|Bitkit|Ring/);
      expect(sentence.match(/\./g)).toHaveLength(1);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('shows nothing for any other request', () => {
    for (const caps of ['x', '', '/:rw', `${MARKETPLACE_SESSION_GRANT},/pub/paykit/:rw`, '/priv/pubky.app/:rw']) {
      expect(marketplaceApprovalDisclosure(urlFor(captured.parity_request, { caps })), caps).toBeNull();
    }
    expect(marketplaceApprovalDisclosure('not a url')).toBeNull();
  });
});

describe('capabilitiesCoverScope', () => {
  it.each([
    [MARKETPLACE_SESSION_GRANT, true],
    ['/priv/:rw', true],
    ['/:rw', true],
    ['/priv/pubky.app/:wr', true],
    ['/priv/pubky.app/:r', false],
    ['/priv/pubky.app/:rwx', false],
    ['/priv/pubky.app/marketplace/:rw', false],
    ['/priv/pubky.app:rw', false],
    ['/priv/other.app/:rw', false],
    ['', false],
  ])('%s covers /priv/pubky.app/ = %s', (capabilities, covers) => {
    expect(capabilitiesCoverScope(capabilities, MARKETPLACE_PRIVATE_DATA_SCOPE)).toBe(covers);
  });
});

describe('sessionReplacementRejection', () => {
  const PUBKY = 'y'.repeat(52);
  const parity = captured.parity_request.homeserver_verified;
  const previous = captured.previous_request.homeserver_verified;
  const signIn = captured.shop_signin_request.caps;
  const claimedGrantRejection = (
    capabilities: string,
    current: { pubky: string; capabilities: string } | null,
    pubky: string,
  ) => sessionReplacementRejection(capabilities, MARKETPLACE_CLAIMABLE_GRANTS, current, pubky);

  it('pins the Ring connect QR to the parity grant and the sign-in redeem to the Shop sign-in grant', () => {
    expect(signIn.split(',').sort()).toEqual(CAPABILITIES.split(',').sort());
    expect(sessionReplacementRejection(parity, [MARKETPLACE_SESSION_GRANT], null, PUBKY)).toBeNull();
    expect(sessionReplacementRejection(previous, [MARKETPLACE_SESSION_GRANT], null, PUBKY)).toBe(
      'unexpected_capabilities',
    );
    expect(sessionReplacementRejection('', [MARKETPLACE_SESSION_GRANT], null, PUBKY)).toBe('unexpected_capabilities');
    expect(
      sessionReplacementRejection(signIn, [CAPABILITIES], { pubky: PUBKY, capabilities: parity }, PUBKY),
    ).toBeNull();
    expect(sessionReplacementRejection(parity, [CAPABILITIES], null, PUBKY)).toBe('unexpected_capabilities');
  });

  it('lets the Ring cookie sign-in redeem replace a parity session, and refuses a pubky.app-only set', () => {
    const ringRedeem = ringCookie.service_normalized;
    expect(
      sessionReplacementRejection(
        ringRedeem,
        [RING_COOKIE_CAPABILITIES],
        { pubky: PUBKY, capabilities: parity },
        PUBKY,
      ),
    ).toBeNull();
    expect(sessionReplacementRejection(signIn, [RING_COOKIE_CAPABILITIES], null, PUBKY)).toBe(
      'unexpected_capabilities',
    );
    expect(sessionReplacementRejection(ringCookie.pubky_app_signin, [RING_COOKIE_CAPABILITIES], null, PUBKY)).toBe(
      'unexpected_capabilities',
    );
  });

  it('applies the no-downgrade rule even when no grant is pinned', () => {
    expect(sessionReplacementRejection('', null, { pubky: PUBKY, capabilities: parity }, PUBKY)).toBe(
      'narrower_than_current',
    );
    expect(sessionReplacementRejection('', null, { pubky: PUBKY, capabilities: '' }, PUBKY)).toBeNull();
    expect(sessionReplacementRejection('garbage', null, null, PUBKY)).toBeNull();
  });

  it('accepts either marketplace session grant in any order with no current session', () => {
    expect(claimedGrantRejection(parity, null, PUBKY)).toBeNull();
    expect(claimedGrantRejection(parity.split(',').reverse().join(','), null, PUBKY)).toBeNull();
    expect(claimedGrantRejection(previous, null, PUBKY)).toBeNull();
    expect(isMarketplaceSessionGrant(` ${previous} `)).toBe(true);
  });

  it.each(['', ',', `${previous},${previous}`, `${parity},`, '/pub/pubky.app/:rw', '/:rw', 'garbage'])(
    'refuses %j as unexpected',
    (capabilities) => {
      expect(claimedGrantRejection(capabilities, null, PUBKY)).toBe('unexpected_capabilities');
    },
  );

  it('refuses a claim that drops a scope the current session covers', () => {
    expect(claimedGrantRejection(previous, { pubky: PUBKY, capabilities: parity }, PUBKY)).toBe(
      'narrower_than_current',
    );
    expect(
      claimedGrantRejection(previous, { pubky: PUBKY, capabilities: captured.shop_signin_request.caps }, PUBKY),
    ).toBe('narrower_than_current');
    expect(claimedGrantRejection(parity, { pubky: PUBKY, capabilities: previous }, PUBKY)).toBeNull();
    expect(claimedGrantRejection(previous, { pubky: PUBKY, capabilities: '' }, PUBKY)).toBeNull();
  });

  it('ignores a current session that belongs to another pubky', () => {
    expect(claimedGrantRejection(previous, { pubky: 'z'.repeat(52), capabilities: parity }, PUBKY)).toBeNull();
  });
});
