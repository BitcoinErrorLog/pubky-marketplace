import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pubky } from '@/models/models.types';
import { useSessionHandoffStore } from '@/stores/sessionHandoff/sessionHandoff.store';
import { DialogSessionHandoff } from './DialogSessionHandoff';

const answerSessionHandoff = vi.hoisted(() => vi.fn());
vi.mock('@/controllers/auth/auth', () => ({
  AuthController: { answerSessionHandoff },
}));

const PUBKY = 'o1gg8yc7mj4ksrzr6ms3s5rs8h7bo8y7ohcq7j88wbkm7ns7tuxo' as Pubky;

describe('DialogSessionHandoff', () => {
  afterEach(() => {
    act(() => useSessionHandoffStore.getState().setPendingPubky(null));
    answerSessionHandoff.mockClear();
  });

  it('renders nothing while no hand-off waits', () => {
    render(<DialogSessionHandoff />);

    expect(screen.queryByTestId('session-handoff-dialog')).not.toBeInTheDocument();
  });

  it('names the account the link would sign in as', () => {
    act(() => useSessionHandoffStore.getState().setPendingPubky(PUBKY));
    render(<DialogSessionHandoff />);

    expect(screen.getByRole('heading', { name: 'Continue as this account?' })).toBeInTheDocument();
    expect(screen.getByTestId('session-handoff-pubky')).toHaveTextContent('pubkyo1gg8yc7...7ns7tuxo');
  });

  it('Continue accepts the hand-off', async () => {
    act(() => useSessionHandoffStore.getState().setPendingPubky(PUBKY));
    render(<DialogSessionHandoff />);

    await userEvent.setup().click(screen.getByTestId('session-handoff-accept'));

    expect(answerSessionHandoff).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('Not me declines the hand-off', async () => {
    act(() => useSessionHandoffStore.getState().setPendingPubky(PUBKY));
    render(<DialogSessionHandoff />);

    await userEvent.setup().click(screen.getByTestId('session-handoff-decline'));

    expect(answerSessionHandoff).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('dismissing the dialog declines the hand-off', async () => {
    act(() => useSessionHandoffStore.getState().setPendingPubky(PUBKY));
    render(<DialogSessionHandoff />);

    await userEvent.setup().keyboard('{Escape}');

    expect(answerSessionHandoff).toHaveBeenCalledExactlyOnceWith(false);
  });
});
