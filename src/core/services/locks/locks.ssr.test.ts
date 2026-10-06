import { describe, expect, it, vi } from 'vitest';

// Evaluating a mocked module runs its factory, so this spy fires if and only if
// something actually imports 'locks-sdk-wasm'. Importing the whole Locks call chain
// (service -> application -> controller -> hook -> component) mirrors what Next.js
// evaluates when it server-renders a page containing MarketplacePaymentStatusCard:
// module scope only. The WASM SDK must never load there — only when a Locks operation runs.
const sdkModuleEvaluated = vi.hoisted(() => vi.fn());

vi.mock('locks-sdk-wasm', () => {
  sdkModuleEvaluated();
  return {
    default: vi.fn().mockResolvedValue(undefined),
    BundleId: { generate: () => ({ toString: () => '000G40R40M30E209185GR38E1W' }) },
  };
});

describe('Locks SDK server-render isolation', () => {
  it('keeps the WASM module out of the module graph of every Locks consumer', async () => {
    await import('./locks');
    await import('@/application/commerce/commerce');
    await import('@/controllers/commerce/commerce');
    await import('@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect');
    await import('@/organisms/Marketplace/MarketplacePaymentStatusCard');

    expect(sdkModuleEvaluated).not.toHaveBeenCalled();
  });

  it('loads the WASM module only when a Locks operation actually runs', async () => {
    const { LocksGatewayService } = await import('./locks');

    expect(sdkModuleEvaluated).not.toHaveBeenCalled();
    await LocksGatewayService.generateBundleId();
    expect(sdkModuleEvaluated).toHaveBeenCalledTimes(1);
  });
});
