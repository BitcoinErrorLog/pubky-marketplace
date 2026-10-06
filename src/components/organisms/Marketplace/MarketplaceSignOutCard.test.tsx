import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_OUT_COPY } from '@/hooks/useSignOutCopy/useSignOutCopy';
import { useAuthStore } from '@/stores/auth/auth.store';
import { asOpaque } from '@/test-utils/type-assertions';
import { MarketplaceSignOutCard } from './MarketplaceSignOutCard';

const signOut = vi.hoisted(() => ({ handleSignOut: vi.fn(), isLoading: false }));

vi.mock('@/hooks/useSignOut/useSignOut', () => ({
  useSignOut: () => signOut,
}));

describe('MarketplaceSignOutCard', () => {
  beforeEach(() => {
    signOut.handleSignOut.mockReset();
    signOut.isLoading = false;
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ session: null });
    });
  });

  it('signs out through the shared sign-out flow', () => {
    render(<MarketplaceSignOutCard />);

    expect(screen.getByRole('heading', { name: 'Sign out' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signOut.handleSignOut).toHaveBeenCalledTimes(1);
  });

  it('disables the button while signing out', () => {
    signOut.isLoading = true;
    render(<MarketplaceSignOutCard />);

    expect(screen.getByRole('button', { name: 'Signing out...' })).toBeDisabled();
  });

  it('says a Pubky Ring sign-out also signs pubky.app out in this browser', () => {
    useAuthStore.setState({ session: asOpaque({ info: {} }) });
    render(<MarketplaceSignOutCard />);

    const card = screen.getByTestId('marketplace-sign-out-card');
    expect(card).toHaveTextContent(SIGN_OUT_COPY.cookie);
    expect(card).not.toHaveTextContent(SIGN_OUT_COPY.grant);
    expect(card).not.toHaveTextContent('Sign out from Pubky');
  });

  it('says a Bitkit grant sign-out leaves pubky.app signed in', () => {
    useAuthStore.setState({ session: asOpaque({ info: {}, grant: {} }) });
    render(<MarketplaceSignOutCard />);

    const card = screen.getByTestId('marketplace-sign-out-card');
    expect(card).toHaveTextContent(SIGN_OUT_COPY.grant);
    expect(card).not.toHaveTextContent(SIGN_OUT_COPY.cookie);
  });
});
