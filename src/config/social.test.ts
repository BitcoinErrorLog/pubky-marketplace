import { afterEach, describe, expect, it } from 'vitest';
import { setSocialHost } from '@/test-utils/social-host';
import { getSocialHost, getSocialHostUrl, isSocialLinkOutEnabled } from './social';

describe('social link-out config', () => {
  afterEach(() => {
    setSocialHost(undefined);
  });

  it('is off by default', () => {
    expect(getSocialHost()).toBeUndefined();
    expect(isSocialLinkOutEnabled()).toBe(false);
    expect(getSocialHostUrl('/profile/abc')).toBeNull();
  });

  it('builds same-path social-host URLs when on', () => {
    setSocialHost('https://staging.pubky.app');
    expect(isSocialLinkOutEnabled()).toBe(true);
    expect(getSocialHostUrl('/')).toBe('https://staging.pubky.app/');
    expect(getSocialHostUrl('/profile/abc')).toBe('https://staging.pubky.app/profile/abc');
  });
});
