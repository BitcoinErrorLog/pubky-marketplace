/**
 * Plausible classic scripts record `location.href`, including `?conversation=`.
 * Wave A listing thread ids must never become a page URL in analytics.
 */

export function plausiblePageUrlFromHref(href: string, base = 'https://invalid.invalid'): string {
  try {
    const url = new URL(href, base);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // fall through
  }
  return href.split(/[?#]/)[0] || href;
}

export function rewritePlausibleEventBody(body: string): string {
  if (body.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'n' in parsed &&
        'u' in parsed &&
        typeof (parsed as { n: unknown }).n === 'string' &&
        typeof (parsed as { u: unknown }).u === 'string'
      ) {
        const event = parsed as { n: string; u: string; [key: string]: unknown };
        event.u = plausiblePageUrlFromHref(event.u);
        return JSON.stringify(event);
      }
    } catch {
      return body;
    }
    return body;
  }

  if (!/(?:^|&)n=/.test(body) || !/(?:^|&)u=/.test(body)) return body;

  return body.replace(/(^|&)u=([^&]*)/g, (match, prefix: string, value: string) => {
    try {
      return `${prefix}u=${encodeURIComponent(plausiblePageUrlFromHref(decodeURIComponent(value)))}`;
    } catch {
      return match;
    }
  });
}

/**
 * Inline bootstrap: rewrite Plausible page URLs to origin+pathname before the
 * tracker script's first pageview. Keep as an IIFE string — it runs as a raw
 * <script> during document parse, ahead of next/script afterInteractive.
 */
export const PLAUSIBLE_QUERYLESS_PAGE_BOOTSTRAP = `(function(){
  function pageUrl(href){
    try {
      var url = new URL(href, location.href);
      return url.origin + url.pathname;
    } catch (e) {
      return String(href).split(/[?#]/)[0];
    }
  }
  function rewrite(body){
    if (body == null || typeof body !== 'string') return body;
    if (body.charAt(0) === '{') {
      try {
        var parsed = JSON.parse(body);
        if (parsed && typeof parsed.n === 'string' && typeof parsed.u === 'string') {
          parsed.u = pageUrl(parsed.u);
          return JSON.stringify(parsed);
        }
      } catch (e) {}
      return body;
    }
    if (!/(?:^|&)n=/.test(body) || !/(?:^|&)u=/.test(body)) return body;
    return body.replace(/(^|&)u=([^&]*)/g, function(match, prefix, value){
      try {
        return prefix + 'u=' + encodeURIComponent(pageUrl(decodeURIComponent(value)));
      } catch (e) {
        return match;
      }
    });
  }
  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data){
      return beacon(url, rewrite(data));
    };
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    if (init && init.body != null && typeof init.body === 'string') {
      init = Object.assign({}, init, { body: rewrite(init.body) });
    }
    return origFetch(input, init);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body){
    return origSend.call(this, rewrite(body));
  };
  window.plausible = function(eventName, options){
    options = options ? Object.assign({}, options) : {};
    options.u = pageUrl(options.u || location.href);
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
})();`;
