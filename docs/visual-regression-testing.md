# Visual Regression Testing (VRT)

VRT renders a component in a real browser (Playwright via `@vitest/browser`),
screenshots it, and pixel-compares against a committed baseline. It catches
layout/style/responsive/cross-OS regressions — not functional bugs (use unit /
interaction tests for those).

- Test files: `*.vrt.test.tsx`. Feed/onboarding/messages use the `vrt` Vitest
  project; marketplace files use `vrt-marketplace` (same `vitest.config.ts`).
- Run: `npm run test:vrt`. Update baselines: `npm run test:vrt:regenerate-baseline`.
- Baselines: `__screenshots__/<file>/<name>-<browser>-<platform>.png`, one per
  browser (chromium/firefox/webkit) × platform (darwin/linux).
- Harness: `src/test-utils/vrt.tsx` (`renderForVRT`, `VRT_ROOT_TESTID`),
  `vrt.setup.ts` (global mocks), `vrt.clock.ts`, `vrt.viewports.ts`.
- Reference example: `src/test/vrt/feed/Home.vrt.test.tsx`.

## Writing a test

```tsx
const screen = await renderForVRT(<Component />, { viewport: VRT_VIEWPORT_DESKTOP });
await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('name-desktop');
```

### Surface captures (`expectVrtSurface`)

When a scene should capture one production surface rather than the whole
viewport (a dialog, a form section, a cart group), the production component
marks its root with `data-surface="<name>"` and the test asserts through the
guard before capturing — the capture then wraps exactly that element
(including portaled dialog content, which sits outside the VRT root in the
DOM but inside its screenshot region):

```tsx
await expect(expectVrtSurface('pickup-reveal-dialog')).toMatchScreenshot('orders-pickup-reveal-desktop');
```

A scene without the production `data-surface` root is rejected by the guard
(see the negative test in `src/test/vrt/marketplace/MarketplacePickup.vrt.test.tsx`),
so a test-only stand-in can never be baselined by accident.

`renderForVRT` wraps the tree in a viewport-clamped root (the screenshot is
exactly the viewport, not full scroll height), freezes the clock, seeds
`Math.random`, and waits for fonts + successfully loaded images. Mock every
data dependency (store/hook/fetch/router) so the pixels are deterministic.

## Determinism

Renders should be as close to identical as possible every run, on every OS.
`vitest.config.ts` sets two screenshot tolerances. The `vrt` project
(`allowedMismatchedPixels: 80` and `allowedMismatchedPixelRatio: 0.00005`;
the matcher uses the more restrictive of the two) is small enough that a
one-word label change fails. A looser 0.1% ratio previously hid a marketplace
badge rewrite on desktop captures. The `vrt-marketplace` project uses
`allowedMismatchedPixelRatio: 0.02` and pixelmatch `threshold: 0.2` (no pixel
cap) so 0.01–0.02 run-to-run badge-disc AA and hover raster — the class that
halted shop-v0.6.10, shop-v0.6.11, and shop-v0.6.12 — does not fail the
release train, while a real layout rewrite still exceeds 2%. Both are shared
by comparison (`npm run test:vrt`) and regeneration (`--update`): `--update`
only rewrites a baseline when a capture differs by more than the allowance.
Prefer a per-scene `comparatorOptions` override over raising the
non-marketplace values. Feed and onboarding desktop shells that include dense
tab chrome use `VRT_DENSE_CHROME_SCREENSHOT` from `src/test-utils/vrt.tsx`
(cap 1600 px / 0.3%) because Inter Tight AA and leftover `:hover` on those
glyphs is hundreds of pixels on 1440×900 — still well below rewriting a
marketplace badge under the global 80 px cap.
Pin every deterministic source below so real diffs stand out:

- **Async data** — mock the hook/controller to a fixed value. An unmocked fetch
  resolves differently per run/region. This is the #1 cause of flakiness.
- **Time** — `renderForVRT` calls `freezeNow()`; mock any relative-time hook to
  the stable formatter in `vrt.clock.ts`.
- **Randomness** — `Math.random` is seeded by the harness, so name generators
  and placeholders stay stable.
- **Images** — `next/image` is mocked to a plain `<img>` in `vrt.setup.ts` (the
  browser runtime has no Next image optimizer, so the real component 404s).
  `renderForVRT` waits until each `<img>` has real pixels (`naturalWidth > 0`),
  then `decode()`, then two animation frames so SVG/logo paint cannot race the
  screenshot. Each image has a short timeout that rejects with the URL (and
  `complete` / `naturalWidth`) so a hung load is not mistaken for a generic
  test timeout. Load/decode failures reject with the image URL — broken assets
  must not become blank baselines. Swallowing `decode()` alone was not enough
  and caused intermittent blank header logos. Intentionally absent artwork
  should be mocked out of the tree rather than left as a broken `<img>`.
  **CSS `background-image` is not covered by that wait** — covers and other
  decorative backgrounds settle only via `toMatchScreenshot` retries unless
  you preload them first. Always `preloadImages(...)` (exported from
  `src/test-utils/vrt.tsx`; decodes via `new Image()`) for any CSS background
  URLs the surface paints, the same way Collections VRT does for card/hero
  covers before `renderForVRT`. Static `<img>` assets (e.g. logo SVGs) are
  covered by the wait, but a cold fetch can still race the initial paint —
  `preloadImages(...)` them too when a surface has flaked on a specific asset
  (see the Landing VRT's header/brand logos).
- **Hover transforms** — marketplace listing/drop cards use
  `transition-transform duration-300` plus `hover:scale-105` and a random
  `--card-hover-rotation`. They also run `.marketplace-card-enter`
  (`420ms both`, delay `index * 60ms`). The `vrt-marketplace` project
  rewrites shared `transition: none` to `transition-duration: 0s` so the
  hover end-state paints on the first frame, and **leaves `animation: none`**
  so the delayed enter `from` keyframe (`translateY(18px) scale(0.96)`)
  cannot compose with hover. Zero-motion CSS sets `animation-name: none`
  and `animation-delay: 0s`; it must not replace `animation: none` with
  duration-only `animation-duration: 0s`. Files run serially
  (`fileParallelism: false`). Capture hover scenes with
  `hoverAndWaitForScale` from `src/test-utils/vrt.tsx`: finish leftover
  animations on the VRT root, re-assert `:hover`, then wait until
  `getBoundingClientRect().width` is ≥ the pre-hover rest width × 1.04
  and no CSS animations are running. Do not wait on `offsetWidth` (layout
  ignores transforms) or `getComputedStyle().transform` / `scale` (they
  report the target immediately).
  Never rewrite `animation: none` to `animation-duration: 0s`: hover is a
  transition, card-enter is an animation; duration-only re-enables delayed
  fill-mode `from` and composes with hover.
  Playwright `locator.hover()` also scrolls a bottom-row card into view
  inside overflow-hidden `VRT_ROOT` (~39px, ±8px vs the committed crop).
  Call `hover({ force: true })` as a method (do not extract it) and pin
  `VRT_ROOT` at scroll 0 before capture so the scene is rest layout plus
  hover, not a scrolled crop.

- **Avatars** — VRT profile fixtures use `image: null` so every avatar renders
  `FacehashAvatar`. `vrt.setup.ts` sets `globalThis.__VRT__` and stabiliser CSS;
  `FacehashAvatar` disables blink, 3D tilt, and hover when that flag is set.
- **vi.mock + import order** — factories are hoisted; keep the
  `eslint-disable simple-import-sort/imports` header so `eslint --fix` can't
  reorder imports into a TDZ crash. Don't reference a top-level `const` inside a
  `vi.mock` factory (it's hoisted above the const) — inline the literal.

## Render like the real app

A template alone misses chrome the root layout adds. Onboarding pages render
under `<Header />` (the step bar), mounted by `src/app/layout.tsx`. Render that
wrapper in the test and mock what it reads (`usePathname`, `useAuthStore`,
`usePublicRoute`) so the snapshot matches what the user sees.

## Limitation: can't capture a page taller than the screen

A page taller than the viewport is cropped at the fold — the bottom is not in
the baseline. `toMatchScreenshot` takes an element (locator) screenshot, which
can't do full-page capture, and a headless browser doesn't rasterize offscreen
content anyway. Growing the viewport doesn't help: an oversized initial viewport
makes the browser scale the whole screenshot by an env-dependent factor, which
breaks the cross-OS comparison.

**What to do:** accept the viewport crop (every other VRT here does), or capture
a tall page section by section (header / card / footer as separate snapshots).

See [Vitest Discussion #7749](https://github.com/vitest-dev/vitest/discussions/7749).

## Artifact: sub-pixel seams on segmented elements

A baseline may show thin tick lines that you don't see in your real browser.
Example: the onboarding progress bar (`molecules/ProgressSteps`) is 5 adjacent
`<div>` segments (`gap-0`), each with its own fill; the seams between them show
as faint notches.

Cause: the test renders at a lower device-pixel-ratio than a retina display, so
adjacent elements anti-alias at the boundary instead of blending. Not a CSS bug
— a rasterization artifact of any element built from abutting pieces.

**Accept it in the baseline.** It reproduces identically every run, so it doesn't
cause flakiness or hide regressions.

## Updating baselines

`test:vrt:regenerate-baseline` (`--update`) updates **every** baseline that runs,
ignoring a path argument — so it silently rewrites unrelated baselines with your
machine's render. To update only your files:

```bash
npx vitest run --project vrt --project vrt-marketplace <path-to-your-dir-or-file> --update
```

After any `--update`, run `git status` and revert baselines you didn't intend to
touch (`git checkout -- <path>`). Pre-existing cross-machine drift (a baseline
that fails on your Mac with the code reverted) is not yours to re-baseline.

Prove a hypothesis on one test before regenerating many. If a shared helper
(`vrt.tsx` / `vrt.setup.ts`) changes, re-run one image and eyeball it first.

## CI baseline update workflow

Actions → **VRT Update Baselines** → run on the branch whose code you want
baselined.

| Triggered from | Commit target                                    | Pull request                    |
| -------------- | ------------------------------------------------ | ------------------------------- |
| `dev`          | `vrt-update-baselines` (reset from latest `dev`) | Opens PR → `dev` if none exists |
| Feature branch | Same feature branch                              | None                            |
| `master`       | —                                                | Workflow fails (do not use)     |

The workflow never commits directly to `dev` or `master`. It regenerates on both
`ubuntu-latest` and `macos-latest`, merges `*-linux.png` and `*-darwin.png`
artifacts, then commits the combined result.

Only baselines that changed are committed: `--update` leaves matching baselines
untouched on disk (within the tolerance above), and the commit step stages via
`git add` + `git diff --staged --quiet`, so a run with no visual changes makes no
commit and opens no PR.

**CI is the source of truth.** Because pixel rendering differs between a local
machine and the GitHub runners, baselines must be generated by this workflow, not
committed by hand. The first run after adopting this workflow regenerates every
baseline (locally-made baselines never match the runners) — merge that one large
PR to make the runners the baseline owner. Subsequent runs then only touch
surfaces that genuinely changed.

**webkit-darwin baselines are always CI-authored.** Measured 2026-09-10 on
`macos-latest` (macOS 26.6.2, Playwright 1.60.0): chromium and firefox darwin
PNGs made on a local Mac match the runner at 0 px, but webkit rasterises the
pinned `JetBrains Mono` glyphs (`vrt.setup.ts`) differently from a local Safari
WebKit — 93 to 801 px of drift confined to price/mono text on 46 marketplace
scenes, with no code change involved. Do not commit a locally generated
`*-webkit-darwin.png` for any scene that renders the mono font: take it from the
VRT Update Baselines run (or the failure artifact of a `vrt.yml` run, whose
actual image is byte-identical to the last Update Baselines output). A local
webkit failure on those scenes is not a regression signal; the `macos-latest`
job is.

## 3× local full-suite before a flaky-gate PR

A VRT gate that failed once is not a flake until the same command has been
green three times in a row on one machine, against the same HEAD, with the
same Playwright version as `package-lock.json`.

```bash
npx playwright --version   # must match packages["node_modules/playwright"].version
npm run test:vrt           # full suite: both `vrt` and `vrt-marketplace`
npm run test:vrt
npm run test:vrt
```

One green run after a retry, a path-filtered rerun, or a `--update` is not
the three. If the third run fails, the gate is still red: fix the scene or
the harness, do not widen tolerance or regenerate an untouched baseline to
make CI merge. After any `--update`, `git status -- '**/__screenshots__/**'`
and revert every PNG the PR did not intend to change.

## Linux marketplace baselines (`vrt-marketplace` CI)

new scenes: run `npm run vrt:linux` before pushing so Linux baselines ship with the PR.

The `vrt-marketplace` job runs in `mcr.microsoft.com/playwright:v1.60.0-noble`
(lockfile `playwright` 1.60.0) and compares chromium+firefox captures against
committed `*-linux.png` only. It never writes `*-darwin.png`. A missing linux
baseline fails the job; the recorded PNG is uploaded as
`vrt-marketplace-linux-baselines` and the log tells the author to commit it.
A pixel mismatch against an existing linux baseline also fails.
`npm run vrt:linux` is the local equivalent: same image, `--update` only for
missing `*-linux.png` (mismatch still fails; tracked linux and darwin are
never rewritten).

Capture region is the element's border box: `expectVrtSurface` / `VRT_ROOT`
screenshots, with window and element scroll reset to the top before the shot.
That region is the same on Linux and darwin. Do not clip to the 720px viewport
and do not take a `fullPage` document shot — a 720-tall crop of a tall
sell/drops/orders/cart surface will fail darwin (957/957) and is not a Linux
baseline.

Fonts are the app's vendored `@fontsource-variable/inter-tight` and
`@fontsource-variable/jetbrains-mono` (`vrt.setup.ts`). Do not install a
different system family in CI and do not copy a darwin PNG onto `*-linux.png`
to paper over substitution.

When Linux PNGs are stale (viewport crop, old product chrome) regenerate them
on Playwright Linux that matches `package-lock.json` (`playwright` 1.60.0 →
`mcr.microsoft.com/playwright:v1.60.0-noble`):

```bash
export COPYFILE_DISABLE=1
docker run --rm \
  -e COPYFILE_DISABLE=1 \
  -e VRT_BROWSERS=chromium,firefox \
  -v "$PWD":/w -w /w \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  sh -c 'npm ci && npx vitest run --project vrt-marketplace --update'
git checkout -- 'src/test/vrt/**/*-darwin.png'
git status -- 'src/test/vrt/**/*-linux.png'
```

After `--update`, revert every `*-darwin.png` and any linux file you did not
intend to touch. Prove three consecutive Linux full runs green, then a local
darwin `vrt-marketplace` full suite (957/957) before treating the job as a
candidate required check. Do not raise `allowedMismatchedPixelRatio` to hide a
region or product mismatch.
