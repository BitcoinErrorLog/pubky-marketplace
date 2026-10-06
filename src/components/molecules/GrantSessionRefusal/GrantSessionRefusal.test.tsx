import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GrantSessionRefusal, grantSessionRefusalCopy } from './GrantSessionRefusal';

const view = vi.hoisted(() => ({ signer: null as 'bitkit' | 'passport' | null }));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => view.signer,
}));

describe('grantSessionRefusalCopy', () => {
  it('names the signer that approved the sign-in', () => {
    expect(grantSessionRefusalCopy('default', 'bitkit')).toBe(
      'Bitkit sign-in does not cover this step yet. Sign in with Pubky Ring to continue.',
    );
    expect(grantSessionRefusalCopy('default', 'passport')).toBe(
      'Pubky Passport sign-in does not cover this step yet. Sign in with Pubky Ring to continue.',
    );
  });

  it('says messages are not available yet without sending the user to another signer', () => {
    for (const signer of ['bitkit', 'passport'] as const) {
      const copy = grantSessionRefusalCopy('messaging', signer);
      expect(copy).toMatch(/^Messages are not available for (Bitkit|Pubky Passport) sign-ins yet\./);
      expect(copy).not.toMatch(/Pubky Ring/);
    }
  });
});

describe('GrantSessionRefusal', () => {
  it('renders the copy for the signed-in grant signer', () => {
    view.signer = 'passport';
    render(<GrantSessionRefusal reason="messaging" />);

    expect(screen.getByTestId('grant-session-refusal')).toHaveTextContent(
      'Messages are not available for Pubky Passport sign-ins yet. Everything else in Shop works with this sign-in.',
    );
  });

  it('falls back to Bitkit copy when no grant signer is known', () => {
    view.signer = null;
    render(<GrantSessionRefusal />);

    expect(screen.getByTestId('grant-session-refusal')).toHaveTextContent(
      'Bitkit sign-in does not cover this step yet.',
    );
  });
});
