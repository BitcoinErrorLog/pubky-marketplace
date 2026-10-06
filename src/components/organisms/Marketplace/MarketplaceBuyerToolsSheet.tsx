'use client';

import { useState } from 'react';
import {
  Bell,
  HandCoins,
  Heart,
  LayoutDashboard,
  type LucideIcon,
  MessageCircle,
  ReceiptText,
  ShoppingCart,
} from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/atoms/Sheet/Sheet';
import { Typography } from '@/atoms/Typography/Typography';
import { cn } from '@/libs/utils/utils';

interface MarketplaceBuyerToolsSheetProps {
  cartCount: number;
  activityUnreadCount: number;
  onNavigate: (href: string) => void;
}

type MarketplaceBuyerTool = {
  label: string;
  href: string;
  icon: LucideIcon;
  countKey?: 'cart' | 'activity';
};

const MARKETPLACE_BUYER_TOOLS: MarketplaceBuyerTool[] = [
  { label: 'Messages', href: MARKETPLACE_ROUTES.MESSAGES, icon: MessageCircle },
  { label: 'Offers', href: MARKETPLACE_ROUTES.OFFERS, icon: HandCoins },
  { label: 'Watchlist', href: MARKETPLACE_ROUTES.WATCHLIST, icon: Heart },
  { label: 'Cart', href: MARKETPLACE_ROUTES.CART, icon: ShoppingCart, countKey: 'cart' },
  { label: 'Orders', href: MARKETPLACE_ROUTES.ORDERS, icon: ReceiptText },
  { label: 'Activity', href: MARKETPLACE_ROUTES.NOTIFICATIONS, icon: Bell, countKey: 'activity' },
  { label: 'Seller studio', href: MARKETPLACE_ROUTES.DASHBOARD, icon: LayoutDashboard },
] as const;

export function MarketplaceBuyerToolsSheet({
  cartCount,
  activityUnreadCount,
  onNavigate,
}: MarketplaceBuyerToolsSheetProps) {
  const [open, setOpen] = useState(false);

  const navigate = (href: string) => {
    setOpen(false);
    onNavigate(href);
  };

  const countFor = (key: MarketplaceBuyerTool['countKey']) => {
    if (key === 'cart') return cartCount;
    if (key === 'activity') return activityUnreadCount;
    return 0;
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" className="rounded-full">
          <LayoutDashboard className="mr-2 size-4" />
          My marketplace
          <MarketplaceNavCountBadge count={cartCount + activityUnreadCount} className="ml-2" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="rounded-t-2xl border-border bg-popover px-4 pb-6"
      >
        <SheetHeader>
          <SheetTitle>My marketplace</SheetTitle>
        </SheetHeader>
        <div className="mt-4 grid gap-2" data-testid="marketplace-buyer-tools-sheet">
          {MARKETPLACE_BUYER_TOOLS.map(({ label, href, icon: Icon, countKey }) => {
            const count = countFor(countKey);
            return (
              <button
                key={href}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-brand/40"
                aria-label={count > 0 ? `${label}, ${count > 21 ? '21+' : count}` : label}
                onClick={() => navigate(href)}
              >
                <Icon className="size-5 text-brand" />
                <Typography as="span" className="flex-1 font-medium">
                  {label}
                </Typography>
                <MarketplaceNavCountBadge count={count} />
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function MarketplaceNavCountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <Badge className={cn('h-5 min-w-5 rounded-full bg-brand px-1.5 shadow-sm', className)} variant="secondary">
      <Typography className={cn('font-semibold text-primary-foreground', count > 21 && 'text-xs')} size="xs">
        {count > 21 ? '21+' : count}
      </Typography>
    </Badge>
  );
}
