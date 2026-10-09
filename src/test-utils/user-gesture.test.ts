import { describe, expect, it, vi } from 'vitest';
import { navigatesWithinGesture } from './user-gesture';

describe('navigatesWithinGesture', () => {
  it('accepts a handler that navigates before it returns', () => {
    const navigate = vi.fn();
    expect(navigatesWithinGesture(navigate, 'pubkyauth://x', () => navigate('pubkyauth://x'))).toBe(true);
  });

  it('rejects a handler that navigates after an await, which iOS Safari would drop', () => {
    const navigate = vi.fn();
    const handler = async () => {
      await Promise.resolve();
      navigate('pubkyauth://x');
    };
    expect(navigatesWithinGesture(navigate, 'pubkyauth://x', () => void handler())).toBe(false);
  });

  it('rejects a navigation to a different URL or one that happens twice', () => {
    const navigate = vi.fn();
    expect(navigatesWithinGesture(navigate, 'pubkyauth://x', () => navigate('pubkyauth://y'))).toBe(false);
    expect(
      navigatesWithinGesture(navigate, 'pubkyauth://x', () => {
        navigate('pubkyauth://x');
        navigate('pubkyauth://x');
      }),
    ).toBe(false);
  });
});
