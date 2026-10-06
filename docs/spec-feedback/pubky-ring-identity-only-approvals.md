# Draft issue for Pubky Ring: render identity-only auth requests explicitly

Status: DRAFT — not filed. Target repo is `synonymdev/pubky-ring` (outside the
BitcoinErrorLog org), so filing needs an explicit go-ahead.

---

Title: Identity-only auth requests render an empty permission list with no
explanation

## What happens

When an app requests an AuthToken with zero capabilities — a pure identity
attestation, no homeserver scopes — Ring's approval screen shows an empty
permission list and nothing else. A tester approving the pubky-marketplace
transaction-service session reported it as a suspected bug: "the session did
not ask for any permissions, but it still worked when authorizing anyway."

## Why this matters

Zero-capability approvals are the least-privilege case working exactly as
designed: the signer proves key ownership to a service without granting any
homeserver access. That is the pattern services SHOULD use when they only
need authentication. Today Ring's UI punishes it — an empty list reads as
"something is missing," which pushes app developers toward requesting scopes
they do not need just to look legitimate.

## Suggested behavior

When the requested capability set is empty, say so explicitly, e.g.:

> This approval only proves your identity to the requesting service. It
> grants no access to read or write anything on your homeserver.

And when capabilities ARE requested, a short human description per scope
(the scope-to-description mapping) would serve the same clarity goal — that
mapping currently has no owner and is also raised as feedback on the
social/v1 spec (scope vocabulary, R7 in our spec-feedback document).

## Context

- The requesting flow: pubky-marketplace's transaction-service session
  (`shop.pubky.app`), which exchanges a signed AuthToken for a bearer
  session; the token requests no capabilities by design.
- The client now pre-explains this on its connect dialog ("Ring will show an
  empty permission list — that is correct…"), but the explanation belongs in
  the signer, where the trust decision happens.
