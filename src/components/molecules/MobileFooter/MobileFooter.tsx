'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell,
  FileText,
  Flame,
  Home,
  Library,
  MessageCircle,
  Search,
  Settings,
  Store,
  UserRound,
  UserRoundPlus,
} from 'lucide-react';
import { APP_ROUTES, isNavItemActive, MARKETPLACE_ROUTES, PROFILE_ROUTES, SETTINGS_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/atoms/DropdownMenu/DropdownMenu';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode } from '@/config/commerce';
import { getSocialHostUrl } from '@/config/social';
import { FileController } from '@/controllers/file/file';
import { useCollectionsNavDiscovery } from '@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile/useCurrentUserProfile';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset/useKeyboardOffset';
import { useMarketplaceCartCount } from '@/hooks/useMarketplaceCartCount/useMarketplaceCartCount';
import { useMarketplaceNavAttention } from '@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { usePublicRoute } from '@/hooks/usePublicRoute/usePublicRoute';
import { PubkyIcon } from '@/icons';
import { marketplaceNavAccessibleName } from '@/libs/commerce/marketplace-attention';
import { handleFeedNavClick } from '@/libs/utils/feedScrollTop';
import { cn } from '@/libs/utils/utils';
import { AvatarWithFallback } from '@/organisms/AvatarWithFallback/AvatarWithFallback';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useLocalFilesStore } from '@/stores/localFiles/localFiles.store';
import { useNotificationStore } from '@/stores/notification/notification.store';

export interface MobileFooterProps {
  className?: string;
}

type FooterNavItem = {
  href: string;
  activePrefix?: string;
  icon: typeof Store;
  label: string;
  isFeedRoute?: boolean;
};

/**
 * MobileFooter - Bottom navigation for mobile devices
 *
 * Hidden for unauthenticated users on public routes (single post, profile)
 * following pubky-app pattern.
 */
export function MobileFooter({ className }: MobileFooterProps) {
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((state) => Boolean(state.currentUserPubky));
  const setShowSignInDialog = useAuthStore((state) => state.setShowSignInDialog);
  const { isPublicExploreRoute } = usePublicRoute();
  const { userDetails, currentUserPubky } = useCurrentUserProfile();
  // Social unread plus marketplace unread — one badge for the whole surface.
  const unreadNotifications = useNotificationStore((state) => state.selectTotalUnread());
  // Honest device-local unread: conversations whose last received message
  // postdates the local read checkpoint.
  const unreadMessages = useMessagesUnread();
  const marketplaceCartCount = useMarketplaceCartCount();
  const marketplaceAttention = useMarketplaceNavAttention();
  const accountUnread = unreadNotifications + unreadMessages;
  const localAvatarUrl = useLocalFilesStore((state) => state.profile);
  const { isKeyboardVisible, keyboardOffset } = useKeyboardOffset();
  const { markCollectionsNavSeen } = useCollectionsNavDiscovery();

  // Get avatar URL and fallback initial - same logic as desktop header
  const avatarUrl =
    localAvatarUrl ??
    (currentUserPubky && userDetails?.image
      ? FileController.getAvatarUrl(currentUserPubky, userDetails.indexed_at)
      : undefined);
  const avatarName = userDetails?.name || 'U';
  const socialHostUrl = getSocialHostUrl('/');
  // Marketplace stays out of primary navigation until the commerce adapter is
  // explicitly configured; production defaults to 'unavailable' (ADR 0019).
  const marketplaceNavItems: FooterNavItem[] =
    getCommerceAdapterMode() !== 'unavailable'
      ? [
          {
            href: APP_ROUTES.MARKETPLACE,
            activePrefix: APP_ROUTES.MARKETPLACE,
            icon: Store,
            label: 'Marketplace',
          },
        ]
      : [];
  const socialNavItems: FooterNavItem[] = [
    {
      href: APP_ROUTES.HOME,
      icon: Home,
      label: 'Home',
      isFeedRoute: true,
    },
    {
      href: APP_ROUTES.SEARCH,
      icon: Search,
      label: 'Search',
      isFeedRoute: true,
    },
    {
      href: APP_ROUTES.HOT,
      icon: Flame,
      label: 'Hot',
    },
    ...marketplaceNavItems,
    {
      href: APP_ROUTES.COLLECTIONS,
      activePrefix: APP_ROUTES.COLLECTIONS,
      icon: Library,
      label: 'Collections',
    },
  ];
  // Social link-out keeps only the Shop's own surfaces; the social host gets one link after them.
  const navItems = socialHostUrl ? marketplaceNavItems : socialNavItems;
  const accountMenu = socialHostUrl
    ? {
        notifications: MARKETPLACE_ROUTES.NOTIFICATIONS,
        settings: MARKETPLACE_ROUTES.SETTINGS,
      }
    : {
        notifications: APP_ROUTES.PROFILE,
        settings: SETTINGS_ROUTES.ACCOUNT,
      };
  // Hide footer for guests only on non-explore routes. Core explore and dynamic public
  // routes (/home, /post/..., /profile/...) use the public explore footer.
  if (!isAuthenticated && !isPublicExploreRoute) {
    return null;
  }

  return (
    <Container
      overrideDefaults
      className={cn(
        'fixed bottom-0 z-40 w-full overflow-x-auto bg-gradient-to-t from-background via-background/95 to-transparent px-3 py-4 transition-transform duration-75 lg:hidden',
        className,
      )}
      style={
        isKeyboardVisible && keyboardOffset > 0
          ? {
              transform: `translateY(-${keyboardOffset}px)`,
            }
          : undefined
      }
    >
      <Container
        overrideDefaults
        className="mx-auto flex max-w-[380px] items-center justify-between sm:max-w-[600px] md:max-w-[720px]"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const itemIsActive = isNavItemActive(pathname, item);
          const isCollectionsItem = item.href === APP_ROUTES.COLLECTIONS;
          const itemBadgeCount = item.href === APP_ROUTES.MARKETPLACE ? marketplaceCartCount + marketplaceAttention : 0;
          const marketplaceLabel =
            item.href === APP_ROUTES.MARKETPLACE && marketplaceAttention > 0
              ? marketplaceNavAccessibleName(marketplaceCartCount, marketplaceAttention)
              : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-label={
                marketplaceLabel ??
                (itemBadgeCount > 0
                  ? `${item.label}, ${itemBadgeCount} ${itemBadgeCount === 1 ? 'item' : 'items'} in cart`
                  : item.label)
              }
              onClick={(event) => {
                if (isAuthenticated && isCollectionsItem) {
                  markCollectionsNavSeen();
                }
                if (!item.isFeedRoute) return;
                handleFeedNavClick(event, { isActive: itemIsActive, smoothScrollWhenActive: true });
              }}
              className={cn(
                'rounded-full p-3 transition-all',
                itemBadgeCount > 0 && 'relative inline-flex',
                itemIsActive ? 'bg-secondary' : 'border border-border bg-white/5 backdrop-blur-sm hover:bg-white/10',
              )}
            >
              <Icon className="h-6 w-6" />
              {itemBadgeCount > 0 && (
                <Badge
                  data-cy="mobile-marketplace-counter"
                  className="absolute -right-1 -bottom-1 h-5 w-5 rounded-full bg-brand shadow-sm"
                  variant="secondary"
                >
                  <Typography
                    className={cn('font-semibold text-primary-foreground', itemBadgeCount > 21 && 'text-xs')}
                    size="xs"
                  >
                    {itemBadgeCount > 21 ? '21+' : itemBadgeCount}
                  </Typography>
                </Badge>
              )}
            </Link>
          );
        })}
        {socialHostUrl ? (
          <a
            href={socialHostUrl}
            aria-label="Pubky"
            data-cy="footer-pubky-btn"
            className="rounded-full border border-border bg-white/5 p-3 backdrop-blur-sm transition-all hover:bg-white/10"
          >
            <PubkyIcon className="h-6 w-6" />
          </a>
        ) : null}
        {isAuthenticated ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                data-cy="footer-nav-profile-btn"
                variant="ghost"
                size="icon"
                aria-label="Account menu"
                className="relative size-12 shrink-0 rounded-full"
              >
                <AvatarWithFallback
                  avatarUrl={avatarUrl}
                  name={avatarName}
                  fallbackSeed={currentUserPubky || avatarName}
                  size="lg"
                  className="cursor-pointer"
                  alt={'Profile'}
                />
                {accountUnread > 0 && (
                  <Badge
                    data-testid="mobile-notification-counter"
                    data-cy="mobile-notification-counter"
                    className="absolute right-0 bottom-0 h-5 w-5 rounded-full bg-brand shadow-sm"
                    variant="secondary"
                  >
                    <Typography
                      className={cn('font-semibold text-primary-foreground', accountUnread > 21 && 'text-xs')}
                      size="xs"
                    >
                      {accountUnread > 21 ? '21+' : accountUnread}
                    </Typography>
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" sideOffset={12} className="w-72 p-2">
              {socialHostUrl ? null : (
                <DropdownMenuItem asChild>
                  <Link href={PROFILE_ROUTES.PROFILE_PAGE} className="min-h-12 gap-2 px-4 py-2 text-sm font-medium">
                    <UserRound className="size-5 shrink-0" aria-hidden="true" />
                    Profile
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link href={accountMenu.notifications} className="min-h-12 gap-2 px-4 py-2 text-sm font-medium">
                  <Bell className="size-5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Notifications</span>
                  {unreadNotifications > 0 && (
                    <span className="text-brand">{unreadNotifications > 21 ? '21+' : unreadNotifications}</span>
                  )}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={APP_ROUTES.MESSAGES} className="min-h-12 gap-2 px-4 py-2 text-sm font-medium">
                  <MessageCircle className="size-5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Messages</span>
                  {unreadMessages > 0 && (
                    <span className="text-brand">{unreadMessages > 21 ? '21+' : unreadMessages}</span>
                  )}
                </Link>
              </DropdownMenuItem>
              {socialHostUrl ? null : (
                <DropdownMenuItem asChild>
                  <Link href={PROFILE_ROUTES.POSTS} className="min-h-12 gap-2 px-4 py-2 text-sm font-medium">
                    <FileText className="size-5 shrink-0" aria-hidden="true" />
                    My posts
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link href={accountMenu.settings} className="min-h-12 gap-2 px-4 py-2 text-sm font-medium">
                  <Settings className="size-5 shrink-0" aria-hidden="true" />
                  Settings
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="secondary"
            size="icon"
            className="size-12 items-center justify-center border bg-white/5"
            aria-label="Join Pubky"
            onClick={() => setShowSignInDialog(true)}
          >
            <UserRoundPlus className="size-6" />
          </Button>
        )}
      </Container>
    </Container>
  );
}
