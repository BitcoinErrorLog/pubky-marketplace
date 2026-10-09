import { describe, expect, it } from 'vitest';
import {
  LOCKS_ADMISSION_COPY,
  LOCKS_STALLED_GRACE_MS,
  LOCKS_TERMINAL_REASON_COPY,
  LOCKS_TERMINAL_REASONS,
  locksAdmissionFailureCopy,
  locksAdmissionView,
  locksTerminalReasonCopy,
} from './locks-lifecycle';

const base = { failure_message: null, status_message: null };
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('locksAdmissionView', () => {
  it('reads "Reader wallet setup needed" only on a pending task', () => {
    expect(locksAdmissionView({ ...base, status: 'pending', status_message: 'Reader wallet setup needed' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: true,
      stalled: false,
    });
    expect(locksAdmissionView({ ...base, status: 'pending' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
      stalled: false,
    });
    expect(
      locksAdmissionView({ ...base, status: 'in_progress', status_message: 'Reader wallet setup needed' }),
    ).toEqual({ kind: 'in_flight', readerWalletSetupNeeded: false, stalled: false });
  });

  it('never trusts an unknown status message, and a lifecycle without the field is plain pending', () => {
    expect(locksAdmissionView({ ...base, status: 'pending', status_message: 'future progress text' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
      stalled: false,
    });
    expect(locksAdmissionView({ status: 'pending', failure_message: null })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
      stalled: false,
    });
  });

  describe('stalled worker (admission_deadline_at)', () => {
    const pending = (deadline: string | null | undefined) =>
      locksAdmissionView({ ...base, status: 'pending', admission_deadline_at: deadline }, NOW);

    it('is not stalled before the deadline, or inside the grace after it', () => {
      expect(pending(iso(60_000))).toMatchObject({ stalled: false });
      expect(pending(iso(0))).toMatchObject({ stalled: false });
      expect(pending(iso(-LOCKS_STALLED_GRACE_MS))).toMatchObject({ stalled: false });
    });

    it('is stalled once the deadline plus the grace has passed', () => {
      expect(pending(iso(-LOCKS_STALLED_GRACE_MS - 1))).toMatchObject({ kind: 'in_flight', stalled: true });
    });

    it('keeps the wallet-setup reading while stalled', () => {
      expect(
        locksAdmissionView(
          {
            ...base,
            status: 'pending',
            status_message: 'Reader wallet setup needed',
            admission_deadline_at: iso(-LOCKS_STALLED_GRACE_MS - 1),
          },
          NOW,
        ),
      ).toEqual({ kind: 'in_flight', readerWalletSetupNeeded: true, stalled: true });
    });

    it.each([undefined, null, '', 'not a timestamp'])(
      'reads %j as not stalled (an rc8 Lock Server omits it)',
      (value) => {
        expect(pending(value)).toMatchObject({ stalled: false });
      },
    );

    it('never reads an in-progress task as stalled', () => {
      expect(
        locksAdmissionView(
          { ...base, status: 'in_progress', admission_deadline_at: iso(-LOCKS_STALLED_GRACE_MS * 10) },
          NOW,
        ),
      ).toMatchObject({ stalled: false });
    });

    it('is never stalled once the task has left pending', () => {
      const deadline = iso(-LOCKS_STALLED_GRACE_MS * 10);
      expect(locksAdmissionView({ ...base, status: 'completed', admission_deadline_at: deadline }, NOW)).toEqual({
        kind: 'settled',
      });
      expect(
        locksAdmissionView(
          { ...base, status: 'failed', failure_message: 'reader is not payable', admission_deadline_at: deadline },
          NOW,
        ),
      ).toEqual({ kind: 'failed', failure: 'reader_not_payable' });
    });
  });

  it.each([
    ['reader is not payable', 'reader_not_payable', LOCKS_ADMISSION_COPY.readerNotPayable],
    [
      'invoice admission deadline exceeded',
      'admission_deadline_exceeded',
      LOCKS_ADMISSION_COPY.admissionDeadlineExceeded,
    ],
    ['paykit invoice conflict', 'invoice_conflict', LOCKS_ADMISSION_COPY.invoiceConflict],
    ['paykit invoice admission failed', 'admission_failed', LOCKS_ADMISSION_COPY.admissionFailed],
    ['verification failed', 'failed', LOCKS_ADMISSION_COPY.failed],
    ['entitlement not satisfied', 'failed', LOCKS_ADMISSION_COPY.failed],
    ['content lock unavailable', 'failed', LOCKS_ADMISSION_COPY.failed],
    ['content lock invalid', 'failed', LOCKS_ADMISSION_COPY.failed],
    ['<script>attacker text</script>', 'failed', LOCKS_ADMISSION_COPY.failed],
  ] as const)('maps the failed message %j to static copy', (message, failure, copy) => {
    const view = locksAdmissionView({ ...base, status: 'failed', failure_message: message });
    expect(view).toEqual({ kind: 'failed', failure });
    expect(locksAdmissionFailureCopy(failure)).toBe(copy);
    expect(copy).not.toBe(message);
    expect(copy).not.toMatch(/[<>]/);
  });

  it('treats a failed task with no message as a generic failure', () => {
    expect(locksAdmissionView({ ...base, status: 'failed' })).toEqual({ kind: 'failed', failure: 'failed' });
  });

  it('does not claim nothing was charged after a post-deadline failure', () => {
    expect(LOCKS_ADMISSION_COPY.admissionDeadlineExceeded).not.toMatch(/nothing was charged/i);
    expect(LOCKS_ADMISSION_COPY.admissionDeadlineExceeded).toMatch(/don’t pay it/);
  });

  it('treats completed as settled: the marketplace projection reports it', () => {
    expect(locksAdmissionView({ ...base, status: 'completed' })).toEqual({ kind: 'settled' });
  });

  describe('expired terminal reasons', () => {
    it.each(LOCKS_TERMINAL_REASONS)('maps %s to its own static copy', (reason) => {
      const view = locksAdmissionView({ ...base, status: 'expired', terminal_reason: reason });
      expect(view).toEqual({ kind: 'expired', reason });
      expect(locksTerminalReasonCopy(reason)).toBe(LOCKS_TERMINAL_REASON_COPY[reason]);
      expect(locksTerminalReasonCopy(reason)).not.toContain(reason);
    });

    it('gives every reason distinct copy', () => {
      expect(new Set(Object.values(LOCKS_TERMINAL_REASON_COPY)).size).toBe(LOCKS_TERMINAL_REASONS.length);
    });

    it.each([undefined, null, '', 'something_new', '<b>x</b>'])(
      'reads an expired task with terminal_reason %j as settled',
      (terminal_reason) => {
        expect(locksAdmissionView({ ...base, status: 'expired', terminal_reason })).toEqual({ kind: 'settled' });
      },
    );

    it('ignores a terminal reason on a task that is not expired', () => {
      expect(locksAdmissionView({ ...base, status: 'pending', terminal_reason: 'proposal_expired' })).toMatchObject({
        kind: 'in_flight',
      });
      expect(locksAdmissionView({ ...base, status: 'failed', terminal_reason: 'proposal_expired' })).toEqual({
        kind: 'failed',
        failure: 'failed',
      });
    });
  });

  it.each(['content lock unavailable', 'verification failed'])(
    'does not infer whether money moved from the post-admission failure %j',
    (message) => {
      const view = locksAdmissionView({ ...base, status: 'failed', failure_message: message });
      expect(view.kind).toBe('failed');
      if (view.kind !== 'failed') throw new Error('Expected a failed task');
      const copy = locksAdmissionFailureCopy(view.failure);
      expect(copy).not.toMatch(/nothing was charged|could not be created/i);
      expect(copy).toMatch(/check your wallet/i);
      expect(copy).toBe(LOCKS_ADMISSION_COPY.failed);
    },
  );
});
