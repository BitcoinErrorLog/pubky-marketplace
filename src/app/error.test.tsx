import { Pulse } from '@synonymdev/pubky-pulse-web';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import ErrorPage from './error';

describe('app/error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
  });

  it('renders error message and retry button', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('Boom')} reset={reset} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('calls reset when retry is clicked', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('Boom')} reset={reset} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('logs the boundary error once', () => {
    const reset = vi.fn();
    const error = new Error('Boom');
    render(<ErrorPage error={error} reset={reset} />);

    expect(Logger.error).toHaveBeenCalledWith('[app/error] Route segment render error', error);
  });

  it('sends a non-AppError to Pulse, which stays a no-op until consent starts the SDK', () => {
    const capture = vi.spyOn(Pulse, 'captureException');
    const error = new Error('Boom');
    render(<ErrorPage error={error} reset={vi.fn()} />);

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
    render(<ErrorPage error={error} reset={vi.fn()} />);

    expect(capture).not.toHaveBeenCalled();
  });
});
