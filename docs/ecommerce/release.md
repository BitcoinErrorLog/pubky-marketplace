# Shop Release Runbook

How a Shop release goes from merged pull requests to a proven deployment on <https://shop.pubky.app>. Production
operations (kill switch, rollback, Railway restarts, domain moves) are in [`runbook-production.md`](runbook-production.md).
Local setup is in [`onboarding.md`](onboarding.md) and [`RUNNING.md`](RUNNING.md).

"Live" means the signed-in production proof passed against the new deployment. A green build is not a release.

## Branches and targets

| Item               | Value                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release branch     | `master`, the repository default and the Shop line; every release ships from it. Releases up to `shop-v0.6.46` shipped from `release/shop-v0.6.8` in `BitcoinErrorLog/pubky-app`, whose history is part of this repository. |
| Train branches     | `train/shop-<YYYY-MM-DD>-<am\|pm>`, cut from the release branch head                                                                                                                                                        |
| Tags               | `shop-vX.Y.Z` on the deployed commit, with a GitHub release                                                                                                                                                                 |
| Production client  | Vercel project `pubky-marketplace-production`, team `synonymdev`, alias `shop.pubky.app`                                                                                                                                    |
| Staging client     | Vercel project `pubky-marketplace-staging`, team `synonymdev`, <https://pubky-marketplace-staging.vercel.app>                                                                                                               |
| Backend services   | Separate repositories, deployed separately: `pubky-marketplace-service`, the `pubky-nexus` fork, the `paykit-server` fork. See their READMEs.                                                                               |
| Unrelated branches | `pubchi/v1` is a different product. Do not base Shop work on it.                                                                                                                                                            |

## Tools

- Node from [`.nvmrc`](../../.nvmrc), `npm`, the GitHub CLI (`gh`), and Docker (the Linux VRT gate runs in a pinned
  Playwright container).
- The Vercel CLI (`npm i -g vercel`), logged in as a member of the `synonymdev` team.
- Playwright's Chromium for the production proof: `npx playwright install chromium`.
- At least 30 GiB of free disk before a VRT run or a release build; the VRT container and its screenshots need that
  headroom.

Install dependencies with `HUSKY=0 npm ci`. Husky's `prepare` script otherwise sets a repository-local
`core.hooksPath`, which silently replaces any global git hooks you rely on. Never `npm install` a package to fix a
missing dependency: fix `package-lock.json` in a pull request, then `HUSKY=0 npm ci` again.

## Day-to-day merges

1. Branch from the current train branch (or from the release branch if no train is open) and open the pull request
   against the train.
2. Before every push run `bash scripts/prepush.sh`. Fast mode (the default) runs `prettier --check` and `eslint` on
   files changed since the merge base, `npm run typecheck`, and `npx vitest related --run` on those files. The last
   line on success is `PREPUSH OK <sha> <seconds> fast`. A tree that already passed is not re-run.
3. Auto-merge is off in this repository. After pushing, wait for CI with `gh pr checks <N> --watch`, then merge with
   `gh pr merge <N> --squash` (train-to-release pull requests keep a merge commit: `--merge`). Merge only when every
   check passed or skipped, and never with `--admin`.
4. Required checks on `master`: Check Code Quality, Check NextJS Build, Run Shard Tests (1) to (5), Run Tests, Merge
   Coverage Reports, `vrt-marketplace`, `vrt-core`, `launch-e2e`. A pull request is required; no approving review is
   configured, so the team sets its own review rule. Force pushes and branch deletion are blocked. `launch-e2e` runs on
   pull requests into `master` and `release/shop-*` with the repository secret `LAUNCH_E2E_SELLER_SECRET_HEX`; it
   fails closed on a same-repository pull request if the secret is missing, and skips with a notice on fork pull
   requests. Pull requests that change only `docs/`, `payments-env/` or `*.md` files skip the build, the unit suite
   and VRT; their checks still report.

**Flake outside the diff.** If the only failures are test files the diff does not touch, rerun those files alone
twice. If both reruns pass and the rest of the gate passed, the push may skip the hook (`--no-verify`) with the gate
log and both reruns pasted in the pull request body. A failure in a touched file, typecheck, lint or VRT is never
skipped.

## Visual regression baselines

Linux baselines (`*-linux.png`) rendered in `mcr.microsoft.com/playwright:v1.60.0-noble` are the only merge gate.
Darwin PNGs are not required and are not regenerated.

- Run the gate locally with `bash scripts/vrt-linux.sh [spec...]` (no argument runs the whole Linux suite).
- Before any VRT run, the installed Playwright must equal the lockfile's:
  `node -p 'require("./node_modules/playwright/package.json").version'` against
  `packages["node_modules/playwright"].version` in `package-lock.json`. A mismatch renders every scene differently;
  discard any PNG produced while they differed.
- A feature pull request regenerates Linux baselines only for scenes it intentionally changed, once, after its last
  UI change, in one commit that contains only PNGs. Locally:
  `VRT_LINUX_UPDATE=1 bash scripts/vrt-linux.sh <spec...>` then `bash scripts/vrt-revert-outside.sh <spec...>`.
  In CI: run the **VRT Update Baselines** workflow on the pull request branch with the spec paths as `files`.
- `--update` rewrites every scene in the named files, and a path argument does not isolate it. Always run
  `vrt-revert-outside.sh`, then check `git status --short -- '**/__screenshots__/**'` and keep only the intended set.
- Never re-pin a scene the pull request did not touch. A failure on an untouched scene goes to the train owner with
  the scene name and the diff ratio.
- Calibrate every regeneration: open at least two new PNGs and confirm they show the intended state, confirm the kept
  files are distinct (`md5`), and treat a tiny full-viewport PNG as a blank frame.
- A change to `src/test/mocks/**` or `src/test-utils/vrt.tsx` changes every scene: run the full suite.

## Release train

At most one or two Shop releases a day. An extra cut runs only for a production P0 or P1 fix.

1. **Find the live release.** `gh release list -R pubky/pubky-marketplace --limit 1` gives the last `shop-vX.Y.Z`
   (`-R BitcoinErrorLog/pubky-app` for `shop-v0.6.46` and earlier).
2. **Close the train.** Open one pull request from `train/shop-<date>-<am|pm>` into `master`. A pull
   request that missed the cut waits for the next train. Nothing merges to the release branch outside a train.
3. **Baselines once.** If any merged change moved a scene, regenerate Linux baselines once on the train head (rules
   above), then run the full marketplace VRT suite once.
4. **Proof on the release head.** On the merged release branch commit, in a clean checkout:

   ```bash
   PREPUSH_FULL=1 bash scripts/prepush.sh               # last line must end in "full"
   npm run typecheck && npm run lint
   npm run test                                          # the whole unit suite; keep the summary lines
   bash scripts/vrt-linux.sh src/test/vrt/marketplace/   # the whole marketplace VRT suite
   npx prettier --check $(git diff --name-only --diff-filter=d shop-v<prev>..HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.md' '*.css')
   git status --short | wc -l                            # 0
   ```

   A proof is reusable only while no file has changed since it ran. A merge commit is a new source state.

5. **Check deployment config parity** before every deploy, for both Vercel projects. `vercel env ls` shows variable
   names and targets only (every value reads `Encrypted`), so names and values are checked separately:
   - **Names, per target.** From a checkout linked to each project, run `vercel env ls production --scope synonymdev`
     and `vercel env ls preview --scope synonymdev`. `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN` and
     `NEXT_PUBLIC_VIBE_ID` must not be listed for either target. A Preview build of a project that still has them
     ships with the session bridge on.
   - **Values, from what a deployment serves.** Public runtime values are inlined into each deployment's HTML, so
     read them there instead of pulling env (`vercel env pull` writes every secret to disk):

     ```bash
     curl -fsS https://shop.pubky.app/marketplace \
       | grep -oE '"(marketplaceNexusUrl|marketplaceUrl|locksUrl|paykitSetupUrl|homeserverUrl|commerceAdapterMode)":"[^"]*"'
     ```

     Repeat for `https://pubky-marketplace-staging.vercel.app/marketplace` and for any Preview deployment
     (`vercel ls <project> --environment preview --scope synonymdev` lists them). `marketplaceNexusUrl` must be
     `https://nexusd-production-7108.up.railway.app`; `https://nexusd-production-95a0.up.railway.app` is retired.
     A Preview target with no deployment has no served values; check it in the Vercel dashboard
     (Settings → Environment Variables) when one is about to be built.

   Env changes take effect only on the next deployment.

6. **Deploy** (next section), **prove** (the section after), then **tag and publish notes**.

## Deploy

A fresh clone or worktree is not linked to any Vercel project, because `.vercel/` is gitignored. Running
`vercel --prod` unlinked creates a new project named after the directory and leaves `shop.pubky.app` untouched. Link
first, every time you deploy from a new checkout:

```bash
rm -rf .vercel
vercel link --yes --project pubky-marketplace-production --scope synonymdev
cat .vercel/project.json            # must name pubky-marketplace-production
```

If a stray project was created, delete it with `vercel project rm <name> --yes`.

Record the deployment currently on the alias before deploying; it is the rollback target:

```bash
vercel inspect shop.pubky.app --scope synonymdev    # note the dpl_… id
```

Deploy with a fresh build cache. Corrupt caches have stalled builds at `Running TypeScript` for 40 minutes:

```bash
vercel --prod --yes --force --scope synonymdev 2>&1 | tee <evidence-folder>/deploy.log
```

A build takes about six minutes. Allow ten before treating it as stuck, and do not cancel earlier. On
`Error: Deployment not found`, run `vercel ls pubky-marketplace-production --scope synonymdev` before redeploying.

Confirm the alias moved: `vercel alias ls --scope synonymdev | grep shop.pubky.app` must show the new deployment.
After any `vercel rollback`, the domain stays pinned to the rolled-back deployment, and the next `vercel --prod`
aliases only the generic `*.vercel.app` name. Un-pin with `vercel promote <dpl_id> --yes --scope synonymdev` and
re-check the alias before proving anything.

**Pre-launch policy: fix forward.** Do not roll back for a failed proof or an ordinary incident. Roll back only when
data is being lost or money is moving wrongly, and then to the **previous** known-good deployment id, never the
current one. The commands are in [`runbook-production.md`](runbook-production.md#vercel-rollback-or-promote).

## Signed-in production proof

`scripts/release/release-proof.mjs` drives the deployed Shop in headless Chromium with two test seats and the same
`approveAuthRequest` call Pubky Ring and Bitkit's Paykit make. `scripts/release/production-paypal-fixture.mjs` wraps
it: it gives the seller seat a temporary PayPal rail and one `TEST, do not buy <run>` listing, runs the proof against
that listing, then always tears everything down and verifies the teardown. The proof alone takes about three
minutes; fixture setup and teardown add a few more.

### Inputs

All inputs are environment variables. Seat files, passphrases and the PayPal address never enter the repository, a
command line, or the evidence folder.

| Variable                                                      | Meaning                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROOF_SELLER_RECOVERY_FILE`, `PROOF_BUYER_RECOVERY_FILE`     | Encrypted `pubky.org/recovery` backups of the two production test seats                                                                        |
| `PROOF_RECOVERY_PASSPHRASE`                                   | Passphrase for those backups                                                                                                                   |
| `PROOF_SEAT_SECRET_HEX`, `PROOF_BUYER_SECRET_HEX`             | Alternative to the files: 32-byte seat secrets as hex (used for staging-homeserver seats)                                                      |
| `PROOF_SELLER_PREFIX`, `PROOF_BUYER_PREFIX`                   | Optional. The run stops unless each seat's pubky starts with this, which catches a swapped seat                                                |
| `PAYPAL_TEST_EMAIL`                                           | PayPal address for the temporary seller rail. Never logged or written                                                                          |
| `PROOF_EVIDENCE`                                              | Evidence folder for this release, outside the repository (the scripts refuse a path inside it)                                                 |
| `EXPECTED_DPL`                                                | The `dpl_…` id now aliased to the origin. The proof fails if production serves anything else                                                   |
| `PROOF_ORIGIN`, `PROOF_SERVICE`, `PROOF_NEXUS`, `PROOF_RELAY` | Optional overrides. Defaults: `https://shop.pubky.app`, the production marketplace service, Nexus `-7108`, `https://httprelay.pubky.app/inbox` |

The production seats belong to the product owner, who passes seat backups, the passphrase and the PayPal address out
of band. The seller seat owns the long-lived "Cutover test — do not buy" listings and must not buy its own listing;
the buyer seat runs checkout.

The capabilities the proof expects in the Ring QR are read from `CAPABILITIES` in `src/config/app.ts` of the checkout
you run it from, so run it from the release commit that was deployed (or set `PROOF_CAPABILITIES`).

### Run

```bash
export PROOF_SELLER_RECOVERY_FILE=/secure/path/seller.pkarr
export PROOF_BUYER_RECOVERY_FILE=/secure/path/buyer.pkarr
read -rs PROOF_RECOVERY_PASSPHRASE && export PROOF_RECOVERY_PASSPHRASE
read -rs PAYPAL_TEST_EMAIL && export PAYPAL_TEST_EMAIL
export PROOF_EVIDENCE=$HOME/shop-evidence/shop-vX.Y.Z/live-proof
mkdir -p "$PROOF_EVIDENCE"
EXPECTED_DPL=dpl_<new> node scripts/release/production-paypal-fixture.mjs proof -- \
  node scripts/release/release-proof.mjs | tee "$PROOF_EVIDENCE/run.log"
```

The release passes only when `release-proof.mjs` prints `RESULT PASS` and the fixture prints
`PAYPAL_FIXTURE proof OK`.

### What it checks

Step ids are stable across releases; 3 is unused.

| Step    | Checks                                                                                                                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | Production serves `EXPECTED_DPL`                                                                                                                                                                                                                               |
| 1       | Ring and Bitkit QRs are both live on `/sign-in`; the Ring QR is the cookie sign-in URL for the Shop's capabilities and is not in the DOM; one approval gives exactly one homeserver `POST /session` and one marketplace `POST /v1/auth/sessions`, and no grant |
| 2       | The Bitkit QR is a `signin_grant` for the Shop's capabilities and client id `shop.pubky.app`; approval signs in with a grant record; reload restores it; sign-out from Settings clears it and holds across a reload                                            |
| 4       | The buyer seat reaches checkout on the fixture listing; `payment-config` loads; PayPal is offered; no "no payment method" copy; nothing is paid and no order command is sent; the cart is emptied; the buyer signs out                                         |
| 5       | Activity is in the marketplace nav, has no unrecognized events, lists order rows, and a row opens its order card on the Orders page. If the seller's rows only point at orders its Orders page hides, the buyer seat is used                                   |
| 6       | Sign-out of the Ring session from Settings clears the Shop state, ends the homeserver session (`DELETE /session` 2xx), and holds across a reload                                                                                                               |
| cleanup | Every marketplace session either seat gained during the run is revoked, the audit bearer last, and none remain                                                                                                                                                 |

A full pass is 34 checks, or 39 when step 5 falls back to the buyer seat. Rows reported as `KNOWN` are informational
defects outside the release and never gate it.

### Reading the result

- `proof-log.txt`: one PASS or FAIL line per check.
- `results.json`: `steps`, `sessionAudit`, `knownDefects`, network tags and console errors. Every
  `sessionAudit[].activeFromRunAfter` must be empty.
- Screenshots `01`–`08` and `11`.
- Evidence carries 8-character pubky prefixes only. Auth URLs, session exports and bearers are never printed.

The fixture changes the seller seat's PayPal rail only for the run. Setup records the rail's current value in
`paypal-fixture-state.json` (mode 600) before changing it, and teardown restores exactly that value and reads it back.
When the prior value is the test address itself, only a marker is stored, so the address never reaches disk. Without
a state file, `teardown` and `verify` change and check nothing.

If the run fails or is interrupted, `paypal-fixture-state.json` stays in the evidence folder. Retry the cleanup with
`node scripts/release/production-paypal-fixture.mjs teardown` (same environment, including `PAYPAL_TEST_EMAIL`) until
it prints `PAYPAL_FIXTURE teardown OK`; the state file is then deleted. Do not add checks that pay or create orders.

**Never leave a test listing behind.** Any run that creates a listing on production or staging (both feed the same
marketplace Nexus) keeps the seat key it published with until cleanup is done, deletes the listing before it ends,
including on failure or interrupt, and verifies it is gone: Nexus listing detail 404, service projection 404 or zero
stock, no homeserver record. A throwaway seat's secret is kept in a mode-600 file outside the repository until that
verification passes, never only in process memory. A listing that could not be deleted is reported by id in the
release notes and removed before the next release.

### Staging

The staging Shop signs out accounts that live on the production homeserver, so a staging run needs seats created on
`homeserver.staging.pubky.app` (signup tokens come from the staging homeserver admin; ask the team), passed as
`PROOF_SEAT_SECRET_HEX` and `PROOF_BUYER_SECRET_HEX`, with `PROOF_ORIGIN=https://pubky-marketplace-staging.vercel.app`
and `PROOF_SERVICE=https://staging-api.pubky.app`. Step 4 also needs `PROOF_PAYPAL_LISTING_URL` pointing at a
"do not buy" listing whose seller has a PayPal sandbox rail; without it step 4 fails. Production is the release gate.

## Tag and release notes

There is no `CHANGELOG.md`. Each user-visible change adds a fragment `changelog.d/next/<issue>.<kind>.md`. Fragments
are not consumed: a later release may extend a fragment for the same issue. The notes for a release are the fragments
added or changed since the previous tag:

```bash
git diff --name-only shop-v<prev>..HEAD -- changelog.d/next
git tag shop-vX.Y.Z <deployed-sha>
git push origin shop-vX.Y.Z
gh release create shop-vX.Y.Z -R pubky/pubky-marketplace --title "Shop vX.Y.Z" --notes-file <evidence-folder>/notes.md
```

The notes carry the version, date, exact commit, Vercel deployment id and URL, one line per user-visible change, the
backend deploys the release depends on (for example `marketplace-service <sha>`), known limitations, the proof result
(`RESULT PASS n/n`), and a tester notice:

- `Tester notice: log out and back in once.` when the release bumped the local database version
  (`git diff shop-v<prev>..HEAD -- src/core/database/franky/franky.ts`, or any `Dexie.version`, `declaredVersion` or
  `DB_VERSION` change).
- `Tester notice: reload is enough.` otherwise.

## Backend releases

The marketplace service, the Nexus fork and the Paykit server release from their own repositories: build the GHCR
image, pin its digest in the repository's Railway infrastructure file (`.railway/railway.ts`), confirm a
`railway config plan` shows no unexpected change, deploy, then check health. See each repository's README and
`.railway/README.md`, and the Nexus fork's `docs/railway-deploy.md`. The services currently run in the product
owner's Railway account, so backend pull requests merge on GitHub and the owner deploys them.
