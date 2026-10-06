import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { MessagingKeyChangedNotice, MessagingKeysToggle } from './MessagingKeys';

vi.mock('@/controllers/messaging/messaging', () => ({
  MessagingController: { getMessagingKeys: vi.fn() },
}));

const COUNTERPARTY = 'z'.repeat(52);
const OWN_KEY = 'o'.repeat(52);
const PINNED_KEY = 'p'.repeat(52);

describe('MessagingKeysToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MessagingController.getMessagingKeys).mockResolvedValue({
      ownKey: OWN_KEY,
      pinnedKey: PINNED_KEY,
      observedKey: null,
    });
  });

  it('reads nothing until opened, then shows both keys in readable groups', async () => {
    render(<MessagingKeysToggle counterpartyPubky={COUNTERPARTY} />);
    expect(MessagingController.getMessagingKeys).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: MESSAGING_COPY.messagingKeys }));

    const panel = await screen.findByTestId('messaging-keys');
    await waitFor(() => expect(panel).toHaveTextContent(MESSAGING_COPY.messagingKeysYours));
    expect(MessagingController.getMessagingKeys).toHaveBeenCalledWith(COUNTERPARTY);
    expect(panel).toHaveTextContent(`${'oooo '.repeat(12)}oooo`);
    expect(panel).toHaveTextContent(`${'pppp '.repeat(12)}pppp`);
  });

  it('says when the other person has no key pinned yet', async () => {
    vi.mocked(MessagingController.getMessagingKeys).mockResolvedValue({
      ownKey: OWN_KEY,
      pinnedKey: null,
      observedKey: null,
    });
    render(<MessagingKeysToggle counterpartyPubky={COUNTERPARTY} />);

    fireEvent.click(screen.getByRole('button', { name: MESSAGING_COPY.messagingKeys }));

    expect(await screen.findByText(MESSAGING_COPY.messagingKeysNone)).toBeInTheDocument();
  });
});

describe('MessagingKeyChangedNotice', () => {
  it('disables Accept while an acceptance is in flight', () => {
    render(
      <MessagingKeyChangedNotice
        keyChange={{ pinnedKey: PINNED_KEY, observedKey: 'q'.repeat(52) }}
        onAccept={vi.fn()}
        isAccepting
      />,
    );

    expect(screen.getByRole('button', { name: MESSAGING_COPY.keyChangedAccept })).toBeDisabled();
  });
});
