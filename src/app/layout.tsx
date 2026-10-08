import './globals.css';
import type { Viewport } from 'next';
import { TooltipProvider } from '@/atoms/Tooltip/Tooltip';
import { TOOLTIP_DELAY_MS } from '@/config/ui';
import { buildMarketplacePromoPrepaintScript } from '@/libs/commerce/promo-prepaint';
import { renderPerRequestOutsideVercel } from '@/libs/runtime-config/render-mode';
import { RootContainer } from '@/molecules/ContainerRoot/ContainerRoot';
import { Fab } from '@/molecules/Fab/Fab';
import { Metadata } from '@/molecules/Metadata/Metadata';
import { StructuredData } from '@/molecules/StructuredData/StructuredData';
import { Toaster } from '@/molecules/Toaster/Toaster';
import { CoordinatorsManager } from '@/organisms/CoordinatorsManager/CoordinatorsManager';
import { DialogSessionHandoff } from '@/organisms/DialogSessionHandoff/DialogSessionHandoff';
import { DialogSignIn } from '@/organisms/DialogSignIn/DialogSignIn';
import { Header } from '@/organisms/Header/Header';
import { PulseConsentBanner } from '@/organisms/PulseConsent/PulseConsent';
import { DatabaseProvider } from '@/providers/DatabaseProvider/DatabaseProvider';
import { ErrorBoundaryProvider } from '@/providers/ErrorBoundaryProvider/ErrorBoundaryProvider';
import { GlobalErrorHandlerProvider } from '@/providers/GlobalErrorHandlerProvider/GlobalErrorHandlerProvider';
import { RouteGuardProvider } from '@/providers/RouteGuardProvider/RouteGuardProvider';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#000000',
};

export function generateMetadata() {
  return Metadata({
    title: 'Pubky App - Unlock the web',
    description:
      'Pubky App is a social-media-like experience built over Pubky Core. It serves as a working example on how to build over Pubky Core to create simple or complex applications.',
  });
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await renderPerRequestOutsideVercel();

  return (
    <RootContainer>
      {/* Raw inline script: it must run during parsing, before the promo's first paint. */}
      <script
        id="marketplace-promo-prepaint-check"
        dangerouslySetInnerHTML={{ __html: buildMarketplacePromoPrepaintScript() }}
      />
      {/*
        Rendered as a sibling of the DatabaseProvider/RouteGuardProvider tree below (not a
        descendant): those are client components that gate {children} behind IndexedDB/auth
        readiness, so anything inside them is missing from the initial server-rendered HTML.
      */}
      <StructuredData />
      <PulseConsentBanner />
      <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
        <GlobalErrorHandlerProvider>
          <ErrorBoundaryProvider>
            <DatabaseProvider>
              <RouteGuardProvider>
                <CoordinatorsManager />
                <Header />
                {children}
                <Fab />
                <Toaster />
                <DialogSignIn />
              </RouteGuardProvider>
              {/* Outside RouteGuardProvider: it waits on the restore this dialog answers. */}
              <DialogSessionHandoff />
            </DatabaseProvider>
          </ErrorBoundaryProvider>
        </GlobalErrorHandlerProvider>
      </TooltipProvider>
    </RootContainer>
  );
}
