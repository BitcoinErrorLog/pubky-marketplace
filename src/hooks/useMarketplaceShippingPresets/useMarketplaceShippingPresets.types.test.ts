import { describe, expect, it } from 'vitest';
import type { CommerceShippingPresetModelSchema } from '@/models/commerce/commerce.schema';
import { presetToShippingFields, shippingFieldsToPresetInput } from './useMarketplaceShippingPresets.types';

const OWNER = 's'.repeat(52);

function createPreset(overrides: Partial<CommerceShippingPresetModelSchema> = {}): CommerceShippingPresetModelSchema {
  return {
    id: `${OWNER}:preset01`,
    owner_id: OWNER,
    label: 'Standard shipping',
    price_minor: 1_250,
    currency: 'USD',
    estimated_min_days: 2,
    estimated_max_days: 5,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('presetToShippingFields', () => {
  it('fills the sell studio fields exactly as the form expects them', () => {
    expect(presetToShippingFields(createPreset())).toEqual({
      shippingLabel: 'Standard shipping',
      shippingPrice: '12.50',
      shippingMinDays: '2',
      shippingMaxDays: '5',
    });
  });

  it('round-trips through the save conversion without drift', () => {
    const preset = createPreset({ price_minor: 999, estimated_min_days: 0, estimated_max_days: 365 });
    const input = shippingFieldsToPresetInput(presetToShippingFields(preset));
    expect(input).toEqual({
      label: 'Standard shipping',
      priceMinor: 999,
      currency: 'USD',
      estimatedMinDays: 0,
      estimatedMaxDays: 365,
    });
  });
});

describe('shippingFieldsToPresetInput', () => {
  const valid = {
    shippingLabel: 'Tracked 48',
    shippingPrice: '4.99',
    shippingMinDays: '1',
    shippingMaxDays: '2',
  };

  it('converts valid sell studio fields', () => {
    expect(shippingFieldsToPresetInput(valid)).toEqual({
      label: 'Tracked 48',
      priceMinor: 499,
      currency: 'USD',
      estimatedMinDays: 1,
      estimatedMaxDays: 2,
    });
  });

  it('trims the label', () => {
    expect(shippingFieldsToPresetInput({ ...valid, shippingLabel: '  Tracked 48  ' })?.label).toBe('Tracked 48');
  });

  it('rejects incomplete or invalid fields instead of saving a broken preset', () => {
    expect(shippingFieldsToPresetInput({ ...valid, shippingLabel: '' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingLabel: 'x'.repeat(101) })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingPrice: '' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingPrice: '0' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingPrice: '1.999' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingPrice: 'abc' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingMinDays: '' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingMinDays: '-1' })).toBeNull();
    expect(shippingFieldsToPresetInput({ ...valid, shippingMaxDays: '366' })).toBeNull();
    // Max before min is the one cross-field rule.
    expect(shippingFieldsToPresetInput({ ...valid, shippingMinDays: '5', shippingMaxDays: '2' })).toBeNull();
  });
});
