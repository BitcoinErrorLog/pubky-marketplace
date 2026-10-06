'use client';

import * as React from 'react';
import { Container } from '@/atoms/Container/Container';
import { isSocialLinkOutEnabled } from '@/config/social';
import { FileController } from '@/controllers/file/file';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile/useCurrentUserProfile';
import { SearchInput } from '@/organisms/SearchInput/SearchInput';
import { useNotificationStore } from '@/stores/notification/notification.store';
import { HeaderNavigationButtons } from '../Header/Header';

export const HeaderSignIn = ({ ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const { userDetails, currentUserPubky } = useCurrentUserProfile();
  // Social unread plus marketplace unread — one badge for the whole surface.
  const unreadNotifications = useNotificationStore((state) => state.selectTotalUnread());

  return (
    <Container className="min-w-0 flex-1 flex-row items-center justify-end gap-3" {...props}>
      {/* Social search (posts, people, tags) lives on the social host once link-out is on. */}
      {!isSocialLinkOutEnabled() && <SearchInput />}
      <HeaderNavigationButtons
        avatarImage={
          currentUserPubky && userDetails?.image
            ? FileController.getAvatarUrl(currentUserPubky, userDetails.indexed_at)
            : undefined
        }
        avatarName={userDetails?.name}
        avatarSeed={currentUserPubky || userDetails?.name || 'user'}
        counter={unreadNotifications}
      />
    </Container>
  );
};
