import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentLabel } from './EnvironmentLabel';

const state = vi.hoisted(() => ({ path: '/marketplace', env: 'staging', mode: 'transaction-service' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.path }));
vi.mock('@/libs/runtime-config/runtime-config', () => ({
  getDeployEnv: () => state.env,
  getCommerceAdapterMode: () => state.mode,
}));

describe('EnvironmentLabel', () => {
  beforeEach(() => {
    Object.assign(state, { path: '/marketplace', env: 'staging', mode: 'transaction-service' });
  });

  it.each([
    ['staging', 'transaction-service', 'STAGING'],
    ['staging', 'sandbox', 'STAGING · SANDBOX'],
    ['staging', 'unavailable', 'STAGING · READ ONLY'],
    ['production', 'sandbox', 'SANDBOX'],
    ['production', 'unavailable', 'READ ONLY'],
  ])('labels %s with %s', (env, mode, label) => {
    Object.assign(state, { env, mode });
    render(<EnvironmentLabel />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('leaves production without an environment label', () => {
    state.env = 'production';
    const { container } = render(<EnvironmentLabel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not apply marketplace adapter labels to social pages', () => {
    Object.assign(state, { path: '/home', mode: 'sandbox' });
    render(<EnvironmentLabel />);
    expect(screen.getByText('STAGING')).toBeInTheDocument();
    expect(screen.queryByText(/SANDBOX/)).not.toBeInTheDocument();
  });
});
