/**
 * Measurement-system conversions for package dimensions and weight.
 *
 * The stored record is ALWAYS canonical metric — integer millimeters and
 * integer grams (`commercePackageSchema`). Everything here converts between
 * that canonical form and what a user enters or reads in their preferred
 * system: centimeters/grams (metric) or inches/ounces-pounds (imperial).
 * Conversions use the exact legal definitions (1 in = 25.4 mm,
 * 1 oz = 28.349523125 g, 1 lb = 453.59237 g); display rounds to one decimal.
 */

export type MeasurementSystem = 'metric' | 'imperial';

export const MM_PER_CM = 10;
export const MM_PER_INCH = 25.4;
export const GRAMS_PER_OUNCE = 28.349523125;
export const GRAMS_PER_POUND = 453.59237;
export const GRAMS_PER_KILOGRAM = 1_000;

/**
 * Locale default: `en-US` gets imperial, every other locale gets metric.
 * The preference store overrides this once the user makes a choice.
 */
export function defaultMeasurementSystemForLocale(locale: string | undefined): MeasurementSystem {
  return locale?.trim().toLowerCase() === 'en-us' ? 'imperial' : 'metric';
}

/** Dimension entered in the chosen unit (cm or in) → exact integer millimeters. */
export function millimetersFromDimensionInput(value: number, system: MeasurementSystem): number {
  return system === 'imperial' ? Math.round(value * MM_PER_INCH) : Math.round(value * MM_PER_CM);
}

/** Canonical millimeters → input string in the chosen unit, one decimal. */
export function dimensionInputFromMillimeters(millimeters: number, system: MeasurementSystem): string {
  return system === 'imperial' ? (millimeters / MM_PER_INCH).toFixed(1) : (millimeters / MM_PER_CM).toFixed(1);
}

/** Weight entered in the chosen unit (g or oz) → exact integer grams. */
export function gramsFromWeightInput(value: number, system: MeasurementSystem): number {
  return system === 'imperial' ? Math.round(value * GRAMS_PER_OUNCE) : Math.round(value);
}

/** Canonical grams → input string in the chosen unit (whole grams, or ounces to one decimal). */
export function weightInputFromGrams(grams: number, system: MeasurementSystem): string {
  return system === 'imperial' ? (grams / GRAMS_PER_OUNCE).toFixed(1) : String(grams);
}

export function dimensionUnitLabel(system: MeasurementSystem): string {
  return system === 'imperial' ? 'in' : 'cm';
}

export function weightUnitLabel(system: MeasurementSystem): string {
  return system === 'imperial' ? 'oz' : 'g';
}

/** Buyer-facing dimension, e.g. `35.0 cm` / `13.8 in`. */
export function formatDimension(millimeters: number, system: MeasurementSystem): string {
  return `${dimensionInputFromMillimeters(millimeters, system)} ${dimensionUnitLabel(system)}`;
}

/**
 * Buyer-facing weight with a sensible unit step: grams under a kilogram and
 * kilograms above (metric); ounces under a pound and pounds above (imperial).
 */
export function formatWeight(grams: number, system: MeasurementSystem): string {
  if (system === 'imperial') {
    return grams < GRAMS_PER_POUND
      ? `${(grams / GRAMS_PER_OUNCE).toFixed(1)} oz`
      : `${(grams / GRAMS_PER_POUND).toFixed(1)} lb`;
  }
  return grams < GRAMS_PER_KILOGRAM ? `${grams} g` : `${(grams / GRAMS_PER_KILOGRAM).toFixed(1)} kg`;
}

/** Buyer-facing `L × W × H` line in the chosen unit, e.g. `35.0 × 25.0 × 15.0 cm`. */
export function formatPackageDimensions(
  pkg: { lengthMillimeters: number; widthMillimeters: number; heightMillimeters: number },
  system: MeasurementSystem,
): string {
  const parts = [pkg.lengthMillimeters, pkg.widthMillimeters, pkg.heightMillimeters].map((mm) =>
    dimensionInputFromMillimeters(mm, system),
  );
  return `${parts.join(' × ')} ${dimensionUnitLabel(system)}`;
}
