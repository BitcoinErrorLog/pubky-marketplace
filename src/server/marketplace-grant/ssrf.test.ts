/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { assertSafeHomeserverUrl, HomeserverFetchDenied, proofPath } from './ssrf';

describe('CLI homeserver SSRF policy', () => {
  it('rejects http, userinfo, query, fragment, and IP literals before DNS', () => {
    const denied = [
      'http://homeserver.example/pub/x',
      'https://user:pass@homeserver.example/pub/x',
      'https://homeserver.example/pub/x?q=1',
      'https://homeserver.example/pub/x#frag',
      'https://127.0.0.1/pub/x',
      'https://169.254.169.254/pub/x',
      'https://[::1]/pub/x',
      'https://[fd00:ec2::254]/pub/x',
    ];
    for (const href of denied) {
      expect(() => assertSafeHomeserverUrl(new URL(href)), href).toThrow(HomeserverFetchDenied);
    }
  });

  it('accepts an https hostname origin used for the proof GET', () => {
    expect(() => assertSafeHomeserverUrl(new URL('https://homeserver.example/pub/x'))).not.toThrow();
  });

  it('rejects a non-UUID proof path so the GET URL cannot be steered', () => {
    expect(() => proofPath('../etc/passwd')).toThrow(HomeserverFetchDenied);
    expect(() => proofPath('not-a-uuid')).toThrow(HomeserverFetchDenied);
    expect(proofPath('018f4f36-7a61-7d4e-8f22-3e31ed45d2af')).toBe(
      '/pub/pubky.app/marketplace/v1/cli-grant-proofs/018f4f36-7a61-7d4e-8f22-3e31ed45d2af',
    );
  });
});
