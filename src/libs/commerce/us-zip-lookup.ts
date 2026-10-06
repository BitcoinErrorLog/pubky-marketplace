import usZip5 from './data/us-zip5.json';
import { zip3ToState } from './us-zip-prefixes';

/**
 * US ZIP5 → city + state, packed from GeoNames US postal codes
 * (https://download.geonames.org/export/zip/US.zip, CC-BY 4.0).
 * Parsed once on first lookup. Street never leaves the device.
 */
type UsZip5File = { cities: string[]; packed: string };

export type UsZipFill = { city: string; region: string };

const RECORD_LENGTH = 10;
let cityStateByZip: Map<string, UsZipFill> | null = null;

function zip5Table(): Map<string, UsZipFill> {
  if (cityStateByZip) return cityStateByZip;
  const file = usZip5 as UsZip5File;
  const map = new Map<string, UsZipFill>();
  const { cities, packed } = file;
  for (let i = 0; i + RECORD_LENGTH <= packed.length; i += RECORD_LENGTH) {
    const zip = packed.slice(i, i + 5);
    const city = cities[Number.parseInt(packed.slice(i + 5, i + 8), 36)] ?? '';
    const region = packed.slice(i + 8, i + 10);
    if (zip && (city || region)) map.set(zip, { city, region });
  }
  cityStateByZip = map;
  return map;
}

export function lookupUsZip(postalCode: string): UsZipFill | null {
  const digits = postalCode.replace(/\D/g, '');
  if (digits.length < 5) return null;
  const zip5 = digits.slice(0, 5);
  const exact = zip5Table().get(zip5);
  if (exact) return exact;
  const region = zip3ToState(zip5.slice(0, 3));
  return region ? { city: '', region } : null;
}
