# Vendored artifact — do not edit

Generated `wasm-pack` output of the Pubky Locks browser SDK, vendored verbatim so
`npm ci` needs no network fetch from a mutable source. Referenced from the root
`package.json` as `"locks-sdk-wasm": "file:vendor/locks-sdk-wasm"`.

- Source: `https://github.com/pubky/locks` at commit
  `ba49a777a94db318ec6ebd427315080a5b904645`, package path `locks-sdk/bindings/js`.
- Full provenance (toolchain, generation command, checksums, re-vendoring steps):
  [`docs/ecommerce/locks-sdk-provenance.md`](../../docs/ecommerce/locks-sdk-provenance.md).
- Guarded in CI by `scripts/locks-sdk-smoke.mjs` (see `.github/workflows/build.yml`).

Never modify these files by hand. To update, rebuild from the pinned (or newly
pinned) upstream commit and re-record provenance.
