import {
  verifyDropEditionAttestation,
  verifyOrderReceiptAttestation,
  verifyPurchaseAttestation,
} from 'pubky-app-specs';
import { z } from 'zod';
import type { CommerceReviewRecord } from '@/libs/commerce/marketplace-records';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';

/**
 * The purchase attestation as `review.create` / `review.update` return it
 * (ADR 0024): a compact JWS (EdDSA, `typ: pubky-purchase-attestation+v1`)
 * plus its decoded claims. The claims arrive camelCased by the wire-casing
 * boundary; the JWS string itself is the canonical artifact and is embedded
 * verbatim in the published review record's `eligibilityAttestation`.
 *
 * The `amountBand` claim is present only under both-sides consent (ratified
 * D2): the seller's standing preference AND the reviewer's per-review
 * opt-in.
 */
export const marketplaceAttestationSchema = z
  .object({
    jws: z
      .string()
      .min(32)
      .max(4_096)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    claims: z
      .object({
        v: z.literal(1),
        iss: z.string().length(52),
        sub: z.string().length(52),
        cpk: z.string().length(52),
        role: z.enum(['buyer_reviewing_seller', 'seller_reviewing_buyer']),
        listing: z.string().min(1),
        orderRef: z.string().regex(/^[0-9a-f]{64}$/),
        completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amountBand: z
          .string()
          .regex(/^[A-Z][A-Z0-9]{2,11}:\d{1,2}$/)
          .optional(),
        iat: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type MarketplaceAttestation = z.infer<typeof marketplaceAttestationSchema>;

/**
 * Extracts the attestation from a successful review command result, or null
 * when the deployment issues none (a service without an attestor key still
 * accepts reviews — the absence is honest, not an error).
 */
export function extractReviewAttestation(result: Record<string, unknown>): MarketplaceAttestation | null {
  if (!('attestation' in result)) return null;
  const parsed = marketplaceAttestationSchema.safeParse(result.attestation);
  return parsed.success ? parsed.data : null;
}

/**
 * The receipt attestation as `GET /v1/receipts/{id}/attestation` returns it:
 * a compact JWS (EdDSA, `typ: pubky-order-receipt+v1` or `+v2`) plus its decoded
 * claims, camelCased by the wire-casing boundary. Unlike the public
 * purchase attestation, the `order` claim is the raw order UUID — the
 * receipt document lives under the owner's `/priv/` tree, so there is no
 * observer to redact from. Issuance is deterministic per receipt.
 */
const receiptAttestationJwsSchema = z
  .string()
  .min(32)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const receiptAttestationPartyClaims = {
  iss: z.string().length(52),
  buyer: z.string().length(52),
  seller: z.string().length(52),
  order: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  receipt: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  paidAt: z.string().min(1),
  iat: z.number().int().positive(),
};

const receiptMoneyObjectSchema = z
  .object({
    amountMinor: z.number().int().min(0),
    currency: z.string().min(1),
    exponent: z.number().int().min(0),
  })
  .strict();

const marketplaceReceiptAttestationClaimsSchema = z.discriminatedUnion('v', [
  z
    .object({
      ...receiptAttestationPartyClaims,
      v: z.literal(1),
      totalMinor: z.number().int().positive(),
      currency: z.string().min(1),
      exponent: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ...receiptAttestationPartyClaims,
      v: z.literal(2),
      settlementTotal: receiptMoneyObjectSchema,
      merchandiseTotal: receiptMoneyObjectSchema,
    })
    .strict(),
]);

export const marketplaceReceiptAttestationSchema = z
  .object({
    jws: receiptAttestationJwsSchema,
    claims: marketplaceReceiptAttestationClaimsSchema,
  })
  .strict();

export type MarketplaceReceiptAttestationClaims = z.infer<typeof marketplaceReceiptAttestationClaimsSchema>;
export type MarketplaceReceiptAttestation = z.infer<typeof marketplaceReceiptAttestationSchema>;

/**
 * The drop-edition attestation as `GET /v1/receipts/{id}/edition-attestation`
 * returns it (ADR 0026): a compact JWS (`typ: pubky-drop-edition+v1`)
 * proving "edition N of M of drop D" for a paid drop order. Deterministic
 * per receipt; embedded in the portable receipt document alongside (never
 * inside) the receipt attestation so existing receipt verifiers are
 * untouched.
 */
export const marketplaceEditionAttestationSchema = z
  .object({
    jws: z
      .string()
      .min(32)
      .max(4_096)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    claims: z
      .object({
        v: z.literal(1),
        iss: z.string().length(52),
        buyer: z.string().length(52),
        seller: z.string().length(52),
        drop: z.string().min(1),
        edition: z.number().int().min(1),
        of: z.number().int().min(1),
        receipt: z.uuid(),
        iat: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type MarketplaceEditionAttestation = z.infer<typeof marketplaceEditionAttestationSchema>;

/**
 * Offline verification of a portable receipt's embedded drop-edition
 * attestation via the specs crate: parse, Ed25519 against the
 * self-certifying `iss`, and full claim/record binding (requires the
 * record's `editionAttestation` AND `drop` object together). Returns the
 * verified issuer pubky or null; `iss` trust stays display policy.
 */
export function verifyOwnDropEdition(record: Record<string, unknown>): string | null {
  try {
    const claims = verifyDropEditionAttestation({ ...record }) as { iss?: unknown };
    return typeof claims.iss === 'string' ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * Runs the offline verification recipe on a portable order-receipt record's
 * embedded attestation via the specs crate (the normative implementation):
 * parse, verify the Ed25519 signature against the self-certifying `iss`
 * pubky, and check every claim binding against the record. Returns the
 * verified issuer pubky, or null when anything fails. Whether `iss` is a
 * *trusted* attestor remains display policy — same doctrine as reviews.
 */
export function verifyOwnOrderReceipt(record: Record<string, unknown>): string | null {
  try {
    const claims = verifyOrderReceiptAttestation({ ...record }) as { iss?: unknown };
    return typeof claims.iss === 'string' ? claims.iss : null;
  } catch {
    return null;
  }
}

export function verifyOrderReceiptClaims(record: Record<string, unknown>): MarketplaceReceiptAttestationClaims | null {
  try {
    return toCamelCaseWire(verifyOrderReceiptAttestation({ ...record })) as MarketplaceReceiptAttestationClaims;
  } catch {
    return null;
  }
}

/**
 * Runs the offline verification recipe on a review record's embedded
 * attestation via the specs crate (the normative implementation): parse the
 * compact JWS, verify the Ed25519 signature against the self-certifying
 * `iss` pubky, and check the claim bindings against the record. Returns the
 * verified issuer pubky, or null when anything fails. This proves the
 * attestation covers the record — whether `iss` is a *trusted* attestor
 * remains display policy.
 */
export function verifyOwnReviewAttestation(record: CommerceReviewRecord): string | null {
  try {
    const claims = verifyPurchaseAttestation({ ...record }) as { iss?: unknown };
    return typeof claims.iss === 'string' ? claims.iss : null;
  } catch {
    return null;
  }
}
