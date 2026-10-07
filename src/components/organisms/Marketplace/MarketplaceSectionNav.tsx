'use client';

import { usePathname } from 'next/navigation';
import { Bell, HandCoins, Heart, LayoutDashboard, MessageCircle, ReceiptText, ShoppingCart, Store } from 'lucide-react';
import { APP_ROUTES, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceActivityUnread } from '@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread';
import { useMarketplaceCartCount } from '@/hooks/useMarketplaceCartCount/useMarketplaceCartCount';
import { useMarketplaceOrdersAttention } from '@/hooks/useMarketplaceOrdersAttention/useMarketplaceOrdersAttention';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { cn } from '@/libs/utils/utils';

type MarketplaceSectionItem = {
  label: string;
  href: string;
  icon: typeof MessageCircle;
  badge?: 'cart' | 'activity' | 'orders' | 'messages';
  activePrefixes?: readonly string[];
};

const ITEMS: readonly MarketplaceSectionItem[] = [
  {
    label: 'Marketplace',
    href: APP_ROUTES.MARKETPLACE,
    icon: Store,
    activePrefixes: [
      APP_ROUTES.MARKETPLACE,
      MARKETPLACE_ROUTES.LISTING,
      MARKETPLACE_ROUTES.DROP,
      MARKETPLACE_ROUTES.DROPS,
    ],
  },
  { label: 'Messages', href: MARKETPLACE_ROUTES.MESSAGES, icon: MessageCircle, badge: 'messages' },
  { label: 'Offers', href: MARKETPLACE_ROUTES.OFFERS, icon: HandCoins },
  { label: 'Watchlist', href: MARKETPLACE_ROUTES.WATCHLIST, icon: Heart },
  {
    label: 'Cart',
    href: MARKETPLACE_ROUTES.CART,
    icon: ShoppingCart,
    badge: 'cart',
    activePrefixes: [MARKETPLACE_ROUTES.CART, MARKETPLACE_ROUTES.CHECKOUT, MARKETPLACE_ROUTES.AWARD_CHECKOUT],
  },
  { label: 'Orders', href: MARKETPLACE_ROUTES.ORDERS, icon: ReceiptText, badge: 'orders' },
  { label: 'Activity', href: MARKETPLACE_ROUTES.NOTIFICATIONS, icon: Bell, badge: 'activity' },
  {
    label: 'Seller studio',
    href: MARKETPLACE_ROUTES.DASHBOARD,
    icon: LayoutDashboard,
    activePrefixes: [
      MARKETPLACE_ROUTES.DASHBOARD,
      MARKETPLACE_ROUTES.SELL,
      MARKETPLACE_ROUTES.MY_SHOP,
      MARKETPLACE_ROUTES.SETTINGS,
    ],
  },
] as const;

export function MarketplaceSectionNav({
  onNavigate,
  className,
}: {
  onNavigate?: (href: string) => void;
  className?: string;
}) {
  const pathname = usePathname();
  const cartCount = useMarketplaceCartCount();
  const messagesCount = useMessagesUnread();
  const activityUnreadCount = useMarketplaceActivityUnread();
  const ordersAttentionCount = useMarketplaceOrdersAttention();

  return (
    <nav
      aria-label="Marketplace sections"
      data-testid="marketplace-section-nav"
      data-surface="marketplace-section-nav"
      className={cn('mb-6 w-full', className)}
    >
      <div className="flex w-full flex-wrap">
        {ITEMS.map(({ label, href, icon: Icon, badge, activePrefixes }) => {
          const prefixes = activePrefixes ?? [href];
          const active =
            typeof pathname === 'string' &&
            prefixes.some(
              (prefix) =>
                pathname === prefix || (prefix !== APP_ROUTES.MARKETPLACE && pathname.startsWith(`${prefix}/`)),
            );
          const count =
            badge === 'cart'
              ? cartCount
              : badge === 'activity'
                ? activityUnreadCount
                : badge === 'orders'
                  ? ordersAttentionCount
                  : badge === 'messages'
                    ? messagesCount
                    : 0;
          const badgeNoun =
            badge === 'cart'
              ? 'cart items'
              : badge === 'orders'
                ? 'orders needing you'
                : badge === 'messages'
                  ? 'unread messages'
                  : 'activity needing you';
          return (
            <Link
              key={label}
              href={href}
              prefetch={false}
              overrideDefaults
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                if (onNavigate) {
                  event.preventDefault();
                  onNavigate(href);
                }
              }}
              className={cn(
                'relative inline-flex min-h-12 flex-1 shrink-0 items-center justify-center gap-2 border-b px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:text-white',
                active ? 'border-white text-white' : 'border-border text-muted-foreground',
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className={cn(!active && 'sr-only sm:not-sr-only')}>{label}</span>
              {count > 0 && (
                <Badge
                  data-testid={`marketplace-section-nav-${badge}-badge`}
                  aria-label={`${count} ${badgeNoun}`}
                  className="h-5 min-w-5 rounded-full bg-brand px-1.5 shadow-sm"
                  variant="secondary"
                >
                  <Typography
                    className={cn('font-semibold text-primary-foreground', count > 21 && 'text-xs')}
                    size="xs"
                  >
                    {count > 21 ? '21+' : count}
                  </Typography>
                </Badge>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
