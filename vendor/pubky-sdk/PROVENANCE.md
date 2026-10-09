# Vendored artifact — do not edit

`synonymdev-pubky-0.15.0-main-d8bf732.tgz` is the `@synonymdev/pubky` npm
package built from `pubky/pubky-homeserver` `main` at
`d8bf7321601d1bed56bb25bede6fda99708c9ef3` ("feat(sdk)!: add scoped encryption keys (#668)"),
v0.15.0 plus #680, #686 and #668. It exists only because the npm release that
carries #668 does not exist yet. The root `package.json` pins it as

```json
"@synonymdev/pubky": "file:vendor/pubky-sdk/synonymdev-pubky-0.15.0-main-d8bf732.tgz"
```

and `overrides["@bitcoinerrorlog/pubky-shop"]["@synonymdev/pubky"]` is
`"$@synonymdev/pubky"`, so `@bitcoinerrorlog/pubky-shop` resolves the same copy.

SHA-256 of the tarball: `4c3ad3458734faf51bf5a0311ed32fd4fb466004961faa35d268b6dda5c84f92`.

## What it does not contain

The signed-approval transport hardening of
[pubky-homeserver#682](https://github.com/pubky/pubky-homeserver/issues/682)
(the approval encrypted to an app-held key instead of the relay shared secret)
is not in `d8bf732`. The Shop never decrypts an approval itself: the SDK's
`GrantAuthFlow` receives, verifies and decrypts it, and `session.grant.encryptionKeys`
hands over the result. The release that adds #682 changes the transport inside
the SDK and nothing here.

## Swapping to the npm release

One edit, then a lockfile refresh:

1. In `package.json`, replace the `@synonymdev/pubky` dependency value with the
   release version (an exact version, as every other dependency is pinned).
2. `npm install --ignore-scripts`, then `npm run test`; the SDK gate
   (`sdk-call-sites.gate.test.ts`) checks there is one copy in the lockfile, that
   `@bitcoinerrorlog/pubky-shop` follows the root dependency, and that the copy
   declares `EncryptionKeys`, `approvalFormat` and the `e` action.
3. Delete this directory.

## How it was built

```sh
git clone https://github.com/pubky/pubky-homeserver && cd pubky-homeserver
git checkout d8bf732
cd pubky-sdk/bindings/js
cargo run --release --bin bundle_npm      # wasm-pack build + patch.mjs; needs Rust >= 1.89 and wasm-pack
cd pkg && npm pack                        # -> synonymdev-pubky-0.15.0.tgz
```

The tarball is the unmodified `npm pack` output: `index.cjs`, `index.js`,
`pubky.d.ts`, `pubky_bg.wasm`, `package.json`, `README.md` and `LICENSE`. Its
package version reads `0.15.0`, the same as the published 0.15.0, which does
not contain #668; the file name carries the commit that tells them apart.
