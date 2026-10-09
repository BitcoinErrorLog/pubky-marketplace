import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setEmbedded } from '@/test-utils/embedded';
import { setSocialHost } from '@/test-utils/social-host';
import { ProfileOnPubkyLink } from './ProfileOnPubkyLink';

const PUBKY = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';

describe('ProfileOnPubkyLink', () => {
  afterEach(() => {
    setSocialHost(undefined);
    setEmbedded(false);
  });

  it('renders nothing while social link-out is off', () => {
    const { container } = render(<ProfileOnPubkyLink pubky={PUBKY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links to the profile on the social host in the same tab while on', () => {
    setSocialHost('https://pubky.app');
    render(<ProfileOnPubkyLink pubky={PUBKY} />);

    const link = screen.getByRole('link', { name: 'Profile on Pubky' });
    expect(link).toHaveAttribute('href', `https://pubky.app/profile/${PUBKY}`);
    expect(link).not.toHaveAttribute('target');
  });

  it('replaces the whole page, not just the frame, when the Shop is embedded', () => {
    setSocialHost('https://pubky.app');
    setEmbedded(true);
    render(<ProfileOnPubkyLink pubky={PUBKY} />);

    expect(screen.getByRole('link', { name: 'Profile on Pubky' })).toHaveAttribute('target', '_top');
  });
});
