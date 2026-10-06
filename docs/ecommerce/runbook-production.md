# Shop Production Kill Switch And Rollback Runbook

Operational scope: Shop production client on Vercel project `pubky-marketplace-production`, with staging client on
`pubky-marketplace-staging`, both in Vercel team `synonymdev` (`team_y2cqjCWZ9vTnCPWQkUAgfijD`). Releases are in
[`release.md`](release.md).

Run Vercel commands from a checkout linked to the target project. `.vercel/` is gitignored, so a fresh checkout is
unlinked, and `vercel --prod` from an unlinked checkout creates a new project instead of touching the Shop:

```bash
rm -rf .vercel
vercel link --yes --project pubky-marketplace-production --scope synonymdev   # or pubky-marketplace-staging
cat .vercel/project.json                                                     # confirm the project name
```

Do not paste secret values from Vercel or Railway output into tickets, docs, logs, or chat.

## What The Kill Switch Does

Set `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=unavailable` on the production Vercel project.

The env var name is mapped to `commerceAdapterMode` in `src/libs/runtime-config/runtime-config.schema.ts`, whose
`commerceAdapterModeValue` enum allows `unavailable`, `sandbox`, `transaction-service`, and `locks-paykit`.
`unavailable` is browse-only with no transactional commands, and it is the schema default.

This is a runtime config value, not a Next.js `NEXT_PUBLIC_*` inline, but on Vercel it is fixed per deployment: pages
are prerendered at build time (`src/libs/runtime-config/render-mode.ts`), and the server serializes the build's
resolved `PUBKY_RUNTIME_*` config into the HTML (`src/libs/runtime-config/runtime-config.ts`). The browser reads
`window.__PUBKY_CONFIG__`, and `getCommerceAdapterMode()` returns the injected value. The injection happens in
`src/components/molecules/ContainerRoot/ContainerRoot.tsx`, before the app bundle executes.

Vercel env changes still require a new deployment to affect the running site. Treat the env flip and redeploy as one
operation.

## Flip Production To Unavailable

From a checkout linked to `pubky-marketplace-production`:

```bash
vercel env ls production --scope synonymdev
vercel env update PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE production --value unavailable --yes --scope synonymdev
vercel deploy --prod --yes --scope synonymdev
```

If the variable is missing instead of present:

```bash
vercel env add PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE production --value unavailable --yes --scope synonymdev
vercel deploy --prod --yes --scope synonymdev
```

## Restore Production Transactions

The current production transaction mode is `locks-paykit`.

```bash
vercel env update PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE production --value locks-paykit --yes --scope synonymdev
vercel deploy --prod --yes --scope synonymdev
```

## Move The Shop Domain Between Vercel Projects

Moving `shop.pubky.app` between Vercel projects is **not** a reassignment. The `pubky.app` DNS zone is external
(Namecheap), and its apex belongs to a different Vercel account; Shop is held by TXT proof. Each time Vercel attaches
the domain to a project, it mints a new `_vercel` TXT verification token. Detaching the domain from the current project
invalidates the token currently published in DNS.

There is no way to obtain the destination token in advance. Attaching the domain to a second project while the first
still holds it fails with `domain_already_in_use`, so the token only exists after the detach. **The move therefore
always takes the hostname offline**, from the moment of detach until the new TXT record propagates. Plan for that
window rather than trying to eliminate it:

1. Lower the TTL on `_vercel.pubky.app` well in advance (the observed TTL is 1800s).
2. Have the DNS owner at the keyboard before you start; the outage lasts exactly as long as they take to publish.
3. Detach from the current project, immediately attach to the destination, and read the minted token from the attach
   response (`verification[].value`).
4. Publish that exact token, confirm with `dig +short TXT _vercel.pubky.app` against both a public resolver and the
   authoritative nameservers, then call the verify endpoint and pin the alias.

Do not re-run the attach while waiting. Every attach and detach mints a fresh token and invalidates the record the DNS
owner just published. On 2026-09-08 that mistake turned a planned move into a two-hour outage.

Rolling back has the same cost as going forward: reattaching to the prior project mints its own new token and needs its
own DNS publish. Once you have detached, the fastest route back to a working hostname is usually to finish the move,
not to reverse it. Meanwhile the project's own `*.vercel.app` alias keeps serving, so Shop stays reachable there.

## Vercel Rollback Or Promote

Use `promote` when the target known-good deployment id or URL is known. Use `rollback` when reverting away from a known
bad deployment id or URL. Each release records the deployment that was on the alias before it
([`release.md`](release.md#deploy)); that id is the target. `vercel ls pubky-marketplace-production --scope synonymdev`
lists recent deployments, and `vercel inspect <url-or-id> --scope synonymdev` shows one.

Pre-launch, roll back only when data is being lost or money is moving wrongly, and always to the **previous**
known-good deployment, never the current one. After a `rollback`, the domain stays pinned: the next `vercel --prod`
aliases only the generic `*.vercel.app` name until you `promote` a deployment.

Runtime config is serialized into each deployment at build time, so `promote` re-points the alias to that deployment's
env snapshot in about 5 seconds with no build (measured in the 2026-09-06 drill). That makes `promote` the instant
**restore** path. It is only an instant **kill** path if an `unavailable` deployment built from the current client
already exists to promote; otherwise the env flip plus redeploy above takes about 3 minutes. An `unavailable`
deployment goes stale as soon as the client changes, so after each production deploy either re-create one or accept
the 3-minute kill latency.

From a checkout linked to `pubky-marketplace-production`:

```bash
vercel promote <dpl_id-or-url> --yes --scope synonymdev
vercel rollback <dpl_id-or-url> --yes --scope synonymdev
vercel alias ls --scope synonymdev | grep shop.pubky.app   # confirm where the domain points
```

For staging, run the same commands from a checkout linked to `pubky-marketplace-staging`.

## Verify The Kill Switch

Check the resolved runtime config and the rendered UI:

```bash
curl -fsS https://pubky-marketplace-production.vercel.app/marketplace | grep -o 'commerceAdapterMode[^,]*'
curl -fsS https://pubky-marketplace-production.vercel.app/marketplace/listing/<sellerPubky>/<listingId> | grep -o 'commerceAdapterMode[^,]*'
```

Expected user-visible behavior:

- Marketplace catalog shows: `Marketplace transactions are unavailable in this deployment. Public browsing remains
read-only.` (`src/components/templates/Marketplace/Marketplace.tsx`).
- Listing purchase controls are disabled and the page shows: `Transactions are disabled in this deployment.`
  (`src/components/templates/Marketplace/MarketplaceListing.tsx`).
- The marketplace nav entry is hidden when the adapter is `unavailable` (`isMarketplaceNavEnabled` in
  `src/components/molecules/Header/Header.tsx`, and `src/components/molecules/MobileFooter/MobileFooter.tsx`).

## Railway Service Restart And Rollback

The backend services run in the product owner's Railway account; these commands need access to it. Every project's
only environment is named `production`.

| Railway project                | Project id                             | Services the Shop uses                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pubky-marketplace-production` | `75faa4fe-466c-4277-977f-1d8e4e31df8c` | `marketplace-service`, `paykit-server`, their Postgres instances                                                                                                                                            |
| `pubky-marketplace-nexus`      | `af82731f-a6d0-4c0e-84cd-56ce6fcc8818` | `nexusd` (`nexusd-production-7108`), `neo4j`, `Redis`                                                                                                                                                       |
| `pubky-marketplace-staging`    | `c991d768-4a3c-42ea-b5ed-eaa22d4916ed` | Staging service and Paykit, regtest `bitcoind` and `fulcrum`, `fiat-verifier`, and the account's only `locks-server`. Both Shop builds point `locksUrl` at `https://locks-server-production.up.railway.app` |

The `nexusd` service inside `pubky-marketplace-production` is the retired `nexusd-production-95a0`, stopped with its
volumes kept. Do not restart or redeploy it; the live marketplace Nexus is in `pubky-marketplace-nexus`.

The Railway CLI has `restart`, `redeploy`, `deployment list`, and `down`; it does not have a `rollback` subcommand. For a
fast process restart without rebuilding:

```bash
railway restart --project 75faa4fe-466c-4277-977f-1d8e4e31df8c --environment production --service marketplace-service --yes
railway restart --project af82731f-a6d0-4c0e-84cd-56ce6fcc8818 --environment production --service nexusd --yes
```

To redeploy the latest successful deployment:

```bash
railway redeploy --project 75faa4fe-466c-4277-977f-1d8e4e31df8c --environment production --service marketplace-service --yes
railway redeploy --project af82731f-a6d0-4c0e-84cd-56ce6fcc8818 --environment production --service nexusd --yes
```

To roll back to an earlier build, list deployments, then use the Railway dashboard (service → Deployments → the
known-good deployment → `Rollback`). The CLI cannot target an older deployment: `railway redeploy` only re-runs the
latest one, and `railway down` removes the latest deployment and leaves the service with nothing running — it does not
fall back to the previous deployment, so never use it as a rollback.

```bash
railway deployment list --project 75faa4fe-466c-4277-977f-1d8e4e31df8c --environment production --service marketplace-service --limit 10
railway deployment list --project af82731f-a6d0-4c0e-84cd-56ce6fcc8818 --environment production --service nexusd --limit 10
```

CLI-only alternative when the dashboard is unavailable: check out the known-good commit on the service's deploy
branch, push it to the BitcoinErrorLog fork, then
`railway redeploy --from-source --project <project-id> --environment production --service <service> --yes`. The
service and Nexus repositories pin their images by digest in `.railway/railway.ts`; follow their READMEs for the
normal deploy path.

Read-only checks. **Never run `railway variables` bare, or with `--kv` or `--json` to a terminal:** every form prints
production secrets (database URLs, encryption and HMAC keys) in clear text. To see which variables are set, print the
key names only:

```bash
railway status --project 75faa4fe-466c-4277-977f-1d8e4e31df8c --environment production
railway variables --json --project 75faa4fe-466c-4277-977f-1d8e4e31df8c --environment production --service marketplace-service \
  | node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(0, "utf8"))).sort().join("\n"))'
railway variables --json --project af82731f-a6d0-4c0e-84cd-56ce6fcc8818 --environment production --service nexusd \
  | node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(0, "utf8"))).sort().join("\n"))'
```

Read a value only when a task needs it, in the Railway dashboard, and never copy it into a ticket, log or chat.

## Drill Log

| Date                       | Operator                            | Action                                                                                                        | Vercel deployment before                                                                    | Vercel deployment after                                                                                              | Railway action | Verification                                                                                                                                      | Notes                                                                                                                                                                                 |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-06 12:22–12:29 UTC | drill agent (Grok), parent-verified | env flip to `unavailable` + deploy; env restore to `locks-paykit` + deploy; `promote` of pre-drill deployment | `pubky-marketplace-production-43s5ujo0d` (`dpl_EAqqVuQq1BkstYJwwciMS3C981tv`, locks-paykit) | kill `…-doas1qo0r` (unavailable); restore `…-7i2qjho1y` (locks-paykit); alias finally promoted back to `…-43s5ujo0d` | none           | HTML `commerceAdapterMode` read `unavailable` after kill and `locks-paykit` after restore and after promote; parent re-checked alias at 12:29 UTC | kill latency 3m06s; env-restore latency 2m54s; promote 5s, no build. Banner text is client-rendered so `grep -c` on HTML returns 0; verify via `commerceAdapterMode` or in a browser. |
