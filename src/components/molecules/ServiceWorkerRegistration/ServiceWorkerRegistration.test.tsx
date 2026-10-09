import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBasePath } from '@/test-utils/base-path';
import { setEmbedded } from '@/test-utils/embedded';
import { ServiceWorkerRegistration } from './ServiceWorkerRegistration';

type SerwistWindow = Window & { serwist?: { register: () => Promise<unknown> } };

describe('ServiceWorkerRegistration', () => {
  const register = vi.fn(async () => undefined);

  beforeEach(() => {
    register.mockClear();
    (window as SerwistWindow).serwist = { register };
  });

  afterEach(() => {
    delete (window as SerwistWindow).serwist;
    setBasePath('');
    setEmbedded(false);
  });

  it('registers the worker for a top-level Shop served from the origin root', () => {
    render(<ServiceWorkerRegistration />);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does not register when the Shop is embedded', () => {
    setEmbedded(true);
    render(<ServiceWorkerRegistration />);
    expect(register).not.toHaveBeenCalled();
  });

  it('does not register when the Shop is mounted under another app on a shared origin', () => {
    setBasePath('/shop');
    render(<ServiceWorkerRegistration />);
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing where the build plugin defined no worker (development)', () => {
    delete (window as SerwistWindow).serwist;
    expect(() => render(<ServiceWorkerRegistration />)).not.toThrow();
  });
});
