import { describe, expect, it } from 'vitest';
import {
  defaultMeasurementSystemForLocale,
  dimensionInputFromMillimeters,
  dimensionUnitLabel,
  formatDimension,
  formatPackageDimensions,
  formatWeight,
  gramsFromWeightInput,
  millimetersFromDimensionInput,
  weightInputFromGrams,
  weightUnitLabel,
} from './units';

describe('defaultMeasurementSystemForLocale', () => {
  it('defaults en-US to imperial', () => {
    expect(defaultMeasurementSystemForLocale('en-US')).toBe('imperial');
    expect(defaultMeasurementSystemForLocale('EN-us')).toBe('imperial');
  });

  it('defaults every other locale to metric', () => {
    expect(defaultMeasurementSystemForLocale('en-GB')).toBe('metric');
    expect(defaultMeasurementSystemForLocale('de-DE')).toBe('metric');
    expect(defaultMeasurementSystemForLocale('es-US')).toBe('metric');
    expect(defaultMeasurementSystemForLocale('en')).toBe('metric');
    expect(defaultMeasurementSystemForLocale(undefined)).toBe('metric');
    expect(defaultMeasurementSystemForLocale('')).toBe('metric');
  });
});

describe('dimension conversions', () => {
  it('converts exact inch inputs to exact millimeters (1 in = 25.4 mm)', () => {
    expect(millimetersFromDimensionInput(5, 'imperial')).toBe(127);
    expect(millimetersFromDimensionInput(1, 'imperial')).toBe(25);
    expect(millimetersFromDimensionInput(3.2, 'imperial')).toBe(81);
  });

  it('converts centimeter inputs to exact millimeters', () => {
    expect(millimetersFromDimensionInput(35, 'metric')).toBe(350);
    expect(millimetersFromDimensionInput(35.7, 'metric')).toBe(357);
  });

  it('round-trips a one-decimal input through the stored millimeters', () => {
    for (const value of [0.5, 3.2, 5.0, 13.8, 120.4]) {
      const storedMm = millimetersFromDimensionInput(value, 'imperial');
      expect(Number(dimensionInputFromMillimeters(storedMm, 'imperial'))).toBeCloseTo(value, 10);
    }
    for (const value of [0.5, 3.2, 35.0, 120.4]) {
      const storedMm = millimetersFromDimensionInput(value, 'metric');
      expect(Number(dimensionInputFromMillimeters(storedMm, 'metric'))).toBeCloseTo(value, 10);
    }
  });

  it('shows stored millimeters back with one decimal', () => {
    expect(dimensionInputFromMillimeters(350, 'metric')).toBe('35.0');
    expect(dimensionInputFromMillimeters(350, 'imperial')).toBe('13.8');
    expect(dimensionInputFromMillimeters(127, 'imperial')).toBe('5.0');
  });
});

describe('weight conversions', () => {
  it('converts ounce inputs to exact grams (1 oz = 28.349523125 g)', () => {
    expect(gramsFromWeightInput(1, 'imperial')).toBe(28);
    expect(gramsFromWeightInput(8.5, 'imperial')).toBe(241);
    expect(gramsFromWeightInput(16, 'imperial')).toBe(454);
  });

  it('keeps gram inputs as whole grams', () => {
    expect(gramsFromWeightInput(1200, 'metric')).toBe(1200);
    expect(gramsFromWeightInput(1200.4, 'metric')).toBe(1200);
  });

  it('round-trips a one-decimal ounce input through the stored grams', () => {
    for (const value of [0.5, 1.0, 8.5, 42.3]) {
      const storedGrams = gramsFromWeightInput(value, 'imperial');
      expect(Number(weightInputFromGrams(storedGrams, 'imperial'))).toBeCloseTo(value, 10);
    }
  });

  it('shows stored grams back in the input unit', () => {
    expect(weightInputFromGrams(1200, 'metric')).toBe('1200');
    expect(weightInputFromGrams(241, 'imperial')).toBe('8.5');
  });
});

describe('buyer-facing display', () => {
  it('labels units per system', () => {
    expect(dimensionUnitLabel('metric')).toBe('cm');
    expect(dimensionUnitLabel('imperial')).toBe('in');
    expect(weightUnitLabel('metric')).toBe('g');
    expect(weightUnitLabel('imperial')).toBe('oz');
  });

  it('formats dimensions with one decimal in the chosen unit', () => {
    expect(formatDimension(350, 'metric')).toBe('35.0 cm');
    expect(formatDimension(350, 'imperial')).toBe('13.8 in');
  });

  it('formats weight with a sensible unit step', () => {
    expect(formatWeight(850, 'metric')).toBe('850 g');
    expect(formatWeight(1200, 'metric')).toBe('1.2 kg');
    expect(formatWeight(241, 'imperial')).toBe('8.5 oz');
    expect(formatWeight(1200, 'imperial')).toBe('2.6 lb');
  });

  it('formats the package dimension line', () => {
    const pkg = { lengthMillimeters: 350, widthMillimeters: 250, heightMillimeters: 150 };
    expect(formatPackageDimensions(pkg, 'metric')).toBe('35.0 × 25.0 × 15.0 cm');
    expect(formatPackageDimensions(pkg, 'imperial')).toBe('13.8 × 9.8 × 5.9 in');
  });
});
