import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceSessionRequiredCard, SALES_LIST_SESSION_NOTE } from './MarketplaceSessionRequiredCard';

const view = vi.hoisted(() => ({
  isGrantSession: false,
  grantSigner: 'bitkit' as 'bitkit' | 'passport',
  grantEnabled: false,
  passportEnabled: true,
}));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => (view.isGrantSession ? view.grantSigner : null),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getMarketplaceGrantFlowEnabled: () => view.grantEnabled,
  getPassportSignInEnabled: () => view.passportEnabled,
}));

vi.mock('./MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel: string }) => <button>{triggerLabel}</button>,
}));

describe('MarketplaceSessionRequiredCard', () => {
  beforeEach(() => {
    view.isGrantSession = false;
    view.grantSigner = 'bitkit';
    view.grantEnabled = false;
    view.passportEnabled = true;
  });

  it('names Pubky Ring for a Ring sign-in', () => {
    render(<MarketplaceSessionRequiredCard />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
  });

  it('names Bitkit for a Bitkit sign-in that can bootstrap', () => {
    view.isGrantSession = true;
    view.grantEnabled = true;
    render(<MarketplaceSessionRequiredCard />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
  });

  it('names Pubky Passport for a Passport sign-in that can bootstrap', () => {
    view.isGrantSession = true;
    view.grantSigner = 'passport';
    view.grantEnabled = true;
    render(<MarketplaceSessionRequiredCard />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
  });

  it('keeps Pubky Ring copy for a Passport sign-in while Passport is switched off', () => {
    view.isGrantSession = true;
    view.grantSigner = 'passport';
    view.grantEnabled = true;
    view.passportEnabled = false;
    render(<MarketplaceSessionRequiredCard />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(screen.queryByText(/Pubky Passport/)).not.toBeInTheDocument();
  });

  it('explains that sales use the same approval', () => {
    render(<MarketplaceSessionRequiredCard note={SALES_LIST_SESSION_NOTE} />);

    expect(screen.getByText(SALES_LIST_SESSION_NOTE)).toBeInTheDocument();
  });

  it('keeps Pubky Ring copy for a Bitkit sign-in when the grant flow is off', () => {
    view.isGrantSession = true;
    render(<MarketplaceSessionRequiredCard />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
  });
});
