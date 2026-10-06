import { describe, expect, it } from 'vitest';
import {
  PLAUSIBLE_QUERYLESS_PAGE_BOOTSTRAP,
  plausiblePageUrlFromHref,
  rewritePlausibleEventBody,
} from './plausible-page-url';

const SELLER = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const BUYER = 'o'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = `conversation:${SELLER}_${BUYER}_${LISTING_ID}`;
const HREF = `https://shop.pubky.app/marketplace/messages?conversation=${encodeURIComponent(CONVERSATION_ID)}`;

describe('plausiblePageUrlFromHref', () => {
  it('drops the Wave A conversation query from a Shop page URL', () => {
    expect(plausiblePageUrlFromHref(HREF)).toBe('https://shop.pubky.app/marketplace/messages');
    expect(plausiblePageUrlFromHref(HREF)).not.toContain('conversation=');
    expect(plausiblePageUrlFromHref(HREF)).not.toContain(SELLER);
    expect(plausiblePageUrlFromHref(HREF)).not.toContain(BUYER);
  });
});

describe('rewritePlausibleEventBody', () => {
  it('strips query strings from JSON pageview payloads', () => {
    const rewritten = rewritePlausibleEventBody(JSON.stringify({ n: 'pageview', u: HREF, d: 'shop.pubky.app' }));
    const parsed = JSON.parse(rewritten) as { u: string };
    expect(parsed.u).toBe('https://shop.pubky.app/marketplace/messages');
    expect(rewritten).not.toContain('conversation=');
    expect(rewritten).not.toContain(CONVERSATION_ID);
  });

  it('strips query strings from form-encoded pageview payloads', () => {
    const rewritten = rewritePlausibleEventBody(`n=pageview&u=${encodeURIComponent(HREF)}&d=shop.pubky.app`);
    expect(rewritten).toContain('u=' + encodeURIComponent('https://shop.pubky.app/marketplace/messages'));
    expect(rewritten).not.toContain('conversation');
  });
});

describe('PLAUSIBLE_QUERYLESS_PAGE_BOOTSTRAP', () => {
  it('rewrites pageview bodies before the tracker script runs', () => {
    expect(PLAUSIBLE_QUERYLESS_PAGE_BOOTSTRAP).toContain('origin + url.pathname');
    expect(PLAUSIBLE_QUERYLESS_PAGE_BOOTSTRAP).toContain('sendBeacon');
  });
});
