import { z } from 'zod';
import type { CommerceMoney } from './transaction-contracts';

/**
 * Asset-aware price input and indicative conversion helpers.
 *
 * Listings carry structured money `{amountMinor, currency, exponent}`. This
 * module owns two concerns that must stay honest:
 *
 * 1. INPUT — turning what a user types into exact minor units for the asset
 *    they are transacting in (dollars-and-cents for USD, whole bitcoin base
 *    units for BTC at exponent 8). No conversion ever happens here: a bitcoin
 *    input IS the minor unit, a USD input is multiplied by 10^2, nothing else.
 *
 * 2. INDICATIVE DISPLAY — an approximate counterpart price ("≈ ₿N" for
 *    fiat, "≈ $X" for bitcoin) computed from a fetched BTC/USD rate. It is
 *    display-only: nothing transactional consumes it, and callers must
 *    render it ONLY when a live rate exists (`null` means "show nothing").
 *    The rate-at-payment question is deliberately NOT answered here — see
 *    docs/ecommerce/pricing.md.
 */

export const BASE_UNITS_PER_BITCOIN = 100_000_000;

/** 21 million bitcoin in base units — the honest upper bound for any ₿ amount. */
export const MAX_BITCOIN_BASE_UNITS = 2_100_000_000_000_000;

export type CommerceAsset = Pick<CommerceMoney, 'currency' | 'exponent'>;

export const USD_ASSET: CommerceAsset = { currency: 'USD', exponent: 2 };

/** Bitcoin priced in integer base units (exponent 8) — the convention this app writes and pays. */
export const BTC_ASSET: CommerceAsset = { currency: 'BTC', exponent: 8 };

export function isBitcoinAsset(asset: CommerceAsset): boolean {
  return asset.currency === BTC_ASSET.currency && asset.exponent === BTC_ASSET.exponent;
}

/**
 * The pricing currencies the sell studio deliberately offers: US dollars
 * (cents as minor units) or bitcoin entered as whole base units (BTC at
 * exponent 8 — the exact shape the live regtest purchase paid). The record
 * schema itself accepts any uppercase asset code; this choice is what the
 * studio can author and the display layer can honestly estimate against.
 */
export type ListingCurrencyChoice = 'USD' | 'BTC';

export function assetForListingCurrency(choice: ListingCurrencyChoice): CommerceAsset {
  return choice === 'BTC' ? BTC_ASSET : USD_ASSET;
}

/** The studio choice a stored asset maps back to, or `null` for assets the studio cannot author. */
export function listingCurrencyChoiceForAsset(asset: CommerceAsset): ListingCurrencyChoice | null {
  if (hasSameAsset(asset, USD_ASSET)) return 'USD';
  if (isBitcoinAsset(asset)) return 'BTC';
  return null;
}

export function hasSameAsset(left: CommerceAsset, right: CommerceAsset): boolean {
  return left.currency === right.currency && left.exponent === right.exponent;
}

/** The amount in major units (dollars for USD/2, bitcoin for BTC/8). */
export function moneyMajorValue(money: CommerceMoney): number {
  return money.amountMinor / 10 ** money.exponent;
}

/** BIP-177 display: the bitcoin symbol followed by grouped integer base units, e.g. `₿15,000`. */
export function formatBitcoinAmount(baseUnits: number): string {
  return `₿${Math.round(baseUnits).toLocaleString('en-US')}`;
}

/** The unit a price input for this asset is denominated in, for labels like `Price (₿)`. */
export function amountInputUnitLabel(asset: CommerceAsset): string {
  return isBitcoinAsset(asset) ? '₿' : asset.currency;
}

/**
 * Validation for a price typed in the asset's input unit: whole bitcoin base
 * units for BTC/8, otherwise a decimal with at most `exponent` fraction digits.
 */
export function amountInputSchemaForAsset(asset: CommerceAsset): z.ZodType<string> {
  if (isBitcoinAsset(asset)) {
    return z
      .string()
      .trim()
      .regex(/^[1-9]\d*$/, 'Enter a whole number of bitcoin base units (₿).')
      .refine((value) => Number(value) <= MAX_BITCOIN_BASE_UNITS, 'That is more bitcoin than will ever exist.');
  }
  const decimals = asset.exponent;
  const pattern = decimals > 0 ? new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  const message =
    decimals > 0
      ? `Enter a valid ${asset.currency} amount with at most ${decimals} decimal places.`
      : `Enter a whole ${asset.currency} amount.`;
  return z
    .string()
    .trim()
    .regex(pattern, message)
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero.');
}

/** A validated input string → exact minor units in the given asset. */
export function amountInputToMoney(value: string, asset: CommerceAsset): CommerceMoney {
  const amountMinor = isBitcoinAsset(asset)
    ? Math.round(Number(value))
    : Math.round(Number(value) * 10 ** asset.exponent);
  return { amountMinor, currency: asset.currency, exponent: asset.exponent };
}

/** Minor units → the input string a form should show for this asset. */
export function amountInputFromMoney(money: CommerceMoney): string {
  return isBitcoinAsset(money)
    ? String(money.amountMinor)
    : (money.amountMinor / 10 ** money.exponent).toFixed(money.exponent);
}

const USD_DISPLAY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The approximate counterpart display for a price, at the given BTC/USD rate:
 * USD-priced money → `≈ ₿N`, BTC-priced money → `≈ $X`. Returns `null`
 * whenever no honest estimate exists — no positive rate, an asset with no
 * rate source (anything that is neither USD nor BTC), or an estimate that
 * rounds to zero in the counterpart unit.
 */
export function indicativeCounterpartLabel(money: CommerceMoney, btcUsdRate: number): string | null {
  if (!Number.isFinite(btcUsdRate) || btcUsdRate <= 0) return null;
  const major = moneyMajorValue(money);
  if (money.currency === 'USD') {
    const baseUnits = Math.round((major / btcUsdRate) * BASE_UNITS_PER_BITCOIN);
    return baseUnits > 0 ? `≈ ${formatBitcoinAmount(baseUnits)}` : null;
  }
  if (money.currency === 'BTC') {
    const usd = major * btcUsdRate;
    return usd >= 0.005 ? `≈ ${USD_DISPLAY.format(usd)}` : null;
  }
  return null;
}

/**
 * Sums line prices grouped by exact asset (currency + exponent). Minor units
 * of different assets are never added together — a cart holding a $30 item
 * and a ₿25,000 item has two subtotals, not one false number.
 */
export function sumMoneyByAsset(lines: Array<{ money: CommerceMoney; quantity: number }>): CommerceMoney[] {
  const totals = new Map<string, CommerceMoney>();
  for (const { money, quantity } of lines) {
    const key = `${money.currency}:${money.exponent}`;
    const existing = totals.get(key);
    if (existing) {
      existing.amountMinor += money.amountMinor * quantity;
    } else {
      totals.set(key, {
        amountMinor: money.amountMinor * quantity,
        currency: money.currency,
        exponent: money.exponent,
      });
    }
  }
  return [...totals.values()];
}
