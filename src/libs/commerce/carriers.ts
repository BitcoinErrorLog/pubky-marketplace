/**
 * Curated shipping carrier registry for structured tracking.
 *
 * The transaction service's `fulfillment.ship` command already stores a
 * structured `carrier` string (trimmed, 1–100 chars) next to
 * `tracking_number`, and both come back in the participant-visible shipment
 * projection — so the client writes the carrier's canonical display name
 * into that existing field and resolves it back on read. No wire contract
 * change is involved.
 *
 * Resolution is deliberately forgiving (case-insensitive, known aliases) but
 * NEVER guesses: an unrecognized carrier renders as plain text with no
 * tracking link, because a dead or wrong link is worse than none.
 */

export interface ShippingCarrier {
  id: string;
  /** Canonical display name — exactly what gets written into the ship command's `carrier` field. */
  name: string;
  /** Public tracking page for one tracking number, or null when the carrier has no template (Other). */
  trackingUrl: ((trackingNumber: string) => string) | null;
  /** Lowercased historical/common spellings that resolve to this carrier on read. */
  aliases: readonly string[];
}

export const SHIPPING_CARRIERS: readonly ShippingCarrier[] = [
  {
    id: 'usps',
    name: 'USPS',
    trackingUrl: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
    aliases: ['usps', 'united states postal service', 'us postal service'],
  },
  {
    id: 'ups',
    name: 'UPS',
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
    aliases: ['ups', 'united parcel service'],
  },
  {
    id: 'fedex',
    name: 'FedEx',
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
    aliases: ['fedex', 'fed ex', 'federal express'],
  },
  {
    id: 'dhl',
    name: 'DHL',
    trackingUrl: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
    aliases: ['dhl', 'dhl express'],
  },
  {
    id: 'royal-mail',
    name: 'Royal Mail',
    trackingUrl: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`,
    aliases: ['royal mail', 'royalmail'],
  },
  {
    id: 'dpd',
    name: 'DPD',
    trackingUrl: (n) => `https://tracking.dpd.de/status/en_US/parcel/${encodeURIComponent(n)}`,
    aliases: ['dpd', 'dpd group'],
  },
  {
    id: 'evri',
    name: 'Evri',
    trackingUrl: (n) => `https://www.evri.com/track/parcel/${encodeURIComponent(n)}`,
    aliases: ['evri', 'hermes', 'myhermes', 'hermes/evri'],
  },
  {
    id: 'postnl',
    name: 'PostNL',
    trackingUrl: (n) => `https://jouw.postnl.nl/track-and-trace/${encodeURIComponent(n)}`,
    aliases: ['postnl', 'post nl'],
  },
  {
    id: 'correos',
    name: 'Correos',
    trackingUrl: (n) =>
      `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(n)}`,
    aliases: ['correos', 'correos espana', 'correos españa'],
  },
  {
    id: 'la-poste',
    name: 'La Poste',
    trackingUrl: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(n)}`,
    aliases: ['la poste', 'laposte', 'colissimo'],
  },
  {
    id: 'an-post',
    name: 'An Post',
    trackingUrl: (n) => `https://www.anpost.com/Post-Parcels/Track/History?item=${encodeURIComponent(n)}`,
    aliases: ['an post', 'anpost'],
  },
  {
    id: 'deutsche-post',
    name: 'Deutsche Post',
    trackingUrl: (n) => `https://www.deutschepost.de/de/s/sendungsverfolgung.html?piececode=${encodeURIComponent(n)}`,
    aliases: ['deutsche post', 'deutschepost'],
  },
  {
    id: 'other',
    name: 'Other',
    trackingUrl: null,
    aliases: [],
  },
] as const;

export const OTHER_CARRIER_ID = 'other';

export function getCarrierById(id: string): ShippingCarrier | null {
  return SHIPPING_CARRIERS.find((carrier) => carrier.id === id) ?? null;
}

/**
 * Resolves a stored carrier string (this client's canonical names, or a
 * known alias someone typed by hand) back to a curated carrier. `Other` is
 * not resolvable by name on purpose: a shipment whose carrier was recorded
 * as free text renders as that text, not as "Other".
 */
export function resolveCarrierByName(name: string): ShippingCarrier | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return (
    SHIPPING_CARRIERS.find(
      (carrier) =>
        carrier.id !== OTHER_CARRIER_ID && (carrier.name.toLowerCase() === needle || carrier.aliases.includes(needle)),
    ) ?? null
  );
}

/**
 * Tracking numbers are participant-entered free text (service limit: 1–100
 * chars). Only link ones that look like a real reference — a templated URL
 * around whitespace or punctuation soup would be a dead link.
 */
export function isLinkableTrackingNumber(trackingNumber: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{3,99}$/.test(trackingNumber.trim());
}

/**
 * The buyer-side entry point: the carrier's public tracking URL for this
 * shipment, or null when either the carrier is unknown to the registry or
 * the tracking number is not linkable. Callers render plain text on null.
 */
export function buildCarrierTrackingUrl(carrierName: string, trackingNumber: string): string | null {
  const carrier = resolveCarrierByName(carrierName);
  if (!carrier?.trackingUrl) return null;
  if (!isLinkableTrackingNumber(trackingNumber)) return null;
  return carrier.trackingUrl(trackingNumber.trim());
}
