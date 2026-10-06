import { z } from 'zod';

export type SubdivisionOption = { code: string; name: string };

export type PostalCountryRule = {
  regionLabel: string;
  postalLabel: string;
  regionRequired: boolean;
  subdivisions: readonly SubdivisionOption[] | null;
  postalPattern: RegExp | null;
  postalExample: string | null;
};

const US_SUBDIVISIONS: readonly SubdivisionOption[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'GU', name: 'Guam' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
  { code: 'AA', name: 'Armed Forces Americas' },
  { code: 'AE', name: 'Armed Forces Europe' },
  { code: 'AP', name: 'Armed Forces Pacific' },
];

const CA_SUBDIVISIONS: readonly SubdivisionOption[] = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
];

const AU_SUBDIVISIONS: readonly SubdivisionOption[] = [
  { code: 'ACT', name: 'Australian Capital Territory' },
  { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' },
  { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' },
  { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' },
  { code: 'WA', name: 'Western Australia' },
];

const REQUIRED_FREE_TEXT_REGION = new Set([
  'AE',
  'AR',
  'BD',
  'BR',
  'CL',
  'CN',
  'CO',
  'EG',
  'ID',
  'IN',
  'KR',
  'MX',
  'MY',
  'NG',
  'PE',
  'PH',
  'PK',
  'SA',
  'TH',
  'TR',
  'VN',
  'ZA',
]);

const POSTAL_PATTERNS: Record<string, { pattern: RegExp; example: string; label?: string }> = {
  US: { pattern: /^\d{5}(?:-\d{4})?$/, example: '02740', label: 'ZIP code' },
  CA: { pattern: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ ]?\d[ABCEGHJ-NPRSTV-Z]\d$/i, example: 'K1A 0B1' },
  GB: { pattern: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, example: 'SW1A 1AA' },
  AU: { pattern: /^\d{4}$/, example: '2000' },
  DE: { pattern: /^\d{5}$/, example: '10115' },
  NL: { pattern: /^\d{4}\s?[A-Z]{2}$/i, example: '1012 AB' },
  FR: { pattern: /^\d{5}$/, example: '75001' },
  BE: { pattern: /^\d{4}$/, example: '1000' },
  AT: { pattern: /^\d{4}$/, example: '1010' },
  CH: { pattern: /^\d{4}$/, example: '8001' },
  ES: { pattern: /^\d{5}$/, example: '28001' },
  IT: { pattern: /^\d{5}$/, example: '00100' },
  PT: { pattern: /^\d{4}-?\d{3}$/, example: '1000-001' },
  IE: { pattern: /^[A-Z]\d{2}\s?[A-Z0-9]{4}$/i, example: 'D02 AF30' },
  BR: { pattern: /^\d{5}-?\d{3}$/, example: '01310-100' },
  IN: { pattern: /^\d{6}$/, example: '110001' },
  MX: { pattern: /^\d{5}$/, example: '06600' },
  JP: { pattern: /^\d{3}-?\d{4}$/, example: '100-0001' },
  NZ: { pattern: /^\d{4}$/, example: '6011' },
  SG: { pattern: /^\d{6}$/, example: '018956' },
  KR: { pattern: /^\d{5}$/, example: '03051' },
  CN: { pattern: /^\d{6}$/, example: '100000' },
  PL: { pattern: /^\d{2}-?\d{3}$/, example: '00-001' },
  SE: { pattern: /^\d{3}\s?\d{2}$/, example: '111 22' },
  NO: { pattern: /^\d{4}$/, example: '0150' },
  DK: { pattern: /^\d{4}$/, example: '1050' },
  FI: { pattern: /^\d{5}$/, example: '00100' },
};

const DEFAULT_RULE: PostalCountryRule = {
  regionLabel: 'Region',
  postalLabel: 'Postal code',
  regionRequired: false,
  subdivisions: null,
  postalPattern: null,
  postalExample: null,
};

export function normalizeCountryCode(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}

/** The country a new address starts with when the browser names no usable region. */
export const DEFAULT_ADDRESS_COUNTRY = 'US';

// ISO 3166-1 user-assigned codes and CLDR macro-regions: two letters, but no country.
const NON_COUNTRY_REGION = /^(AA|Q[M-Z]|X[A-Z]|ZZ|EU|EZ|UN)$/;

/**
 * The country a new address starts with: the region of the first locale
 * that names one (`en-GB` gives `GB`), or {@link DEFAULT_ADDRESS_COUNTRY}.
 * Numeric regions (`es-419`), non-country codes and malformed tags are skipped.
 */
export function addressCountryFromLocales(locales: readonly string[]): string {
  for (const tag of locales) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(tag).region;
    } catch {
      continue;
    }
    if (region && /^[A-Z]{2}$/.test(region) && !NON_COUNTRY_REGION.test(region)) return region;
  }
  return DEFAULT_ADDRESS_COUNTRY;
}

/** {@link addressCountryFromLocales} for this browser's preferred languages; the default outside a browser. */
export function browserAddressCountry(): string {
  if (typeof navigator === 'undefined') return DEFAULT_ADDRESS_COUNTRY;
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language];
  return addressCountryFromLocales(locales.filter((tag): tag is string => typeof tag === 'string'));
}

export function postalCountryRule(countryCode: string): PostalCountryRule {
  const country = normalizeCountryCode(countryCode);
  if (country === 'US') {
    return {
      regionLabel: 'State',
      postalLabel: 'ZIP code',
      regionRequired: true,
      subdivisions: US_SUBDIVISIONS,
      postalPattern: POSTAL_PATTERNS.US.pattern,
      postalExample: POSTAL_PATTERNS.US.example,
    };
  }
  if (country === 'CA') {
    return {
      regionLabel: 'Province',
      postalLabel: 'Postal code',
      regionRequired: true,
      subdivisions: CA_SUBDIVISIONS,
      postalPattern: POSTAL_PATTERNS.CA.pattern,
      postalExample: POSTAL_PATTERNS.CA.example,
    };
  }
  if (country === 'AU') {
    return {
      regionLabel: 'State',
      postalLabel: 'Postal code',
      regionRequired: true,
      subdivisions: AU_SUBDIVISIONS,
      postalPattern: POSTAL_PATTERNS.AU.pattern,
      postalExample: POSTAL_PATTERNS.AU.example,
    };
  }
  const postal = POSTAL_PATTERNS[country];
  if (country === 'JP') {
    return {
      regionLabel: 'Prefecture',
      postalLabel: 'Postal code',
      regionRequired: false,
      subdivisions: null,
      postalPattern: postal?.pattern ?? null,
      postalExample: postal?.example ?? null,
    };
  }
  if (REQUIRED_FREE_TEXT_REGION.has(country)) {
    return {
      regionLabel: country === 'MX' || country === 'BR' || country === 'IN' ? 'State' : 'Region',
      postalLabel: postal?.label ?? 'Postal code',
      regionRequired: true,
      subdivisions: null,
      postalPattern: postal?.pattern ?? null,
      postalExample: postal?.example ?? null,
    };
  }
  if (postal) {
    return {
      ...DEFAULT_RULE,
      postalLabel: postal.label ?? 'Postal code',
      postalPattern: postal.pattern,
      postalExample: postal.example,
    };
  }
  return DEFAULT_RULE;
}

export function regionLabelForCountry(countryCode: string): string {
  return postalCountryRule(countryCode).regionLabel;
}

export function postalLabelForCountry(countryCode: string): string {
  return postalCountryRule(countryCode).postalLabel;
}

export function isRegionRequired(countryCode: string): boolean {
  return postalCountryRule(countryCode).regionRequired;
}

export function subdivisionsForCountry(countryCode: string): readonly SubdivisionOption[] | null {
  return postalCountryRule(countryCode).subdivisions;
}

export function filterSubdivisions(countryCode: string, query: string): SubdivisionOption[] {
  const list = subdivisionsForCountry(countryCode);
  if (!list) return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [...list];
  return list.filter(
    (option) => option.code.toLowerCase().startsWith(needle) || option.name.toLowerCase().includes(needle),
  );
}

export function canonicalizeRegion(countryCode: string, region: string): string {
  const trimmed = region.trim();
  if (!trimmed) return '';
  const list = subdivisionsForCountry(countryCode);
  if (!list) return trimmed;
  const upper = trimmed.toUpperCase();
  const byCode = list.find((option) => option.code === upper);
  if (byCode) return byCode.code;
  const lower = trimmed.toLowerCase();
  const byName = list.find((option) => option.name.toLowerCase() === lower);
  return byName?.code ?? trimmed;
}

export function canonicalizePostalCode(countryCode: string, postalCode: string): string {
  const country = normalizeCountryCode(countryCode);
  const trimmed = postalCode.trim();
  if (country === 'CA') {
    const compact = trimmed.replace(/\s+/g, '').toUpperCase();
    if (compact.length === 6) return `${compact.slice(0, 3)} ${compact.slice(3)}`;
    return trimmed.toUpperCase();
  }
  if (country === 'NL' || country === 'GB') return trimmed.toUpperCase().replace(/\s+/g, ' ');
  if (country === 'US') return trimmed.replace(/\s+/g, '');
  return trimmed;
}

export function regionErrorMessage(countryCode: string, region: string): string | null {
  const rule = postalCountryRule(countryCode);
  const trimmed = region.trim();
  if (rule.regionRequired && !trimmed) return `${rule.regionLabel} is required.`;
  if (!trimmed) return null;
  if (
    rule.subdivisions &&
    !rule.subdivisions.some((option) => option.code === canonicalizeRegion(countryCode, trimmed))
  ) {
    return `Choose a valid ${rule.regionLabel.toLowerCase()}.`;
  }
  if (trimmed.length > 100) return `${rule.regionLabel} must be 100 characters or fewer.`;
  return null;
}

export function postalErrorMessage(countryCode: string, postalCode: string): string | null {
  const rule = postalCountryRule(countryCode);
  const trimmed = postalCode.trim();
  if (!trimmed) return `${rule.postalLabel} is required.`;
  if (trimmed.length > 32) return `${rule.postalLabel} must be 32 characters or fewer.`;
  if (rule.postalPattern && !rule.postalPattern.test(canonicalizePostalCode(countryCode, trimmed))) {
    return rule.postalExample
      ? `Use a valid ${rule.postalLabel} (e.g. ${rule.postalExample}).`
      : `Use a valid ${rule.postalLabel}.`;
  }
  return null;
}

export type PostalAddressFields = {
  region: string;
  postalCode: string;
  countryCode: string;
};

export function refinePostalAddressFields(
  data: PostalAddressFields,
  context: z.RefinementCtx,
  options: { regionPath?: Array<string | number>; postalPath?: Array<string | number> } = {},
): void {
  const regionPath = options.regionPath ?? ['region'];
  const postalPath = options.postalPath ?? ['postalCode'];
  const regionIssue = regionErrorMessage(data.countryCode, data.region);
  if (regionIssue) {
    context.addIssue({ code: 'custom', path: regionPath, message: regionIssue });
  }
  const postalIssue = postalErrorMessage(data.countryCode, data.postalCode);
  if (postalIssue) {
    context.addIssue({ code: 'custom', path: postalPath, message: postalIssue });
  }
}

export const commerceDeliveryAddressValueSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100),
    postalCode: z.string().trim().max(32),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((code) => code.toUpperCase()),
  })
  .strict()
  .superRefine((data, context) => refinePostalAddressFields(data, context))
  .transform((data) => ({
    ...data,
    region: canonicalizeRegion(data.countryCode, data.region),
    postalCode: canonicalizePostalCode(data.countryCode, data.postalCode),
  }));

export type CommerceDeliveryAddressValue = z.infer<typeof commerceDeliveryAddressValueSchema>;
