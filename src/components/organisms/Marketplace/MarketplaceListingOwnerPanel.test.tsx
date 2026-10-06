import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceListingRegistrationStatus } from '@/models/commerce/commerce.schema';
import { useAuthStore } from '@/stores/auth/auth.store';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { MarketplaceListingOwnerPanel } from './MarketplaceListingOwnerPanel';

const controller = vi.hoisted(() => ({
  ensureListingRegistered: vi.fn(async () => false),
  canRegisterListings: vi.fn(() => true),
  commitDeleteListing: vi.fn(async () => {}),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: controller,
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (state: { marketplaceSession: object }) => unknown) =>
    selector({ marketplaceSession: {} }),
}));

describe('MarketplaceListingOwnerPanel registration self-heal', () => {
  beforeEach(() => {
    controller.ensureListingRegistered.mockClear();
    controller.canRegisterListings.mockReturnValue(true);
  });

  it.each([undefined, 'unregistered'] as const)('retries a pending registration (%s) with a session', (status) => {
    const record = createCommerceListingFixture();
    render(<MarketplaceListingOwnerPanel record={record} registrationStatus={status} />);

    expect(controller.ensureListingRegistered).toHaveBeenCalledWith(record);
    expect(screen.getByRole('button', { name: 'Register for checkout' })).toBeInTheDocument();
    expect(screen.queryByTestId('listing-registration-unsupported')).not.toBeInTheDocument();
  });

  it.each(['not_found', 'registered', 'unavailable'] as CommerceListingRegistrationStatus[])(
    'neither retries nor offers registration for %s',
    (status) => {
      render(<MarketplaceListingOwnerPanel record={createCommerceListingFixture()} registrationStatus={status} />);

      expect(controller.ensureListingRegistered).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Register for checkout' })).not.toBeInTheDocument();
    },
  );

  it('shows static copy instead of the button, and never retries, in a browser without Web Locks', () => {
    controller.canRegisterListings.mockReturnValue(false);
    render(<MarketplaceListingOwnerPanel record={createCommerceListingFixture()} registrationStatus="unregistered" />);

    expect(controller.ensureListingRegistered).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Register for checkout' })).not.toBeInTheDocument();
    expect(screen.getByTestId('listing-registration-unsupported')).toHaveTextContent(
      "This browser can't register listings for checkout. Update it or use another browser.",
    );
  });
});

describe('MarketplaceListingOwnerPanel delete before the homeserver session is restored', () => {
  beforeEach(() => {
    controller.commitDeleteListing.mockClear();
    useAuthStore.setState({ session: null });
  });

  it('disables Delete, and says why, until the session is restored', () => {
    render(<MarketplaceListingOwnerPanel record={createCommerceListingFixture()} registrationStatus="registered" />);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByTestId('listing-delete-waiting-for-session')).toHaveTextContent(
      'Delete is available once your session is restored.',
    );
  });

  it('enables Delete the moment the session is restored, and deletes the listing', async () => {
    const user = userEvent.setup();
    const record = createCommerceListingFixture();
    render(<MarketplaceListingOwnerPanel record={record} registrationStatus="registered" />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

    useAuthStore.setState({ session: {} as never });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
    expect(screen.queryByTestId('listing-delete-waiting-for-session')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete listing' }));

    await waitFor(() =>
      expect(controller.commitDeleteListing).toHaveBeenCalledWith(record.ownerPubky, record.listingId),
    );
  });

  it('does not delete when the session is lost while the confirmation is open', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ session: {} as never });
    render(<MarketplaceListingOwnerPanel record={createCommerceListingFixture()} registrationStatus="registered" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('button', { name: 'Delete listing' });

    useAuthStore.setState({ session: null });

    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(controller.commitDeleteListing).not.toHaveBeenCalled();
  });
});
