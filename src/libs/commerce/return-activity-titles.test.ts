import { describe, expect, it } from 'vitest';
import { returnActivityTitle, returnActivityTitles } from './return-activity-titles';

const ORDER = '018f47d2-6a27-7c23-a62f-000000000001';

describe('return activity titles', () => {
  it('names the request, then the approval, then the receipt', () => {
    const reasons = new Map<string, string | null>([[ORDER, 'mistake on my part']]);
    const titles = returnActivityTitles(
      [
        { id: 'b', aggregateId: `order:${ORDER}`, createdAt: '2026-08-19T00:00:00.000Z' },
        { id: 'a', aggregateId: `order:${ORDER}`, createdAt: '2026-08-14T00:00:00.000Z' },
        { id: 'c', aggregateId: `order:${ORDER}`, createdAt: '2026-09-23T00:00:00.000Z' },
      ],
      reasons,
      true,
    );
    expect(titles.get('a')).toBe('Return requested — mistake on my part');
    expect(titles.get('b')).toBe('Return approved');
    expect(titles.get('c')).toBe('Return received');
  });

  it('keeps Return updated until the order is loaded', () => {
    const titles = returnActivityTitles(
      [{ id: 'a', aggregateId: `order:${ORDER}`, createdAt: '2026-08-14T00:00:00.000Z' }],
      new Map(),
      false,
    );
    expect(titles.get('a')).toBe('Return updated');
    expect(returnActivityTitle(0, null)).toBe('Return requested');
  });
});
