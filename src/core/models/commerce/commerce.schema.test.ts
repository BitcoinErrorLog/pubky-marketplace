import { describe, expect, it } from 'vitest';
import {
  isListingReadBackPending,
  isListingRegistrationPending,
  LISTING_READ_BACK_PENDING_WINDOW_MS,
} from './commerce.schema';

describe('isListingRegistrationPending', () => {
  it.each([
    { registration_status: undefined, expected: true },
    { registration_status: 'unregistered' as const, expected: true },
    { registration_status: 'registered' as const, expected: false },
    { registration_status: 'unavailable' as const, expected: false },
  ])('returns $expected for $registration_status', ({ registration_status, expected }) => {
    expect(isListingRegistrationPending({ registration_status })).toBe(expected);
  });
});

describe('isListingReadBackPending', () => {
  const since = 1_790_000_000_000;

  it.each([
    { label: 'no marker', read_back_pending_since: undefined, now: since, expected: false },
    { label: 'at the publish', read_back_pending_since: since, now: since, expected: true },
    {
      label: 'just inside the window',
      read_back_pending_since: since,
      now: since + LISTING_READ_BACK_PENDING_WINDOW_MS - 1,
      expected: true,
    },
    {
      label: 'once the window has passed',
      read_back_pending_since: since,
      now: since + LISTING_READ_BACK_PENDING_WINDOW_MS,
      expected: false,
    },
    { label: 'after the clock moved backward', read_back_pending_since: since, now: since - 1, expected: false },
    {
      label: 'after the clock moved far backward',
      read_back_pending_since: since,
      now: since - 24 * 60 * 60_000,
      expected: false,
    },
  ])('returns $expected $label', ({ read_back_pending_since, now, expected }) => {
    expect(isListingReadBackPending({ read_back_pending_since }, now)).toBe(expected);
  });
});
