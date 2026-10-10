# Shop v0.6.50

Notes for the GitHub release `shop-v0.6.50`. The release lane adds the header (date, exact commit, Vercel deployment id and URL, rollback target) and the proof result when it tags, per [`release.md`](../release.md#tag-and-release-notes). The user-facing bullets are the changelog fragments added or changed since `shop-v0.6.49` (`changelog.d/next/digital-paypal-reversal.fixed.md`, `paykit-refusals.changed.md`, `locks-invoice-admission.fixed.md`), reworded for readers.

Range: `shop-v0.6.49..master`. Pull requests: #142, #143, #144, #145 and the USDT foundations #146, #149, #150 and #151. #141 already shipped in v0.6.49: it merged into #135's branch before that tag.

## Buying and selling

- Bitcoin payment problems now say what happened and what to do next, in plain words. (#143)
  - A payment request that takes too long shows "Still waiting on the payment request" with a Check again button, instead of an endless spinner.
  - A request that wasn't ready in time no longer says nothing was charged. It tells you not to pay any request for that order that reached your wallet, then to check out again.
  - A request your wallet declined, canceled, let expire, or that ran out of payment time now says so, and what to do next.
  - A request the Paykit server couldn't create, or that conflicted with an earlier one, is named as such.
  - When Bitcoin can't start at checkout, the message tells you to try again or pick another payment method instead of blaming "the Paykit server".
- A digital purchase is withheld while PayPal has reversed the payment or refunded part of it. The buyer's order page says "The payment was reversed, so the download is disabled." (or that PayPal refunded the payment), and the seller's Show email is replaced by the same reason. A canceled reversal brings the download back. (#144, with marketplace-service #88)
- Locked digital content: if a payment request can't be admitted, the order says why instead of waiting. The "nothing is charged" claim was removed from that message because it can be false. (#143)

## Behind a flag, off, and invisible

- **USDT payments (#146, #150, #151, #149).** The Shop can carry USDT (USDT0 on Arbitrum One) as a payment method: seller settings, checkout, status and finality, refusals and refund addresses. All of it is off. The switch is `PUBKY_RUNTIME_USDT_PAYMENTS_ENABLED`, default `false`, and a new offer also needs the marketplace service to report `usdt_payments.available` on `/health`, which today's service does not. With the switch off the Shop does not call `/health` for it, and Bitcoin, PayPal and Locks pages render exactly as before. An order that already carries a USDT payment is always displayed, but none exists. See [`usdt-payments.md`](../usdt-payments.md).

## Under the hood

- The Locks client moved from a vendored wasm build to the published `@synonymdev/locks-sdk@0.1.0-rc10` from npm, pinned in `package-lock.json`. The Shop only calls `BundleId.generate()`, which is unchanged, and the SDK is on no network path, so checkout behaves the same against the Lock Servers in use today. The wasm is still lazy-loaded, so initial page weight is unchanged. (#142)
- Docs: the production homeserver is recorded on v0.15.0 as of 9 Oct (#145); `FEATURES.md` now lists digital delivery (#144).

## Operator actions

- **Shop config: none required.** The one new runtime key is `PUBKY_RUNTIME_USDT_PAYMENTS_ENABLED`; unset it resolves to `false`, and a strict deployed parse succeeds without it. Leave it unset. No other runtime key, Vercel variable or build flag changes.
- **Dependencies:** the build installs `@synonymdev/locks-sdk@0.1.0-rc10` from npm and no longer needs `vendor/locks-sdk-wasm`. `npm ci` must reach the npm registry.
- **marketplace-service:** the digital reversal and refund copy shows only after the service also withholds the read (service #88, on `main`, not in the `301fd570` image). The Shop renders it from fields the service already returns, so the Shop is safe on today's service. The USDT service flag must never be turned on before this Shop is deployed: an older Shop rejects an unknown `payment_method`.
- No database migration, no local database (Dexie) version change, no stored session change.

## Known limitations

- Pubky Ring 2.0 crashes on launch on iOS 27 (2.0.1 pending). On Android, updating to 2.0 needs a restore from backup. (#126)
- Bitcoin payments and seller setup for Bitkit 2.6 wait for the Shop's move to upstream Paykit and Locks. (#121)
- USDT is not available to anyone in this release.
