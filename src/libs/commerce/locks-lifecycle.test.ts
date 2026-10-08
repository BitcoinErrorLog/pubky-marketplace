import { describe, expect, it } from 'vitest';
import { LOCKS_ADMISSION_COPY, locksAdmissionFailureCopy, locksAdmissionView } from './locks-lifecycle';

const base = { failure_message: null, status_message: null };

describe('locksAdmissionView', () => {
  it('reads "Reader wallet setup needed" only on a pending task', () => {
    expect(locksAdmissionView({ ...base, status: 'pending', status_message: 'Reader wallet setup needed' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: true,
    });
    expect(locksAdmissionView({ ...base, status: 'pending' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
    });
    expect(
      locksAdmissionView({ ...base, status: 'in_progress', status_message: 'Reader wallet setup needed' }),
    ).toEqual({ kind: 'in_flight', readerWalletSetupNeeded: false });
  });

  it('never trusts an unknown status message, and a lifecycle without the field is plain pending', () => {
    expect(locksAdmissionView({ ...base, status: 'pending', status_message: 'future progress text' })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
    });
    expect(locksAdmissionView({ status: 'pending', failure_message: null })).toEqual({
      kind: 'in_flight',
      readerWalletSetupNeeded: false,
    });
  });

  it.each([
    ['reader is not payable', 'reader_not_payable', LOCKS_ADMISSION_COPY.readerNotPayable],
    [
      'invoice admission deadline exceeded',
      'admission_deadline_exceeded',
      LOCKS_ADMISSION_COPY.admissionDeadlineExceeded,
    ],
    ['paykit invoice admission failed', 'failed', LOCKS_ADMISSION_COPY.failed],
    ['<script>attacker text</script>', 'failed', LOCKS_ADMISSION_COPY.failed],
  ] as const)('maps the failed message %j to static copy', (message, failure, copy) => {
    const view = locksAdmissionView({ ...base, status: 'failed', failure_message: message });
    expect(view).toEqual({ kind: 'failed', failure });
    expect(locksAdmissionFailureCopy(failure)).toBe(copy);
    expect(copy).not.toContain(message);
  });

  it('treats completed and expired as settled: the marketplace projection reports them', () => {
    expect(locksAdmissionView({ ...base, status: 'completed' })).toEqual({ kind: 'settled' });
    expect(locksAdmissionView({ ...base, status: 'expired' })).toEqual({ kind: 'settled' });
  });
});
