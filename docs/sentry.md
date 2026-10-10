# Observability (Sentry + Pulse)

How errors and performance data leave Pubky App. Sentry is the primary sink (browser, server and edge). Pulse (`@synonymdev/pubky-pulse-web`) is an optional, consent-gated, browser-only second sink for anonymous usage and errors — see [Pulse](#pulse-browser-only-second-sink) below, and [environment.md](environment.md) for its configuration and consent flow.

## What is captured

| Source                                               | Mechanism                                                                                                                                                                         | Sink           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Every `Err.*` factory call                           | `captureAppError(error)` inside `createAppError()` (one call per AppError; structured tags: `error.category`, `error.code`, `error.service`, `error.operation`, `error.trace_id`) | Sentry + Pulse |
| Unhandled browser JS exceptions                      | Sentry `globalHandlers` integration (auto); Pulse `captureUnhandled` (auto)                                                                                                       | Sentry + Pulse |
| Unhandled promise rejections                         | Sentry `globalHandlers` integration (auto); Pulse `captureUnhandled` (auto)                                                                                                       | Sentry + Pulse |
| Server Component / Route Handler / middleware errors | `onRequestError = Sentry.captureRequestError` exported from `src/instrumentation.ts` (Next.js 15+)                                                                                | Sentry         |
| Route segment render errors                          | `Sentry.captureException(error)` + `Pulse.captureException(error)` in the `useEffect` of `src/app/error.tsx`                                                                      | Sentry + Pulse |
| Root layout render errors                            | the same pair in the `useEffect` of `src/app/global-error.tsx`                                                                                                                    | Sentry + Pulse |
| Replay (masked)                                      | `replayIntegration({ maskAllText, blockAllMedia, maskAllInputs })` on errored sessions                                                                                            | Sentry         |
| Browser screen views                                 | Pulse `trackPageViews`, pathnames mapped to route templates by `pulseScreenName` in `src/libs/observability/pulse.ts`                                                             | Pulse          |

Every `Pulse.*` capture call is a no-op until `Pulse.init()` runs, and it never runs outside the browser or without consent — so a `Sink` of "Sentry + Pulse" means Sentry always, Pulse only in a consenting browser.

## Capture rule

> Throw via `Err.*` factories. Do **not** call `Sentry.captureException` or `Pulse.captureException` directly anywhere except the single `Pulse.captureException` inside `createAppError()` (`src/libs/error/error.factories.ts`) and the two boundaries `app/error.tsx` and `app/global-error.tsx` — and in those two files only for non-`AppError` instances.

The `Err.*` factories already log once and capture once into each sink — adding extra `Sentry.captureException` or `Pulse.captureException` calls causes duplicate issues in that dashboard. Anything that bubbles to the browser global handler is captured automatically by both SDKs; the server `onRequestError` hook reaches Sentry only.

The two route-segment error boundaries (`app/error.tsx`, `app/global-error.tsx`) guard their `Sentry.captureException` and `Pulse.captureException` calls with `if (!(error instanceof AppError))` so an `AppError` thrown during render isn't captured twice (once by the factory, once by the boundary).

For future Server Actions, wrap with `Sentry.withServerActionInstrumentation('actionName', { headers: await headers() }, async () => { ... })` so server-action errors are captured and traces stitch with the client.

### OG metadata enrichment

`/api/og-metadata` is best-effort link-preview enrichment. Expected external outcomes should normally be handled before
`Err.*` creation so they do not create Sentry issues:

- Expected remote failures such as forbidden/not-found/gone pages, non-HTML content, DNS failure, network failure,
  timeout, rate limiting, or remote 5xx return fallback metadata.
- Invalid user URLs return a normal `400` response from the controller/route without `Err.validation`.
- `og:image` normalization uses non-throwing DNS safety checks, so invalid image URLs, DNS failures, and private image
  IPs simply remove the image from otherwise valid page metadata.
- Security/anomaly cases on the main page fetch path, such as private IPs, non-HTTP redirects, redirect loops, oversized
  bodies, and parser/runtime surprises remain reportable through `Err.*`.

Fallback paths use `Logger.warn`, which is currently platform/server logging. Sentry Logs are disabled in this app, so
these warnings are not Sentry aggregate events unless logging infrastructure is enabled separately.

### Known quirk: render-time errors emit 2 events in React 19

When an `AppError` is thrown synchronously during React render (as opposed to event handlers, effects, or application-layer code), React 19 attempts to re-render the failing component once before handing off to the error boundary. Each render invocation runs the `throw Err.*(...)` expression afresh, constructing a new `AppError` and routing through `captureAppError` — producing **2 Sentry events** within ~30 ms.

Both events share identical fingerprints, so Sentry groups them into a **single issue** — triage and alerting are unaffected, only the raw event count is inflated. This pathology is limited to synchronous render throws; event-handler, effect, Server Action, and application-layer throws all emit exactly one event.

See [React 19's `onRecoverableError` docs](https://react.dev/reference/react-dom/client/createRoot#parameters) for the retry semantics. If event-quota inflation ever becomes a concern, the fix is a short-window LRU in `captureAppError` keyed on `${service}:${operation}:${message}`.

## Pulse (browser-only second sink)

Pulse is opt-in twice over: it does nothing without `PUBKY_RUNTIME_PULSE_CLIENT_KEY`, and nothing until the visitor accepts the analytics banner. Until `Pulse.init()` runs, every `Pulse.*` capture call is a silent no-op — including on the server, where the SDK never initializes, so a server-side `Err.*` reaches Sentry only. (`Pulse.reset()` is the exception: it deletes stored `pulse.*` state even on a page that never initialized, which is how a returning tab cleans up.) `initializePulseConsent()` in `src/libs/observability/pulse.ts` installs the gate from `src/instrumentation-client.ts` before any app code runs, and it resets with whichever scope the situation calls for: a withdrawal calls `Pulse.reset()`, which disables collection without flushing and deletes the browser-wide anonymous id, session and queued events, while a tab whose own state merely predates a consent that still stands calls `Pulse.reset({ scope: 'tab' })`, which deletes that tab's client and session and leaves the shared id and the queued events other tabs recorded under the current consent alone. The SDK falls back to the browser-wide deletion whenever the narrower one cannot be confirmed, so the failure mode deletes more, not less. The consent storage, the cross-tab generation marker and the user-facing controls are documented in [environment.md](environment.md).

- **One drop policy for both sinks.** `beforeSendPulse` re-applies `shouldDropAppErrorFromSentry` and `sanitizeForSentry` from `sentry.utils.ts` to every event, so a rule added to `APP_ERROR_DROP_RULES` and a key added to the scrubber cover Sentry and Pulse together. Nothing Pulse-specific should be filtered elsewhere. `beforeSendPulse` also drops everything once consent is withdrawn, or when this tab's Pulse state predates the current consent.
- **One `ignoreErrors` list.** Both initializers spread `OBSERVABILITY_IGNORE_ERRORS` from `sentry.constants.ts`; add a noise pattern there, never in one SDK's options, or the two dashboards drift.
- **No raw error context.** Only `category`, `code`, `service`, `operation` and `trace_id` are copied onto the event; the `AppError` and its `context` are never spread.
- **No fetch-level network tracking.** `networkTracking` stays off: the SDK's own request events are emitted before `beforeSend` sees an `AppError`, so they would bypass the drop rules. Network failures still arrive, as the `AppError`s the app throws for them.
- **Screen names are an allowlist.** `pulseScreenName` maps a pathname to one of the declared route templates and falls back to `/unknown`, so a pubky, post id or invite code never becomes a screen name. Add new routes to that list, never a raw pathname.
- **Device fields are spelled out.** `deviceInfo: { os: true, browser: true, language: false }`: the SDK stamps the operating-system and browser/device strings it parses from the user agent (what makes a browser-only error actionable, and what the banner names), and no `locale` / `preferred_language`.
- **Pulse is off when** `NODE_ENV=test`, `VITEST` is set, the **runtime** config has `testnet=true`, no **runtime** client key is configured, or consent is not `accepted` — the same test/testnet gates Sentry uses.

There is deliberately no `capturePulseException` funnel mirroring `captureAppError`: `beforeSendPulse` runs on every path into the SDK (factory captures, boundary captures and its own unhandled handlers), so it is already the single policy point.

## Files

- `src/instrumentation.ts` — server runtime dispatch + `onRequestError` + boot-time runtime-config fail-fast
- `src/instrumentation-client.ts` — browser init + Replay + `onRouterTransitionStart` + `initializePulseConsent()`
- `src/sentry.server.config.ts` / `src/sentry.edge.config.ts` — runtime-specific init
- `src/libs/observability/sentry.ts` — single source of truth (`shouldEnableSentry`, `getSentryInitBase`, `captureAppError`). Sentry is off when `NODE_ENV=test`, `VITEST` is set, the **runtime** config has `testnet=true`, or no **runtime** DSN is configured. If the runtime config cannot be resolved at all, the gate returns `false` instead of throwing (the capture funnel must never mask the original boot error).
- `src/libs/observability/sentry.constants.ts` — `OBSERVABILITY_IGNORE_ERRORS`, the one noise policy both Sentry and the optional Pulse sink spread into their SDK `ignoreErrors`; add a pattern here, never in a single initializer
- `src/libs/observability/pulse.ts` — Pulse init, the consent gate, the screen-name allowlist and `beforeSendPulse`
- `src/libs/observability/pulse-consent.ts` — the stored consent choice and its generation, the availability gate, and the cross-tab subscription
- `src/libs/error/error.factories.ts` — `createAppError()` calls `captureAppError(error)` after `Logger.error`, then `Pulse.captureException(error)`
- `next.config.ts` — wrapped by `withSentryConfig(...)` for SDK wiring only; source-map upload is disabled (see below)

## Environment variables

All Sentry and Pulse values are part of the **optional runtime-config tier** ([ADR 0018](adr/0018-runtime-sentry-and-decoupled-source-maps.md)): set `PUBKY_RUNTIME_SENTRY_*` / `PUBKY_RUNTIME_PULSE_*` on the deployed container, or in `.env.local` for local dev. Schema and defaults live in `src/libs/runtime-config/runtime-config.schema.ts`.

| Variable                                            | Runtime                 | Required?                                                                                                     |
| --------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PUBKY_RUNTIME_SENTRY_DSN`                          | browser + server + edge | Optional. Empty/unset disables Sentry entirely.                                                               |
| `PUBKY_RUNTIME_SENTRY_ENVIRONMENT`                  | all                     | Optional. Defaults to `NODE_ENV`.                                                                             |
| `PUBKY_RUNTIME_TESTNET`                             | all                     | When `true`, Sentry and Pulse are disabled (CI E2E / testnet deploy).                                         |
| `PUBKY_RUNTIME_SENTRY_TRACES_SAMPLE_RATE`           | all                     | Optional. Default `0.1`.                                                                                      |
| `PUBKY_RUNTIME_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`  | browser                 | Optional. Default `0.0` (record only on error).                                                               |
| `PUBKY_RUNTIME_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` | browser                 | Optional. Default `1.0`.                                                                                      |
| `PUBKY_RUNTIME_PULSE_CLIENT_KEY`                    | browser                 | Optional. Empty/unset disables Pulse entirely. Public, write-only `pulse_client_…` key — never an admin key.  |
| `PUBKY_RUNTIME_PULSE_ENDPOINT`                      | browser                 | Optional. Overrides the SDK's hosted ingest host (`https://ingest.pubkypulse.com`); self-hosters must set it. |

`SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` are optional Docker build inputs used only for source-map upload. They are never app runtime config and are not required to build or run the public image. The release tag comes from `NEXT_PUBLIC_APP_VERSION`: local builds fall back to the package version, while Docker CI sets it to the commit SHA so SDK events and uploaded maps use the same release.

## Source maps

The public Docker image remains buildable **without** Sentry credentials. Docker builds always inject Debug IDs, and upload source maps only when Sentry build credentials are provided ([ADR 0018](adr/0018-runtime-sentry-and-decoupled-source-maps.md)):

1. `next.config.ts` generates maps for every build (`productionBrowserSourceMaps` + `experimental.serverSourceMaps`) and disables the plugin upload (`sourcemaps.disable: true`, `release.create: false`).
2. The Dockerfile builder stage runs `npx sentry-cli sourcemaps inject` over `.next` and over the nested `.next/standalone/.next` (hidden directories are skipped by the walker) — offline, deterministic Debug-ID stamping of chunks and maps.
3. If `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are present, the Dockerfile uploads `.next` source maps with `--release="$NEXT_PUBLIC_APP_VERSION"`.
4. The runner stage deletes `*.map` under `.next/static` (browser maps must not be publicly served); standalone server maps stay for readable Node stack traces.

Third-party deployers get unsymbolicated events unless they obtain the maps for their image version and upload them to their own org (publishing maps as a release artifact is the recommended follow-up).

## Privacy

Pubky App is decentralized social — strict defaults:

- `sendDefaultPii: false` (no IP, no headers)
- Replay: `maskAllText: true`, `maskAllInputs: true`, `blockAllMedia: true`, `networkCaptureBodies: false`
- `beforeSend` defensively redacts user identifiers and user-provided data from app-controlled payloads:
  `email`, `phone` / `phoneNumber`, `name`, `firstName`, `lastName`, `displayName`, `username`, `bio`, `file`,
  `user`, `cookie` / `cookies`, raw Pubky public keys, `pubky://...` URIs, compact Pubky URLs, and `_pubky.`
  HTTP hostnames. The same bounded recursive scrubber covers `tags`, `fingerprint`, `threads`, and
  `measurements`, including runtime payload shapes outside the SDK's static types.
- `captureAppError()` sanitizes `error.context` before attaching it to Sentry. New `Err.*` contexts must avoid raw user
  data unless the key is covered by the scrubber in `src/libs/observability/sentry.utils.ts`.
- Pulse events pass through that same scrubber in `beforeSendPulse`; they carry no bodies, no replay, no raw error
  context and no user id — `Pulse.setUser` is never called, so every event is anonymous.

Never call `Sentry.setUser({ email, ... })` or `Pulse.setUser(...)`. If user attribution is ever needed, use the user's Pubky public key as `id` only.

### Tracing scrubbing (`beforeSendTransaction`, `beforeSendSpan`)

Tracing payloads carry user-controlled URL strings (route names, fetch URLs, root-span data) that
the error-only `beforeSend` does not see. Two additional hooks in `src/libs/observability/sentry.ts`
cover them:

- **Bounded recursive walker** applies pattern and sensitive-key redaction to `event.request`,
  `event.contexts`, `event.extra`, `event.user`, `event.tags`, `event.fingerprint`, `event.threads`,
  and `event.measurements`.
- Transaction names and span descriptions receive pattern scrubbing; `span.data` receives the same
  bounded recursive scrub.

SDK-structural context names (`browser`, `runtime`, `os`, `device`) are preserved after their string
values are pattern-scrubbed. `event.spans[]` remains delegated to `beforeSendSpan`; double-walking
would be redundant and risks double-scrubbing.

## Disabled / deferred features

| Feature                      | Status   | Why                                                                                                                 |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Sentry Logs                  | Disabled | Repo uses a custom `Logger`; routing through `Sentry.logger.*` adds no value today.                                 |
| Profiling                    | Disabled | Requires `Document-Policy: js-profiling` header; revisit if performance hunts need it.                              |
| AI Monitoring                | N/A      | No OpenAI/Anthropic/Vercel AI SDK calls in this codebase.                                                           |
| Crons                        | N/A      | No scheduled jobs.                                                                                                  |
| `tunnelRoute: '/monitoring'` | Deferred | Would require adding `middleware.ts` to exclude the path. Revisit if Sentry shows ad-blocker drops.                 |
| Pulse `networkTracking`      | Disabled | Its fetch-level events are emitted before `beforeSend` can see an `AppError`, so they bypass the shared drop rules. |

## Verification

To verify a deployment, open the `/sentry-test` harness (reachable everywhere except real
production) and trigger each capture path. The diagnostics card shows the resolved runtime
settings, including **Client SDK initialized** (`Sentry.getClient()`), which catches the
silent-failure mode where Sentry is enabled but the browser SDK never initialized because
`window.__PUBKY_CONFIG__` was not injected before `instrumentation-client.ts` evaluated.

Then inspect recent Sentry events for the configured environment and confirm the
**source maps** resolve (original `.tsx`/`.ts` frames, not minified bundle names) and the **`release`**
tag matches `NEXT_PUBLIC_APP_VERSION` for the build under test.
