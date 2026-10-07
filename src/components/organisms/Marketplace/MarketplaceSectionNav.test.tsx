import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { setSocialHost } from '@/test-utils/social-host';
import { MarketplaceSectionNav } from './MarketplaceSectionNav';

const state = vi.hoisted(() => ({
  pathname: '/marketplace/offers' as string | null,
  activityCount: 22,
  ordersCount: 0,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 3,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => state.activityCount,
}));

vi.mock('@/hooks/useMarketplaceOrdersAttention/useMarketplaceOrdersAttention', () => ({
  useMarketplaceOrdersAttention: () => state.ordersCount,
}));

vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: vi.fn(({ enabled = true } = {}) => (enabled ? 4 : 0)),
}));

describe('MarketplaceSectionNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSocialHost(undefined);
    state.pathname = '/marketplace/offers';
    state.activityCount = 22;
    state.ordersCount = 0;
  });

  afterEach(() => setSocialHost(undefined));

  it('highlights the active section and wires both badges', () => {
    render(<MarketplaceSectionNav />);

    expect(screen.getByRole('link', { name: 'Offers' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Marketplace' })).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('marketplace-section-nav-cart-badge')).toHaveTextContent('3');
    expect(screen.getByTestId('marketplace-section-nav-activity-badge')).toHaveTextContent('21+');
  });

  it('keeps unread messages visible in the Shop section navigation', () => {
    setSocialHost('https://pubky.app');
    render(<MarketplaceSectionNav />);
    expect(screen.getByTestId('marketplace-section-nav-messages-badge')).toHaveTextContent('4');
    expect(screen.getByLabelText('4 unread messages')).toBeInTheDocument();
    expect(useMessagesUnread).toHaveBeenCalledWith({ enabled: true });
  });

  it('leaves message counts to the global navigation while link-out is off', () => {
    render(<MarketplaceSectionNav />);

    expect(screen.queryByTestId('marketplace-section-nav-messages-badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Shop settings' })).not.toBeInTheDocument();
    expect(useMessagesUnread).toHaveBeenCalledWith({ enabled: false });
  });

  it('lets a link-out buyer open local Shop settings from the section navigation', () => {
    setSocialHost('https://pubky.app');
    state.pathname = '/marketplace';
    const onNavigate = vi.fn();
    render(<MarketplaceSectionNav onNavigate={onNavigate} />);

    const settings = screen.getByRole('link', { name: 'Shop settings' });
    expect(settings).toHaveAttribute('href', '/marketplace/settings');
    settings.click();
    expect(onNavigate).toHaveBeenCalledWith('/marketplace/settings');
  });

  it.each(['/marketplace/settings', '/marketplace/settings/addresses', '/marketplace/settings/shipping'])(
    'highlights only Shop settings at %s while link-out is on',
    (pathname) => {
      setSocialHost('https://pubky.app');
      state.pathname = pathname;
      render(<MarketplaceSectionNav />);

      expect(screen.getByRole('link', { name: 'Shop settings' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Seller studio' })).not.toHaveAttribute('aria-current');
      expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    },
  );

  it('keeps settings under Seller studio while link-out is off', () => {
    state.pathname = '/marketplace/settings';
    render(<MarketplaceSectionNav />);
    expect(screen.getByRole('link', { name: 'Seller studio' })).toHaveAttribute('aria-current', 'page');
  });

  it('badges orders that still need the signed-in identity', () => {
    state.ordersCount = 2;
    render(<MarketplaceSectionNav />);

    expect(screen.getByTestId('marketplace-section-nav-orders-badge')).toHaveTextContent('2');
    expect(screen.getByLabelText('2 orders needing you')).toBeInTheDocument();
  });

  it('highlights seller studio subroutes without highlighting buyer sections', () => {
    state.pathname = '/marketplace/sell';
    render(<MarketplaceSectionNav />);

    expect(screen.getByRole('link', { name: 'Seller studio' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Offers' })).not.toHaveAttribute('aria-current');
  });

  it('does not highlight a section while the pathname is unavailable', () => {
    state.pathname = null;
    render(<MarketplaceSectionNav />);

    expect(screen.getAllByRole('link')).toHaveLength(8);
    expect(screen.getAllByRole('link').every((link) => !link.hasAttribute('aria-current'))).toBe(true);
  });

  it('wraps the section row instead of cropping the last item', () => {
    state.activityCount = 12;
    render(<MarketplaceSectionNav />);

    const nav = screen.getByTestId('marketplace-section-nav');
    expect(nav).not.toHaveClass('overflow-x-auto');
    expect(nav.firstElementChild).toHaveClass('flex-wrap');
    expect(nav.firstElementChild).not.toHaveClass('min-w-max');
    expect(screen.getByRole('link', { name: /Activity/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Seller studio' })).toBeVisible();
    expect(screen.getByTestId('marketplace-section-nav-activity-badge')).toHaveTextContent('12');
  });

  it('delegates guarded home navigation without requiring an app router', () => {
    const onNavigate = vi.fn();
    render(<MarketplaceSectionNav onNavigate={onNavigate} />);

    screen.getByRole('link', { name: 'Orders' }).click();

    expect(onNavigate).toHaveBeenCalledWith('/marketplace/orders');
  });
});
