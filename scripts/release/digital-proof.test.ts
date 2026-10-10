// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIGITAL_DELIVERY_KIND_OPTIONS } from '@/hooks/useDigitalDeliveryEditor/useDigitalDeliveryEditor.types';
import {
  digitalCheckoutLineLabel,
  digitalDeliveryCurrentSummary,
  formatDigitalFileSize,
} from '@/libs/commerce/digital';
import {
  BITCOIN_WINDOW_MINUTES,
  DELIVERABLES_PREFIX,
  describePlan,
  DIGITAL_KINDS,
  expectedCheckoutLine,
  expectedCurrentSummary,
  formatSizeLabel,
  goToken,
  hasGoAhead,
  isInstantKind,
  KIND_RADIO_LABEL,
  listingTitle,
  makeFixtureFile,
  minPriceCents,
  newDeliverablePaths,
  parseKinds,
  parsePayTimeoutMinutes,
  parsePriceUsd,
  pathFromPubkyUrl,
  payOutcome,
  priceClearsMinimum,
  redactEmail,
  sha256Hex,
} from './digital-proof.mjs';

describe('digital proof copy stays in step with the Shop', () => {
  it('uses the editor radio labels', () => {
    expect(DIGITAL_KINDS).toEqual(DIGITAL_DELIVERY_KIND_OPTIONS.map((option) => option.kind));
    for (const option of DIGITAL_DELIVERY_KIND_OPTIONS) expect(KIND_RADIO_LABEL[option.kind]).toBe(option.label);
  });

  it('expects the summary line the editor shows after a save', () => {
    const size = 65536;
    expect(expectedCurrentSummary('file', 'proof.bin', formatSizeLabel(size))).toBe(
      digitalDeliveryCurrentSummary({ kind: 'file', fileName: 'proof.bin', sizeBytes: size } as never),
    );
    for (const kind of ['link', 'text', 'email', 'message'] as const) {
      expect(expectedCurrentSummary(kind, '', '')).toBe(digitalDeliveryCurrentSummary({ kind } as never));
    }
  });

  it('formats sizes like the Shop', () => {
    for (const size of [1024, 65536, 1_048_576, 5_000_000, 52_428_800]) {
      expect(formatSizeLabel(size)).toBe(formatDigitalFileSize(size));
    }
  });

  it('expects the checkout line the Shop renders per kind', () => {
    for (const kind of DIGITAL_KINDS) {
      expect(digitalCheckoutLineLabel(kind as never)).toMatch(
        new RegExp(`^Digital delivery · ${expectedCheckoutLine(kind).source.replace(/^\^/, '')}`),
      );
    }
  });
});

describe('kinds', () => {
  it('parses a list, defaults to file, and rejects unknown or repeated kinds', () => {
    expect(parseKinds(undefined)).toEqual(['file']);
    expect(parseKinds('file, text,email')).toEqual(['file', 'text', 'email']);
    expect(() => parseKinds('')).toThrow(/names no delivery kind/);
    expect(() => parseKinds('file,zip')).toThrow(/unknown delivery kind "zip"/);
    expect(() => parseKinds('file,file')).toThrow(/repeats/);
  });

  it('separates instant kinds from manual ones', () => {
    expect(DIGITAL_KINDS.filter(isInstantKind)).toEqual(['file', 'link', 'text']);
  });
});

describe('go-ahead', () => {
  it('accepts only today\u2019s UTC token', () => {
    const now = new Date('2026-10-14T23:59:59Z');
    expect(goToken(now)).toBe('GO-2026-10-14');
    expect(hasGoAhead({ PROOF_DIGITAL_GO: 'GO-2026-10-14' }, now)).toBe(true);
    expect(hasGoAhead({ PROOF_DIGITAL_GO: 'GO-2026-10-13' }, now)).toBe(false);
    expect(hasGoAhead({ PROOF_DIGITAL_GO: '1' }, now)).toBe(false);
    expect(hasGoAhead({}, now)).toBe(false);
  });
});

describe('price', () => {
  it('accepts two-decimal dollars between 1.00 and 25.00', () => {
    expect(parsePriceUsd(undefined)).toEqual({ text: '2.00', cents: 200 });
    expect(parsePriceUsd('25.00').cents).toBe(2500);
    for (const bad of ['2', '2.5', '0.50', '25.01', '-1.00', 'abc', '1,00']) expect(() => parsePriceUsd(bad)).toThrow();
  });

  it('clears the 1,000-sat floor with a margin', () => {
    expect(minPriceCents(100_000)).toBe(200);
    expect(priceClearsMinimum(200, 100_000)).toBe(true);
    expect(priceClearsMinimum(199, 100_000)).toBe(false);
    expect(priceClearsMinimum(200, 120_000)).toBe(false);
    expect(() => minPriceCents(0)).toThrow();
    expect(() => minPriceCents(Number.NaN)).toThrow();
  });
});

describe('pay wait', () => {
  it('stays inside the Bitcoin hold window', () => {
    expect(parsePayTimeoutMinutes(undefined)).toBe(25);
    expect(parsePayTimeoutMinutes('2')).toBe(2);
    expect(parsePayTimeoutMinutes(String(BITCOIN_WINDOW_MINUTES - 3))).toBe(BITCOIN_WINDOW_MINUTES - 3);
    for (const bad of ['1', '28', '30', '2.5', 'x']) expect(() => parsePayTimeoutMinutes(bad)).toThrow();
  });

  it('decides the outcome from payment first, then the clock', () => {
    expect(payOutcome({ paid: true, elapsedMs: 99, timeoutMs: 10 })).toBe('paid');
    expect(payOutcome({ paid: false, elapsedMs: 5, timeoutMs: 10 })).toBe('waiting');
    expect(payOutcome({ paid: false, elapsedMs: 10, timeoutMs: 10 })).toBe('timeout');
  });
});

describe('fixture file', () => {
  it('is distinct per run, carries its own hash and cannot be tiny', () => {
    const a = makeFixtureFile('aaaaaa');
    const b = makeFixtureFile('aaaaaa');
    expect(a.name).toBe('digital-proof-aaaaaa.bin');
    expect(a.bytes.length).toBe(64 * 1024);
    expect(a.sha256).toBe(sha256Hex(a.bytes));
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.bytes.subarray(0, 40).toString('utf8')).toContain('digital delivery proof aaaaaa');
    expect(() => makeFixtureFile('x', 10)).toThrow();
  });

  it('hashes known input', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('teardown scope', () => {
  const seller = 'pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';

  it('extracts the absolute path from a pubky url', () => {
    expect(pathFromPubkyUrl(`${seller}${DELIVERABLES_PREFIX}abc/1`)).toBe(`${DELIVERABLES_PREFIX}abc/1`);
    expect(pathFromPubkyUrl('https://example.com/x')).toBeNull();
  });

  it('deletes only deliverables that appeared during the run', () => {
    const before = [`${DELIVERABLES_PREFIX}old/1`];
    const after = [`${DELIVERABLES_PREFIX}old/1`, `${DELIVERABLES_PREFIX}new/1`, '/pub/pubky.app/profile.json'];
    expect(newDeliverablePaths(before, after)).toEqual([`${DELIVERABLES_PREFIX}new/1`]);
    expect(newDeliverablePaths(after, after)).toEqual([]);
  });
});

describe('redaction and titles', () => {
  it('removes the tester mailbox from any text', () => {
    expect(redactEmail('sent to tester@example.com now', 'tester@example.com')).toBe('sent to [redacted-email] now');
    expect(redactEmail('plain', '')).toBe('plain');
    expect(redactEmail(undefined, 'a@b.c')).toBe('');
  });

  it('titles every fixture as a do-not-buy listing', () => {
    expect(listingTitle('ab12cd', 'file')).toBe('TEST, do not buy ab12cd file');
  });
});

describe('plan', () => {
  it('names every kind and the teardown, and says orders remain', () => {
    const lines = describePlan({
      kinds: ['file', 'email'],
      priceText: '2.00',
      origin: 'https://shop.pubky.app',
      service: 'https://service.example',
    });
    expect(lines.some((line) => line.startsWith('file:') && line.includes('SHA-256 matches'))).toBe(true);
    expect(lines.some((line) => line.startsWith('email:') && line.includes('Emailed to'))).toBe(true);
    expect(lines.at(-1)).toContain('paid orders remain as evidence');
  });
});
