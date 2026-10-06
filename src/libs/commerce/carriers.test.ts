import { describe, expect, it } from 'vitest';
import {
  buildCarrierTrackingUrl,
  getCarrierById,
  isLinkableTrackingNumber,
  OTHER_CARRIER_ID,
  resolveCarrierByName,
  SHIPPING_CARRIERS,
} from './carriers';

const TRACKING = 'AB 123-456_789';
const ENCODED = encodeURIComponent(TRACKING);

/** Expected template output per carrier id, asserted exhaustively below. */
const EXPECTED_URLS: Record<string, string> = {
  usps: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${ENCODED}`,
  ups: `https://www.ups.com/track?tracknum=${ENCODED}`,
  fedex: `https://www.fedex.com/fedextrack/?trknbr=${ENCODED}`,
  dhl: `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${ENCODED}`,
  'royal-mail': `https://www.royalmail.com/track-your-item#/tracking-results/${ENCODED}`,
  dpd: `https://tracking.dpd.de/status/en_US/parcel/${ENCODED}`,
  evri: `https://www.evri.com/track/parcel/${ENCODED}`,
  postnl: `https://jouw.postnl.nl/track-and-trace/${ENCODED}`,
  correos: `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${ENCODED}`,
  'la-poste': `https://www.laposte.fr/outils/suivre-vos-envois?code=${ENCODED}`,
  'an-post': `https://www.anpost.com/Post-Parcels/Track/History?item=${ENCODED}`,
  'deutsche-post': `https://www.deutschepost.de/de/s/sendungsverfolgung.html?piececode=${ENCODED}`,
};

describe('shipping carrier registry', () => {
  it('covers the full curated list plus Other', () => {
    expect(SHIPPING_CARRIERS.map(({ id }) => id)).toEqual([...Object.keys(EXPECTED_URLS), OTHER_CARRIER_ID]);
  });

  // One case per carrier so a template regression names the exact carrier.
  for (const carrier of SHIPPING_CARRIERS) {
    if (carrier.id === OTHER_CARRIER_ID) continue;
    it(`templates a public tracking URL for ${carrier.name}`, () => {
      expect(buildCarrierTrackingUrl(carrier.name, TRACKING)).toBe(EXPECTED_URLS[carrier.id]);
    });
  }

  it('resolves carriers case-insensitively and via aliases', () => {
    expect(resolveCarrierByName('usps')?.id).toBe('usps');
    expect(resolveCarrierByName('  FEDEX ')?.id).toBe('fedex');
    expect(resolveCarrierByName('Federal Express')?.id).toBe('fedex');
    expect(resolveCarrierByName('Hermes')?.id).toBe('evri');
    expect(resolveCarrierByName('Hermes/Evri')?.id).toBe('evri');
    expect(resolveCarrierByName('Colissimo')?.id).toBe('la-poste');
    expect(resolveCarrierByName('United States Postal Service')?.id).toBe('usps');
  });

  it('never resolves unknown carriers, the empty string, or the literal "Other"', () => {
    expect(resolveCarrierByName('Local Courier')).toBeNull();
    expect(resolveCarrierByName('')).toBeNull();
    expect(resolveCarrierByName('   ')).toBeNull();
    // A free-text carrier that happens to say "Other" has no tracking page.
    expect(resolveCarrierByName('Other')).toBeNull();
  });

  it('renders no link for unknown carriers (plain text fallback)', () => {
    expect(buildCarrierTrackingUrl('Local Courier', 'LC-4417-8890')).toBeNull();
    expect(buildCarrierTrackingUrl('Sandbox Post', 'TRACK-123')).toBeNull();
  });

  it('renders no link for unlinkable tracking numbers even with a known carrier', () => {
    expect(buildCarrierTrackingUrl('USPS', '')).toBeNull();
    expect(buildCarrierTrackingUrl('USPS', '   ')).toBeNull();
    expect(buildCarrierTrackingUrl('USPS', 'ab')).toBeNull();
    expect(buildCarrierTrackingUrl('USPS', 'call me maybe?!')).toBeNull();
  });

  it('accepts realistic tracking references', () => {
    expect(isLinkableTrackingNumber('9400111899223197428490')).toBe(true);
    expect(isLinkableTrackingNumber('1Z999AA10123456784')).toBe(true);
    expect(isLinkableTrackingNumber('RN123456785GB')).toBe(true);
    expect(isLinkableTrackingNumber('LC-4417-8890')).toBe(true);
    expect(isLinkableTrackingNumber(' 1Z999AA10123456784 ')).toBe(true);
  });

  it('exposes Other without a tracking template', () => {
    expect(getCarrierById(OTHER_CARRIER_ID)?.trackingUrl).toBeNull();
    expect(getCarrierById('nope')).toBeNull();
  });
});
