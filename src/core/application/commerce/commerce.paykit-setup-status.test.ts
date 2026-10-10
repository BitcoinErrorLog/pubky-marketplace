import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { LocksGatewayService } from '@/services/locks/locks';
import { LocksFrontendSessionStore } from '@/services/locks/locks-frontend-session';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplacePaykitClaimService } from '@/services/marketplace/marketplace-paykit-claim';
import { CommerceApplication } from './commerce';

const SELLER = 's'.repeat(52);
const SESSION = { token: 'session-token', creator: `pubky${SELLER}`, pubky: SELLER };

describe('CommerceApplication.isPaykitAccountClaimed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the fork Paykit server by default', async () => {
    const forkLookup = vi.spyOn(MarketplacePaykitClaimService, 'isAccountClaimed').mockResolvedValue(true);
    const setupStatus = vi.spyOn(LocksGatewayService, 'getCreatorPaykitSetupStatus');

    await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).resolves.toBe(true);
    expect(forkLookup).toHaveBeenCalledWith(SELLER);
    expect(setupStatus).not.toHaveBeenCalled();
  });

  describe('upstream Paykit Server: the Lock Server setup status decides', () => {
    const sellerConfig = (bitcoinAvailable: boolean) => ({
      bitcoinAvailable,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });

    beforeEach(() => {
      vi.spyOn(commerceConfig, 'getPaykitServerApi').mockReturnValue('upstream');
      vi.spyOn(MarketplacePaykitClaimService, 'isAccountClaimed').mockRejectedValue(new Error('fork route called'));
      vi.spyOn(MarketplaceGatewayService, 'getSellerPaymentConfig').mockResolvedValue(sellerConfig(false));
    });

    it('takes the service bitcoinAvailable first, with no Locks session needed', async () => {
      vi.mocked(MarketplaceGatewayService.getSellerPaymentConfig).mockResolvedValue(sellerConfig(true));
      const restore = vi.spyOn(LocksFrontendSessionStore, 'restore');

      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).resolves.toBe(true);
      expect(MarketplaceGatewayService.getSellerPaymentConfig).toHaveBeenCalledWith(SELLER);
      expect(restore).not.toHaveBeenCalled();
    });

    it('falls back to the Lock Server when the service config cannot be read', async () => {
      vi.mocked(MarketplaceGatewayService.getSellerPaymentConfig).mockRejectedValue(new Error('down'));
      vi.spyOn(LocksFrontendSessionStore, 'restore').mockReturnValue(SESSION);
      vi.spyOn(LocksGatewayService, 'getCreatorPaykitSetupStatus').mockResolvedValue('ready');

      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).resolves.toBe(true);
    });

    it('reports ready as set up and setup_required as not, with the seller session', async () => {
      const restore = vi.spyOn(LocksFrontendSessionStore, 'restore').mockReturnValue(SESSION);
      const setupStatus = vi
        .spyOn(LocksGatewayService, 'getCreatorPaykitSetupStatus')
        .mockResolvedValueOnce('ready')
        .mockResolvedValueOnce('setup_required');

      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).resolves.toBe(true);
      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).resolves.toBe(false);
      expect(restore).toHaveBeenCalledWith(SELLER);
      expect(setupStatus).toHaveBeenCalledWith('session-token');
    });

    it('rejects when the Lock Server cannot reach Paykit', async () => {
      vi.spyOn(LocksFrontendSessionStore, 'restore').mockReturnValue(SESSION);
      vi.spyOn(LocksGatewayService, 'getCreatorPaykitSetupStatus').mockResolvedValue('unavailable');

      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    });

    it('rejects without a Locks session instead of reporting a state', async () => {
      vi.spyOn(LocksFrontendSessionStore, 'restore').mockReturnValue(null);
      const setupStatus = vi.spyOn(LocksGatewayService, 'getCreatorPaykitSetupStatus');

      await expect(CommerceApplication.isPaykitAccountClaimed(SELLER)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(setupStatus).not.toHaveBeenCalled();
    });
  });
});
