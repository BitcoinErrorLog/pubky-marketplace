import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MESSAGING_COPY, messagingReportText } from '@/libs/commerce/messaging-copy';
import { toast } from '@/molecules/Toaster/use-toast';
import { useMessagingSafety } from './useMessagingSafety';

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const COUNTERPARTY = 'z'.repeat(52);
const CONVERSATION = `dm:${COUNTERPARTY}`;

describe('useMessagingSafety', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast).mockClear();
  });

  it('copies the report details to the clipboard only, never opening anything', async () => {
    const details = messagingReportText({ conversationId: CONVERSATION, counterpartyPubky: COUNTERPARTY });
    vi.spyOn(MessagingController, 'getReportDetails').mockResolvedValue(details);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    const { result } = renderHook(() => useMessagingSafety());
    await act(async () => {
      await expect(result.current.report(CONVERSATION)).resolves.toBe(true);
    });

    expect(writeText).toHaveBeenCalledWith(details);
    expect(details).toContain(CONVERSATION);
    expect(details).toContain(COUNTERPARTY);
    expect(details).not.toMatch(/https?:\/\//);
    expect(open).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ description: MESSAGING_COPY.reportCopied });
  });

  it('says when a mute needs approval and reports it did not take effect', async () => {
    vi.spyOn(MessagingController, 'setCounterpartyMuted').mockResolvedValue({ kind: 'needs_approval' });

    const { result } = renderHook(() => useMessagingSafety());
    await act(async () => {
      await expect(result.current.mute(COUNTERPARTY)).resolves.toBe(false);
    });

    expect(toast).toHaveBeenCalledWith({ variant: 'warning', description: MESSAGING_COPY.muteNeedsApproval });
  });

  it('confirms a saved mute', async () => {
    vi.spyOn(MessagingController, 'setCounterpartyMuted').mockResolvedValue({
      kind: 'ready',
      muted: new Set([COUNTERPARTY]),
    });

    const { result } = renderHook(() => useMessagingSafety());
    await act(async () => {
      await expect(result.current.mute(COUNTERPARTY)).resolves.toBe(true);
    });

    expect(MessagingController.setCounterpartyMuted).toHaveBeenCalledWith(COUNTERPARTY, true);
    expect(toast).toHaveBeenCalledWith({ description: MESSAGING_COPY.muted });
  });

  it('says the list is full when a mute is refused for that reason', async () => {
    vi.spyOn(MessagingController, 'setCounterpartyMuted').mockResolvedValue({ kind: 'full' });

    const { result } = renderHook(() => useMessagingSafety());
    await act(async () => {
      await expect(result.current.mute(COUNTERPARTY)).resolves.toBe(false);
    });

    expect(toast).toHaveBeenCalledWith({ variant: 'error', description: MESSAGING_COPY.muteListFull });
  });
});
