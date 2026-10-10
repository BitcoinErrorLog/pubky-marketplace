import { Pulse } from '@synonymdev/pubky-pulse-web';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import GlobalErrorPage from './global-error';

describe('app/global-error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders global error fallback', () => {
    const reset = vi.fn();
    render(<GlobalErrorPage error={new Error('Root crash')} reset={reset} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Root crash')).toBeInTheDocument();
  });

  it('calls reset when retry is clicked', () => {
    const reset = vi.fn();
    render(<GlobalErrorPage error={new Error('Root crash')} reset={reset} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('sends a non-AppError to Pulse, which stays a no-op until consent starts the SDK', () => {
    const capture = vi.spyOn(Pulse, 'captureException');
    const error = new Error('Boom');
    render(<GlobalErrorPage error={error} reset={vi.fn()} />);

    expect(capture).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('leaves an AppError to the factory capture so Pulse never receives it twice', () => {
    const capture = vi.spyOn(Pulse, 'captureException');
    const error = new AppError({
      category: ErrorCategory.Server,
      code: ServerErrorCode.INTERNAL_ERROR,
      message: 'Read failed',
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
    });
    render(<GlobalErrorPage error={error} reset={vi.fn()} />);

    expect(capture).not.toHaveBeenCalled();
  });
});
