import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setEmbedded } from '@/test-utils/embedded';
import { useIsEmbedded } from './useIsEmbedded';

const runtime = vi.hoisted(() => ({ embedded: false }));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getEmbeddedFlag: () => runtime.embedded, getFrameAncestors: () => [] };
});

function Probe() {
  return <span data-testid="probe">{String(useIsEmbedded())}</span>;
}

describe('useIsEmbedded', () => {
  afterEach(() => {
    runtime.embedded = false;
    setEmbedded(false);
  });

  it('is false for a top-level page', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });

  it('is true when the URL carries embedded=1', () => {
    setEmbedded(true);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('is true when the deployer forces embedded mode', () => {
    runtime.embedded = true;
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('renders the deployer flag on the server, which cannot see frames', () => {
    runtime.embedded = true;
    expect(renderToString(<Probe />)).toContain('true');
    runtime.embedded = false;
    expect(renderToString(<Probe />)).toContain('false');
  });
});
