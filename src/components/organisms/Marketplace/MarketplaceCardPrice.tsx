'use client';

import { useIndicativeBtcRate } from '@/hooks/useIndicativeBtcRate/useIndicativeBtcRate';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { indicativeCounterpartLabel } from '@/libs/commerce/pricing';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

export function MarketplaceCardPrice({ money }: { money: CommerceMoney }) {
  const currency = useMarketplaceDisplayStore((state) => state.displayCurrency);
  const convert = money.currency !== currency && (money.currency === 'USD' || money.currency === 'BTC');
  const rate = useIndicativeBtcRate(convert);
  const converted = rate && convert ? indicativeCounterpartLabel(money, rate.btcUsd) : null;

  return (
    <span
      title={
        converted
          ? `Indicative conversion · Listed at ${formatCommerceMoney(money)}`
          : convert
            ? 'Conversion unavailable — showing listed currency'
            : undefined
      }
    >
      {converted ?? formatCommerceMoney(money)}
    </span>
  );
}
