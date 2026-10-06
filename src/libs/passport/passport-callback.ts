import { PASSPORT_CALLBACK_MESSAGE } from './passport-popup';

/**
 * The Passport return page (`PASSPORT_CALLBACK_PATH`). Passport navigates
 * the popup here when it cannot message the Shop directly. The page forwards
 * the outcome hint to the Shop window that opened the popup, on this origin
 * only, and closes. The query string is an untrusted hint: it never signs
 * anyone in, and nothing from it is written into the page.
 *
 * Served as a static document rather than an app route, so the popup does
 * not boot the Shop (session restore, route guard) a second time.
 */
export const PASSPORT_CALLBACK_SCRIPT = `(function () {
  var outcome = new URLSearchParams(window.location.search).get('outcome');
  var known = outcome === 'success' || outcome === 'error' || outcome === 'cancel';
  var status = document.getElementById('passport-return-status');
  if (status && known) {
    status.textContent =
      outcome === 'success'
        ? 'Approved in Pubky Passport. Return to Pubky Shop to continue.'
        : outcome === 'cancel'
          ? 'Cancelled in Pubky Passport.'
          : 'Pubky Passport could not approve the request.';
  }
  var opener = null;
  try {
    opener = window.opener;
  } catch (error) {
    opener = null;
  }
  if (known && opener && !opener.closed) {
    opener.postMessage({ type: ${JSON.stringify(PASSPORT_CALLBACK_MESSAGE)}, outcome: outcome }, window.location.origin);
    window.close();
  }
})();`;

export const PASSPORT_CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pubky Passport</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:oklch(0.118 0.014 284.115);color:#f5f5f5;font-family:system-ui,-apple-system,sans-serif}
main{max-width:22rem;padding:2rem;text-align:center;line-height:1.5}
a{color:oklch(0.928 0.23 123.978);font-weight:600}
</style>
</head>
<body>
<main>
<p id="passport-return-status">You can close this window and return to Pubky Shop.</p>
<p><a href="/marketplace">Return to Pubky Shop</a></p>
</main>
<script>${PASSPORT_CALLBACK_SCRIPT}</script>
</body>
</html>
`;
