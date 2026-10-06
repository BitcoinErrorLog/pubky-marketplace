# Vendored artifact — do not edit

Generated `wasm-pack` output of the paykit-wasm browser binding (the Paykit
Encrypted Link messaging surface), vendored verbatim so `npm ci` needs no
network fetch from a mutable source. Referenced from the root `package.json`
as `"paykit-wasm": "file:vendor/paykit-wasm"`.

- Source: `https://github.com/BitcoinErrorLog/paykit-rs-official`, branch
  `fix/wasm-homeserver-write-abort`, commit
  `d4a73a5765e1f0b18ed451d78f98dab97c611a8c` (`0.1.0-rc50`), package path
  `paykit-wasm/pkg`.
- Full provenance (toolchain, generation command, checksums, re-vendoring
  steps): [`docs/ecommerce/paykit-wasm-provenance.md`](../../docs/ecommerce/paykit-wasm-provenance.md).
- Guarded in CI by `scripts/paykit-wasm-smoke.mjs` (see `.github/workflows/build.yml`).

Never modify these files by hand. To update, rebuild from the pinned (or newly
pinned) source commit and re-record provenance.
