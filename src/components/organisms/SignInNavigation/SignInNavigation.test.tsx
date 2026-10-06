import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_GUARD_RETURN_TO_STORAGE_KEY } from '@/providers/RouteGuardProvider/RouteGuardProvider.returnPath';
import { SignInNavigation } from './SignInNavigation';

// Mock Next.js router
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Minimal atoms
vi.mock('@/atoms/Container/Container', () => {
  return {
    Container: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <div data-testid="container" data-class-name={className}>
        {children}
      </div>
    ),
  };
});

// Use real libs - use actual implementations

// Stub child dialogs so we can trigger onRestore
vi.mock('@/organisms/DialogRestoreEncryptedFile/DialogRestoreEncryptedFile', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/organisms/DialogRestoreEncryptedFile/DialogRestoreEncryptedFile')>();
  return {
    ...actual,
    DialogRestoreEncryptedFile: ({ onRestore }: { onRestore?: () => void }) => (
      <button data-testid="restore-file" onClick={onRestore}>
        Restore File
      </button>
    ),
  };
});

vi.mock('@/organisms/DialogRestoreRecoveryPhrase/DialogRestoreRecoveryPhrase', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/organisms/DialogRestoreRecoveryPhrase/DialogRestoreRecoveryPhrase')>();
  return {
    ...actual,
    DialogRestoreRecoveryPhrase: ({ onRestore }: { onRestore?: () => void }) => (
      <button data-testid="restore-phrase" onClick={onRestore}>
        Restore Phrase
      </button>
    ),
  };
});

let mockSignInState = { authUrlResolved: false };

vi.mock('@/stores/signIn/signIn.store', () => ({
  useSignInStore: vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockSignInState);
    }
    return mockSignInState;
  }),
}));

describe('SignInNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockSignInState = { authUrlResolved: false };
  });

  it('renders both restore dialogs', () => {
    render(<SignInNavigation />);

    expect(screen.getByTestId('restore-phrase')).toBeInTheDocument();
    expect(screen.getByTestId('restore-file')).toBeInTheDocument();
  });

  it('does not navigate or consume a stored return path on restore', () => {
    window.sessionStorage.setItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY, '/marketplace/orders');
    render(<SignInNavigation />);

    fireEvent.click(screen.getByTestId('restore-phrase'));
    fireEvent.click(screen.getByTestId('restore-file'));

    expect(mockPush).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBe('/marketplace/orders');
  });

  it('does not render when sign-in progress is active', () => {
    mockSignInState.authUrlResolved = true;

    render(<SignInNavigation />);

    expect(screen.queryByTestId('restore-phrase')).not.toBeInTheDocument();
    expect(screen.queryByTestId('restore-file')).not.toBeInTheDocument();
  });
});

describe('SignInNavigation - Snapshots', () => {
  beforeEach(() => {
    mockSignInState = { authUrlResolved: false };
  });

  it('matches snapshot', () => {
    const { container } = render(<SignInNavigation />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
