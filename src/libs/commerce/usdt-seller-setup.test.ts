import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sellerPaymentConfigOwnViewSchema } from '@/libs/commerce/payment-methods';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import {
  USDT_SELLER_CONFIG_FLAG_OFF_WIRE,
  USDT_SELLER_CONFIG_READY_WIRE,
  USDT_SELLER_CONFIG_RECONNECT_WIRE,
  USDT_SELLER_CONFIG_SETUP_WIRE,
  USDT_SELLER_CONFIG_UNAVAILABLE_WIRE,
} from '@/test/fixtures/commerce/seller-payment-config-usdt.wire';
import {
  deriveUsdtSellerReadiness,
  USDT_NEEDS_BITKIT_COPY,
  USDT_SETUP_ACTIONS,
  USDT_SETUP_STATUSES,
} from './usdt-seller-setup';

const envelope = z.object({ paymentConfig: sellerPaymentConfigOwnViewSchema });
const parseWire = (wire: unknown) => envelope.parse(toCamelCaseWire(wire)).paymentConfig;

describe('usdt-seller-setup wire contract', () => {
  it('pins the status and action vocabularies the service sends', () => {
    expect([...USDT_SETUP_STATUSES]).toEqual(['ready', 'setup_required', 'unavailable']);
    expect([...USDT_SETUP_ACTIONS]).toEqual(['setup', 'reconnect']);
  });

  it.each([
    { name: 'ready', wire: USDT_SELLER_CONFIG_READY_WIRE, expected: 'ready' },
    { name: 'reconnect', wire: USDT_SELLER_CONFIG_RECONNECT_WIRE, expected: 'reconnect' },
    { name: 'setup', wire: USDT_SELLER_CONFIG_SETUP_WIRE, expected: 'setup' },
    { name: 'unavailable', wire: USDT_SELLER_CONFIG_UNAVAILABLE_WIRE, expected: 'unavailable' },
  ] as const)('reads the $name fixture through the snake_case wire', ({ wire, expected }) => {
    const parsed = parseWire(wire);
    expect(deriveUsdtSellerReadiness(parsed)).toBe(expected);
    expect(parsed.usdtEnabled).toBe(wire.payment_config.usdt_enabled);
  });

  it('carries no USDT fields while the service flag is off', () => {
    const parsed = parseWire(USDT_SELLER_CONFIG_FLAG_OFF_WIRE);
    expect(parsed.usdtEnabled).toBeUndefined();
    expect(parsed.usdtSetup).toBeUndefined();
    expect(parsed.usdtSetupAction).toBeUndefined();
    expect(deriveUsdtSellerReadiness(parsed)).toBe('unavailable');
  });

  it('never exposes a USDT address through the own view', () => {
    const parsed = parseWire({
      payment_config: {
        ...USDT_SELLER_CONFIG_READY_WIRE.payment_config,
        usdt_address: '0x0000000000000000000000000000000000000001',
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('0x0000');
    expect(Object.keys(parsed)).not.toContain('usdtAddress');
  });

  it('drops an unrecognised status or action', () => {
    const parsed = parseWire({
      payment_config: {
        ...USDT_SELLER_CONFIG_READY_WIRE.payment_config,
        usdt_setup: 'maybe',
        usdt_setup_action: 'repair',
      },
    });
    expect(parsed.usdtSetup).toBeUndefined();
    expect(parsed.usdtSetupAction).toBeUndefined();
  });
});

describe('deriveUsdtSellerReadiness', () => {
  it.each([
    { usdtSetup: 'ready', usdtSetupAction: null, expected: 'ready' },
    { usdtSetup: 'ready', usdtSetupAction: 'reconnect', expected: 'ready' },
    { usdtSetup: 'ready', usdtSetupAction: undefined, expected: 'ready' },
    { usdtSetup: 'setup_required', usdtSetupAction: 'setup', expected: 'setup' },
    { usdtSetup: 'setup_required', usdtSetupAction: 'reconnect', expected: 'reconnect' },
    { usdtSetup: 'setup_required', usdtSetupAction: null, expected: 'unavailable' },
    { usdtSetup: 'setup_required', usdtSetupAction: undefined, expected: 'unavailable' },
    { usdtSetup: 'unavailable', usdtSetupAction: null, expected: 'unavailable' },
    { usdtSetup: 'unavailable', usdtSetupAction: 'setup', expected: 'unavailable' },
    { usdtSetup: 'unavailable', usdtSetupAction: 'reconnect', expected: 'unavailable' },
    { usdtSetup: undefined, usdtSetupAction: 'reconnect', expected: 'unavailable' },
    { usdtSetup: undefined, usdtSetupAction: undefined, expected: 'unavailable' },
  ] as const)('status=$usdtSetup action=$usdtSetupAction is $expected', ({ expected, ...input }) => {
    expect(deriveUsdtSellerReadiness(input)).toBe(expected);
  });

  it('keeps the fixed Ring copy', () => {
    expect(USDT_NEEDS_BITKIT_COPY).toBe("USDT needs Bitkit. Pubky Ring can't share a USDT address.");
  });
});
