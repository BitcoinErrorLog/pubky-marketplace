// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import captured from '@/test/fixtures/auth/ring-signin-url.sdk-0.8.0.json';
import { HomeserverService } from './homeserver';

describe('Ring sign-in QR on @synonymdev/pubky 0.11 (real SDK)', () => {
  it('ring qr matches captured 0.8.0 host and params and requests the Ring cookie set', async () => {
    const { authorizationUrl, awaitApproval, cancelAuthFlow } = await HomeserverService.generateAuthUrl();
    // Cancelling below rejects the pending approval; this test only reads the URL.
    awaitApproval.catch(() => undefined);
    try {
      const url = new URL(authorizationUrl);

      expect(url.protocol).toBe(captured.scheme);
      expect(url.host).toBe(captured.host);
      expect([...url.searchParams.keys()]).toEqual(captured.params);
      expect(url.searchParams.get('caps')).toBe(RING_COOKIE_CAPABILITIES);
    } finally {
      cancelAuthFlow();
    }
  });

  it('connect-marketplace qr requests the marketplace session grant on the same ring url shape', () => {
    const { authorizationUrl, cancelAuthFlow } = HomeserverService.generateAuthTokenFlow(MARKETPLACE_SESSION_GRANT);
    try {
      const url = new URL(authorizationUrl);

      expect(url.protocol).toBe(captured.scheme);
      expect(url.host).toBe(captured.host);
      expect([...url.searchParams.keys()]).toEqual(captured.params);
      expect(url.searchParams.get('caps')).toBe(MARKETPLACE_SESSION_GRANT);
    } finally {
      cancelAuthFlow();
    }
  });
});
