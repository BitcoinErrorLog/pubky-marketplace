# Pubky single sign-on

Sources, read on 1 Oct 2026: [pubky/pubky-core](https://github.com/pubky/pubky-core) `23cf059` (v0.14.0: homeserver, SDK, `docs/AUTH.md`, `docs/v0.10-migration/grant-auth.md`), [pubky/pubky-ring](https://github.com/pubky/pubky-ring) `83834e7`, [pubky/pubky-passport](https://github.com/pubky/pubky-passport) `fb10f45`, [pubky/paykit-rs](https://github.com/pubky/paykit-rs) `eed63f3`, [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) `4096f76`, [pubky/pubky-app](https://github.com/pubky/pubky-app) `b761c43`, and the Shop fork [BitcoinErrorLog/pubky-app](https://github.com/BitcoinErrorLog/pubky-app/tree/release/shop-v0.6.8) `release/shop-v0.6.8` `0942682`. No `pubky-social-specs` repository exists under `pubky` or `BitcoinErrorLog`.

## Answer

Identity is the user's key. Authorization is a grant: a statement signed by that key, giving one app's own key a set of capabilities. A session is just an app holding its grant and its key; the one-hour bearer is a cache. The single "signed in" state belongs **in the browser, on one dedicated account-agent origin** (Pubky Passport), held as a grant that the signer issued to the agent, with permission to issue narrower grants to individual apps. The signer (Ring, Bitkit, or Passport's own key) remains the only source of authority and is asked **once per browser**. The homeserver remains the verifier and the revocation authority. Every app keeps its own grant. The root fix is in the auth model, and the homeserver and SDK own it: **one level of delegable grants** (a `d` capability action, child grants signed by the delegate's key, cascade revocation), plus a **client id the agent verifies from the browser origin** instead of one the app declares. Messaging's cookie dependency is an accident of our pinned `paykit-wasm` (pubky 0.8, with its own HTTP client). The fix is moving Shop messaging to the shared pubky-chat library (MLS), which borrows the host app's grant session (E1). Paykit keeps Encrypted Links for payments and needs no browser package. Cookies go away. Encryption keys for private data travel beside the grant, never inside it: the signer derives stable keys scoped to the grant's paths and delivers them in the encrypted relay payload (K6). To be decisive: change the homeserver and SDK first, because that is the root; make Passport the agent; move messaging to pubky-chat, which is a prerequisite for leaving cookies but not the root; and make small changes to Ring's consent and session screens. Ring doesn't need a redesign.

## 1. Facts from the code that drive the design

**Grants are the right primitive, and nearly complete.**

- A grant is a user-signed JWS: `{iss, client_id, caps, cnf, jti, iat, exp}` (`pubky-common/src/auth/grant.rs`).
- The app exchanges it, with a proof-of-possession (PoP) signed by the `cnf` key, for an opaque one-hour bearer (`homeserver/.../auth/grant/mod.rs`).
- The homeserver stores the grant and checks it is not revoked on **every** request. Private event streams close when their grant is revoked (`auth/revocation/`).
- The SDK's default grant lifetime is **2 years** (`sdk/.../grant/constants.rs`).
- A grant can have **only one live bearer**.
  - `replace_for_grant` deletes every session for the grant, then inserts the new one, in one SQL statement (`grant/persistence/grant_session.rs`, the same in v0.11.0 and v0.14.0 `main`).
  - `MAX_SESSIONS_PER_GRANT` appears only in comments and tests; no such limit exists in the code.
  - Consequence: two tabs that restore the same grant through `browserSessionStore.restore()` invalidate each other's bearer, and retrying a restore after a 401 makes them alternate.
  - vlada found and reported this in #pubky-core on 21 Sep, while planning pubky.app's grant migration. [pubky/pubky-app#2614](https://github.com/pubky/pubky-app/issues/2614) records that the homeserver team confirmed the limitation and offered a fix.
- Listing or revoking a user's grants **requires a root capability**. An app can only revoke its own grant (`DELETE /auth/grant/session`, `grant/routes.rs`).
- `client_id` is self-declared: "the security boundary is capability scoping, not `client_id`".
- A grant has no audience, so it can be exchanged at any mirror.
- **No delegation.** A grant must be signed by `iss` itself. `docs/AUTH.md` defers delegation because a verifier would need an async certificate lookup to check revocation. Under grant auth that objection is gone: the homeserver already stores every grant, so checking a parent grant is a local lookup.

**Cookies are an ambient credential.**

- There is one cookie per homeserver host and user in a browser, and every origin rides it.
- The last sign-in sets the capabilities for everyone. That is the clobbering the Shop documents in `src/config/app.ts`.
- The cookie is third-party to every app origin outside `pubky.app`.
- The homeserver guide marks cookie auth "deprecated and scheduled for removal".

**The apps.**

- **pubky.app (`main`)** still signs in with cookies: `signinCookie`, `startCookieAuthFlow`, commented "grant-auth migration is tracked separately" (`core/services/homeserver/homeserver.ts`).
  - Its capabilities are `/pub/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r`.
  - Locks has its own iframe sign-in to the Lock Server.
- **pubky.app's grant migration is draft PR [#2614](https://github.com/pubky/pubky-app/issues/2614)** (vlada, open against `dev`, updated 28 Sep).
  - New Ring, encrypted-file, recovery-phrase and sign-up logins get SDK grants. Valid existing cookie sessions keep restoring. There is no new cookie login and no fallback to cookies.
  - Ordinary Ring login requests only `/pub/pubky.app/:rw`. Locks asks for `/priv/social/:rw,/priv/locks.app/:r` when it needs them, through a step-up that replaces the grant on the same account.
  - The client id comes from runtime config (`PUBKY_RUNTIME_AUTH_CLIENT_ID`, for example `staging.pubky.app`). A restore is refused if the stored grant's client id differs.
  - Grant secrets stay in the SDK's `browserSessionStore`; app storage holds only public references. Account changes are serialized across tabs with Web Locks and generation checks. There is no restore-on-401 loop.
  - It stays in draft until three gates pass:
    1. The deployed homeserver allows several bearers per grant.
    2. A failed bearer can't fall back to an ambient cookie. SDK 0.11 sends browser credentials, so another app's broad cookie could still authorize the request.
    3. Ring Android and iOS builds that ship grant auth exist. Met: Ring [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct) is out on Android and iOS (James, 7 Oct). v1.19 on Android shipped a pre-0.10 native library that rejects grant deep links ([#375](https://github.com/pubky/pubky-ring/issues/375)); its users update.
- **The Shop:**
  - Ring users get a cookie with `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw`.
  - Bitkit users get a grant session (`client_id` `shop.pubky.app`, non-extractable key).
  - The marketplace service authenticates a legacy `AuthToken`, whose bytes are posted to both the homeserver and the service ([`single-approval.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/single-approval.md)).
  - A purchase approval after sign-in is a `signin_grant` link since [pubky-marketplace#94](https://github.com/pubky/pubky-marketplace/pull/94) (merged, next Shop release), whichever way the user signed in. It needs Ring 2.0 or later, or Bitkit; Ring 1.19 users just need to update. A Ring 1.19 sign-in already creates the purchase session, so those users can still buy straight after signing in. Accounts created with the Ring sign-up QR need one sign-in with Ring.

**The signers.**

- **Ring's grant auth is released in v2.0.**
  - Ring approves `signin_grant` from [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct), which contains [pubky-ring#360](https://github.com/pubky/pubky-ring/issues/360) (merged 3 Sep) and adds grant management ([#369](https://github.com/pubky/pubky-ring/pull/369)).
  - [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) (4 Sep) signs in with cookie auth only, on Android and iOS ("v1.19 did not ship with grant auth", [#375](https://github.com/pubky/pubky-ring/issues/375)).
  - v2.0 is out on Android and iOS (James, 7 Oct). Users on 1.19 just need to update.
  - Its consent title shows `x-source`, which the app declares; `client_id` is not displayed at all (`screens/ConfirmAuth.tsx`).
  - Its auto-auth setting approves every request with no screen (`utils/actions/authAction.ts`).
    - It is a developer setting: off by default, in a hidden settings section opened by double-tapping the header.
    - It is not compiled out of release builds, so the only ask is that it can't ship reachable or enabled.
  - It holds its own root session per pubky but has no screen to list or revoke grants.
- **Passport** keeps the user's root key in browser storage on `passport.pubky.app`.
  - It reads the request from the URL fragment and shows the callback host, which the app declares.
  - It approves any app. It has no remembered consent and no check of which origin opened it.

**Messaging.**

- **Our `paykit-wasm`** is pinned to pubky 0.8.
  - Its session is the cookie, sent with `credentials: include` (`paykit-wasm/src/session.rs`).
  - It uses the session only for authenticated PUT and DELETE under `/pub/paykit/`; all reads are public.
- **Upstream `paykit-sdk`** is on pubky 0.12 and accepts any `PubkySession` through `PubkySessionProvider`.
  - It runs one runtime per app, with that app's own receiver folder: `/pub/paykit/v0/{app}/{wallet|server}` and `/pub/paykit/v0/private/{app}/...`. The Shop's folder is `marketplace/wallet`.
  - It ships no WASM binding.
- **The receiver marker that publishes an app's Noise key is unsigned.** It is trusted only because the folder can be written by nobody but its owner (`paykit-lib/src/receiver_marker.rs`).
- **Upstream Paykit since rc59 (Ben, 2 Oct).**
  - State is shared across all of an identity's apps by design. App ids route; they don't isolate. Narrowing a scope therefore can't isolate one app's messaging.
  - The Noise key is published in an App Registry. [pubky/paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169) (open; shipped in the rc60–rc62 prereleases) signs it with the identity key, at a path ordinary Paykit sessions can't write. That closes the registry key swap. The handshake gap we raised is closed (3 Oct): Ben's commits `4eda7102` and `73345917` check the peer's static key against the signed key before any transport use, on handshake completion and on restore. A mismatch fails into recovery-required, and substitution tests cover both roles and restored links. rc60 pins pubky-noise at revision `42e00f22`, so [pubky-noise#39](https://github.com/pubky/pubky-noise/issues/39) no longer gates it.
  - Paykit ships no WASM package and no custom-message API, and plans neither. Browser payments need only a public read.

**Private-data keys (Andrei, 2 Oct).** The SDK is gaining stable keys derived from the user's root and scoped to paths (K6, in progress):

- an exact-file scope (`/pub/app`) gets an exact-file key, and a directory scope (`/pub/app/`) gets a subtree seed. Neither reaches `/pub/app-evil`;
- `/pub/` and `/priv/` derive separate trees, and `/priv/` adds the homeserver's access control;
- the root derivation uses a dedicated namespace;
- there is no purpose API: apps derive separate encryption, HMAC or X25519 keys from their seed with HKDF and their own versioned labels;
- random data-key wrapping is optional and not implemented in the SDK;
- no delegated grants are designed in this work.

**The SDK draft ([pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668), 6 Oct)** implements this, with three details that matter for the agent:

- the signer sends an approval signed by the user's identity key, holding the grant and a key bundle. The app checks that signature against the grant's issuer, so only a holder of the root can produce one;
- the bundle keeps directory seeds inside it, and apps derive keys for file paths only (`deriveEncryptionKey(path)`). Apps get file keys, not seeds;
- a bundle can't be narrowed. Its holder can derive file keys, but can't hand a narrower bundle to another app.

**Version skew.** Core `main` is 0.14.0. Both apps are on SDK 0.11.0. Upstream Paykit is on 0.12. Our fork is on 0.8.

## 2. Principles

1. **The key is the identity and the only source of authority.** Nothing acts as the user unless the user's key delegated it, in a statement anyone can verify.
2. **One grant per app.** Each app has its own key, capabilities and revocation. Apps never share a credential, and nothing is ambient.
3. **The app's identity is verified, not declared, wherever the channel allows it.**
   - Web: the browser reports the requesting origin.
   - Native apps: verified app links.
   - Where it can't be verified (a QR scanned on another device), the signer says so.
4. **Only a party that can verify the requester may remember consent.**
5. **The homeserver verifies and revokes.** It doesn't hold the signed-in state and never signs for the user.
6. **Delegated power is bounded:** a capability ceiling, one level deep, an expiry no later than the parent's, and cascade revocation.
7. **Libraries borrow the host app's session.** They never own a credential.
8. **Services rely on the app's grant,** checked with a PoP addressed to them, not on a second sign-in.

## 3. Where the signed-in state lives

| Candidate | Why not, or why |
|---|---|
| Signer | It is the authority, but it usually sits on another device and can't see which origin asked. If it remembered consent, anyone claiming a name in a QR would get a silent approval. It is asked once per browser, never per app |
| Homeserver | It is cross-origin to every app. A homeserver sign-in is a cookie (being removed) or partitioned storage. Users can have mirrors. It would make the storage provider an identity provider |
| A product app as broker (pubky.app) | The right shape on the wrong origin: it renders user content, the largest surface for injected script, and it would hold minting power |
| **Browser, on one dedicated agent origin** | **Chosen.** The browser is the only party that can attest which origin is asking. Passport already is a web signer at `passport.pubky.app`. It is same-site with first-party apps and has a popup flow for the rest |

## 4. Target architecture

**Update 8 Oct.** Severin's objection to the delegable child grants below: grant sessions are built to be non-extractable from browsers, and a grant that can mint further grants "basically invites hackers". He has asked Marcos and tomos for a design that balances this. tomos's draft [pubky-homeserver#681](https://github.com/pubky/pubky-homeserver/pull/681) is that candidate: a *session agent* page on a dedicated same-site origin holds the one grant session, and allowlisted first-party apps (pubky.app, the Shop) embed it in a hidden iframe and receive bearers over `postMessage`; the grant and PoP key never leave the agent. It is option B1 (one `client_id`, the union of capabilities, one session-list entry), with per-app grants possible later behind the same app-facing API. The Shop follows whichever the homeserver team adopts, and delegation stays only as the open option for third-party apps, if at all. Our questions to tomos are on [#681](https://github.com/pubky/pubky-homeserver/pull/681#issuecomment-6057868388): the Shop's future Synonym-hosted origin (same-site or not), how `e` keys from #668 reach apps through the agent, and who hosts the agent page. Sections 4–5 below describe the delegation design as proposed; read H1, K1 and K3 as superseded by #681 if it lands.

**Parts.**

- The **signer** issues an **agent grant** to the agent's non-extractable key.
  - Its capabilities carry a `d` action, for example `/pub/pubky.app/:rwd`, meaning "may grant `rw` under this scope to another key".
  - The `d` scopes are the **ceiling**.
- The **agent** (Passport) holds that grant and issues **child grants**:
  - one per app;
  - each bound to that app's own non-extractable PoP key;
  - with `client_id` set to the origin the browser reported;
  - with capabilities within the ceiling and no `d`, and an expiry no later than the parent's.
- The **homeserver** verifies child grants against their parent and records the link. Revoking a parent revokes its children.
  - A homeserver that doesn't support this rejects child grants, because the signature isn't `iss`'s. It fails closed.
- **Services** (marketplace, Locks, Paykit server) verify the app's grant, plus a PoP whose audience is the service. They require a capability that names them.

**The ceiling grows with use.** The agent first asks for the requesting app's scopes plus the first-party set. When an app asks for something outside the ceiling, the agent asks the signer to extend it, and Ring shows the added scopes. The browser's minting power grows only as far as the user has actually used it.

### Sign-in (first app, new browser)

1. The Shop creates its PoP key and a normal `signin_grant` request: client id, its public key, scopes, relay.
2. It hands the request to the agent:
   - first-party: a hidden iframe;
   - third-party: a popup opened on click.
3. The agent records the browser-reported origin. It refuses if the client id doesn't match that origin.
4. The agent has no grant yet. It shows "Sign in with Pubky": Ring (a QR, or a deep link on mobile), Bitkit, or Google.
5. The signer shows a distinct screen: "Let this browser sign you in to apps, up to: *ceiling*. Expires *date*." **This is the one approval.**
6. The agent signs the Shop's child grant and posts it to the Shop's relay channel. The Shop's existing `awaitApproval` exchanges it. If the grant covers a `/priv` scope the user approved for decryption, it should also deliver that scope's keys beside the grant (K6). The SDK draft ([pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668)) can't do that yet: key approvals must be signed by the identity key, and the agent's bundle can't be narrowed. How the agent delivers keys to child apps is an open question (§7, Q12).
7. The marketplace service accepts the same grant with a PoP addressed to the service. There is no second token and no dual post.

### Second app (pubky.app, same browser)

- pubky.app creates its key and request and asks the agent through a same-site iframe.
- First-party consent is preset for verified origins, so the agent signs immediately. **The user does nothing.**
- A third-party app gets a popup with one click ("Allow example.com: `/pub/example.com/:rw`"). After that the popup opens and closes by itself.
- An app asking for a scope outside the ceiling triggers a signer prompt, the step-up described above.

### New device or browser

- The agent there is empty, so there is one signer approval:
  - a QR from desktop;
  - a same-device deep link on mobile;
  - a Google restore for Passport users.
- After it, every app works. Each browser is one agent grant, listed in Ring as, for example, "Passport · Chrome on macOS", and revocable on its own.

### Revocation and sign-out

- **Sign out of one app:** the app revokes its own grant (exists today) and clears its store.
- **Sign out of this browser:** the agent revokes its grant, and every child grant falls with it.
  - Apps fail on their next request, because the homeserver checks the grant on each one.
  - Private streams close.
- **Sign out everywhere:** Ring uses its root session to list all grants, grouped by parent, and revokes them.
- **Revocation doesn't reach keys.** Revoking a grant stops the app's future `/priv` reads. It can't invalidate a key or ciphertext the app already downloaded. Access control protects data from revoked apps, and encryption protects it from the operator. Revoking cryptographically means rotating: the app re-encrypts under a new random data key, wrapped under its scoped key.

### Encryption keys beside the grant (K6)

- **Derivation.** The signer, which holds the root, derives stable keys scoped to paths. Scope matching follows the capability rules: a file scope gets a key for that file only, and a directory scope gets a subtree seed for everything below it.
- **Delivery.** The key travels beside the grant, in a signed approval inside the relay payload. It is never inside the grant JWS, which the homeserver stores. Apps opt in per sign-in with the V1 approval format. In the SDK draft ([pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668)), the payload was sealed with HPKE to an app-held recipient key (`ek=` in the link, 6 Oct), so a leaked QR or link couldn't open it. **Update 8 Oct:** HPKE and the recipient key are being removed from #668 to keep it reviewable ([comment](https://github.com/pubky/pubky-homeserver/pull/668#issuecomment-6057852544)); it merges on the existing shared-secret relay flow (HPKE removal pushed at `c45ec2c9`), so until the follow-up lands, whoever holds the link secret can also open the key bundle. The follow-up is tracked as [pubky-homeserver#682](https://github.com/pubky/pubky-homeserver/issues/682) (Andrei, 8 Oct). The Shop treats that follow-up as a prerequisite for relying on `e` keys for buyer data.
- **Rule.** **Explicit `e` permission (7 Oct, [#668](https://github.com/pubky/pubky-homeserver/pull/668#issuecomment-6035403798)).** Keys are delivered only for scopes that carry the new `e` action. `r` and `w` no longer deliver keys, and `e` grants no storage access (`/pub/chat/:rwe` = storage plus keys, `/pub/chat/:e` = keys only). Signers may approve storage while declining `e`. Upgrade order: the homeserver first (older homeservers reject grants that carry `e`), then apps and signers together (older signers fail closed on `:rwe`, and approvals from the earlier draft are rejected on restore). Our apps request: the Shop `/priv/pubky.app/marketplace/:rwe`, chat `/priv/chat/v1/:rwe`; every other scope stays `r` or `rw` without `e`. A backup or mirror app requests `/:rw` and never sees plaintext.
- **Agent custody.** Deferred by Andrei to a later `v2` (7 Oct); until then Passport is designed around per-app key requests to the signer. Q12 background: The agent can hold a key bundle for the `/priv` scopes the user approved for decryption and derive file keys from it. In the SDK draft, it can't pass keys on to child apps: approvals must be signed by the identity key, and bundles can't be narrowed. The options are an agent-signed approval that carries a narrowed bundle (an SDK addition that depends on H1), or sending each child app's key request to the signer.
- **Purposes.** The SDK derives one stable key per file path and has no purpose labels. Each app derives the file key of a fixed path it chooses, then separate encryption, HMAC or X25519 keys from it with HKDF and its own versioned labels. It wraps random data keys under them rather than encrypting with the scoped key directly, which keeps rotation possible.
- **Recovery.** The keys come back from the user's pubky backup. Data comes back only if its ciphertext survives at its original paths, so apps keep encrypted paths stable.
- **What it doesn't do.** No delegated grants are designed in the key work. Delegation (H1) is still core's open item (§7, Q1).

### Messaging

- **Messaging moves to the shared pubky-chat library on MLS** ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)). The Shop adopts it in E1. Paykit keeps Encrypted Links for payments.
- **The library borrows the host app's grant session.** It never restores, refreshes or signs it out, because a library that restores the app's grant itself evicts the app's bearer (the one-bearer-per-grant rule).
- **"Messaging only works with cookie sessions" is not a protocol constraint.** The cookie was the one credential a separately compiled WASM module on pubky 0.8 could reach.
- **Until E1, Shop messaging stays on Ring cookie sessions.** E1 is what brings messaging to Passport and Bitkit users.
- **Withdrawn (Ben, 2 Oct):** the Paykit storage interface (Y1), the WASM package (Y2) and a custom-message API. Payments need nothing in the browser except a public read, and chat doesn't run on Paykit.
- **Dropped: Paykit scope narrowing.** Paykit state is shared per identity by design, so a folder scope can't isolate an app. Today any app holding `/pub/paykit/:rw` can rewrite the Shop's unsigned receiver marker. That ends when the Shop drops `/pub/paykit/:rw` after E1.
- **Signed Noise keys (formerly Y3)** are upstream in [pubky/paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169). They close the registry swap for Paykit's own links, and since 3 Oct the handshake checks the peer's static key against the signed key, on completion and on restore.

### Phishing (an origin claiming to be another app)

- **Web:** the agent takes the client id from the browser-reported origin. evil.com can only obtain grants labelled evil.com, for scopes the user approves for evil.com.
- **Native apps:** a verified app link for the return.
- **A QR scanned on another device can't be bound to an origin.** Anyone can relay a genuine QR in real time.
  - Contain it: QRs are used only for the once-per-browser agent grant, on a distinct screen showing the ceiling and expiry.
  - Ring marks the client id "unverified".
  - Auto-approval never applies to agent grants. Ring's developer-only auto-auth must stay unreachable in release builds.
- **Script injected on the agent origin:**
  - The agent is a small static app with a strict CSP and no user content.
  - Grant power is capped by the ceiling and revocable as one unit.
  - Confidentiality is not revocable. Key bundles the script reads stay leaked until the affected apps rotate their data keys. This is why the agent would hold keys only for scopes the user approved for decryption (Q12).
  - That is a smaller hot credential than either thing it replaces: today's cookie, which every origin rides, and Passport's root key in browser storage.

### Browsers and mobile

- **First-party apps (`*.pubky.app`)** are same-site with `passport.pubky.app`, so the iframe's storage isn't partitioned. Sign-in is silent.
- **Third-party apps:** Chrome, Firefox and Safari partition iframe storage, so they use the popup, which is top-level.
- **Safari's tracking protection** deletes script-written storage, including IndexedDB keys, for a site with no user interaction for 7 days of Safari use. The agent's and the apps' keys can vanish, which costs one re-approval. Visits to any `*.pubky.app` site count as interaction with `pubky.app`.
- **Mobile browsers** work the same way, with a same-device deep link to Ring that returns to the agent.
- **Native apps** call the signer directly.
- **Multiple tabs** of one app share one grant. That needs the multi-tab fix below.

### Prerequisite: several tabs on one grant

**The problem (vlada, #pubky-core, 21 Sep).**

1. Tab A restores the grant and gets bearer A.
2. Tab B restores the same grant and gets bearer B. The homeserver deletes bearer A.
3. Tab A's next authenticated write gets a 401, although the grant is still valid.
4. If tab A restores again, it kills bearer B, and the two tabs keep invalidating each other.

This is the first thing any grant-only web app hits. pubky.app's #2614 and the Shop both depend on it, and so does every app the agent signs in.

**Recommended fix: the homeserver allows several live bearers per grant (H5).**

- `replace_for_grant` keeps up to `MAX_SESSIONS_PER_GRANT` sessions per grant, a small bound such as 8. Beyond the bound it evicts the oldest, in the same single atomic statement.
- Revoking a grant still deletes all of its sessions.
- Each tab mints and refreshes its own bearer with a PoP from the shared non-extractable key. The SDK's existing per-session refresh lock already serializes refreshes inside one tab.

**Why this rather than one tab owning the bearer and sharing it** (leader election with a BroadcastChannel, or a SharedWorker):

- **Browsers freeze or discard background tabs,** on mobile especially. A leader tab that is frozen or closed stalls every other tab until someone else takes over, and the takeover mints a new bearer anyway.
- **A SharedWorker isn't available in Chrome on Android.**
- **Every app, and every library that borrows the session, would have to implement the same election and handoff.** The homeserver fix is one change, in one place, that every client gets for free.
- **Sharing gains no security.** Every tab has the same origin and the same key, so copying one bearer to all of them protects nothing that per-tab bearers expose.
- **Revocation is unchanged:** it is still per grant, and immediate.
- **The homeserver team has already agreed.** According to #2614, the homeserver team confirmed the limitation and offered this fix.

**A second prerequisite from #2614: a bearer request must never fall back to a cookie (H6).**

- While legacy cookies exist (any app's, including the Shop's Ring cookie), a request whose bearer is missing, expired or revoked must not be authorized by the cookie the browser attaches.
- The homeserver should ignore cookies on any request that carries `Authorization`. The SDK should send grant-session requests without browser credentials.

### Alignment with pubky.app's migration (#2614)

**[#2614](https://github.com/pubky/pubky-app/issues/2614) is pubky.app's half of moving off cookies, and it fits this design:**

- one grant per app;
- no new cookies;
- secrets kept in the SDK store;
- per-app client id;
- step-up for extra scopes;
- release gates that are exactly H5, H6 and R0.

It works before the agent exists: Ring signs pubky.app's grant directly, one approval per browser. When the agent ships (P1), only how the grant is obtained changes, from a direct Ring request to an agent request (A2).

**Points to settle with vlada:**

1. **The client id must equal the origin host** (`pubky.app`, `staging.pubky.app`). The agent will set the client id from the verified origin. #2614 refuses to restore a grant whose client id differs from the configured one, so a different configured value would force every user to re-authorize at the switch.
2. **Locks paths.** #2614 uses `/priv/locks.app/` for creator originals, where `main` uses `/priv/app.locks/content/`. The Shop's scope-union stopgap must follow the final path.
3. **Recovery-phrase and file logins** produce a root grant inside pubky.app. Under this design the key belongs in a signer, which can be Passport, so long term those logins should move to Passport and pubky.app should hold only its scoped grant.
4. **SDK gaps** #2614 works around, which are asks for core (K4):
   - SDK 0.11 can't delete one abandoned delegated proof key by attempt;
   - "missing record" has no structured error;
   - `list()` hides IndexedDB errors.

## 5. Why the alternatives are worse

- **Keep cookies, or lend `*.pubky.app` hostnames.** The credential is ambient. Every site shares one capability set, and the last sign-in clobbers it. Off-domain sites break on Safari. Cookie auth is deprecated.
- **A Ring bundle: a bundle of grants approved once at sign-in.** Rejected. It covers only the apps present and coordinated at sign-in:
  - each app must host a companion frame for every other app;
  - third-party companions are partitioned;
  - a new app, a new scope or a lost session goes back to the signer.

  It is consent to several apps at once, not single sign-on. Needing no homeserver change is its only advantage.
- **The signer remembers consent or auto-approves.** The signer can't verify a requester through a QR, so this turns claiming a name into getting a silent grant. Ring's auto-auth is a developer setting, off by default, not a product feature.
- **The signer is pushed each request and auto-signs.** The phone must be online for every new session, and it needs push infrastructure. It makes the cold key a remote signing service. It still needs a browser-side party to attest the origin, which is the agent anyway.
- **A user session at the homeserver issues grants.** This means a cookie or partitioned storage again. It doesn't carry to mirrors. It makes the storage provider an identity provider.
  - A *mediated* variant is acceptable: the agent presents its own grant session and the homeserver records the child.
  - Signed child grants are preferred, because services and mirrors can verify them offline (§7, Q1).
- **Root key in the browser for everyone** (Passport's model, applied to all users). It needs no protocol change but abandons the cold-key model for Ring users.
- **pubky.app as the broker.** The most injectable origin would hold minting power, and SSO would depend on one product.
- **A separate sign-in for services** (today's `AuthToken` dual post, or a second grant for the service). It costs either a second consent or a widened token in flight. The app's grant already identifies the user to the service.

## 6. Changes per repo

Sizes describe technical scope, not time:

- **S:** one component, no wire change.
- **M:** several modules or a new UI surface in one repo; any wire change is additive.
- **L:** a protocol change with new verification rules, a persistence migration and coordination across repos.

| # | Repo | Change | Owner | Size |
|---|---|---|---|---|
| H1 | pubky-core homeserver | **Delegable grants, the root change.** <ul><li>`d` action.</li><li>Child-grant verification: signed by the parent's `cnf`, capabilities within the parent's `d` scopes, no `d`, expiry no later than the parent's, parent active.</li><li>Parent link stored; cascade revocation and revocation notices for children.</li><li>A delegate session can list and revoke its own children without root.</li></ul> | Pubky core | L |
| H2 | pubky-core homeserver | Revoke-all for root sessions ("sign out everywhere"). Optional, since list-then-revoke works | Pubky core | S |
| H3 | pubky-core homeserver | Grant status for services: an introspection endpoint, or a documented re-check rule | Pubky core | S–M |
| H4 | pubky-core homeserver | Remove cookie auth once clients have moved. Waits for the Shop's messaging cutover (E1) | Pubky core | S |
| **H5** | pubky-core homeserver | **Several bearers per grant (prerequisite; vlada, 21 Sep).** `replace_for_grant` keeps up to `MAX_SESSIONS_PER_GRANT` sessions (suggest 8), evicting the oldest atomically; revocation still deletes all. Gates #2614 and every grant-only web app | Pubky core | S |
| **H6** | pubky-core homeserver and SDK | **No cookie fallback (prerequisite, from #2614).** A request carrying `Authorization` ignores cookies; the SDK sends grant-session requests without browser credentials | Pubky core | S |
| K1 | pubky-core SDK (Rust, JS, FFI, react-native-pubky) | <ul><li>Signer side: approve an agent-grant request and display its ceiling.</li><li>Delegate side: sign a child grant from a stored agent grant with a non-extractable key.</li><li>A helper to verify a grant plus a PoP with a custom audience, for services.</li></ul> | Pubky core | M |
| K4 | pubky-core SDK (JS) | Gaps #2614 works around: delete one abandoned delegated proof key by attempt; a structured "missing record" error; `list()` reports IndexedDB errors | Pubky core | S |
| K3 | pubky-core docs | The agent request protocol: message types, versioning, origin rules, errors | Pubky core with the Passport team | S |
| K6 | pubky-core SDK (Rust, JS, FFI) | **Scoped keys (draft: [pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668), Andrei).** Stable keys derived from the root and scoped like capabilities (file key or subtree seed; `/pub/` and `/priv/` separate; dedicated root namespace). Signer side: derive the keys and send them beside the grant in an approval signed by the identity key. App side: opt in with the V1 approval format, and derive file keys only. No purpose API; apps use HKDF with their own versioned labels. Requested before merge: seal the keys to an app-held key. Not covered: agent-issued key approvals (Q12) | Pubky core | M |
| P1 | pubky-passport | **The account agent.** <ul><li>A `postMessage` API, with the client id set from the verified origin.</li><li>Consent remembered per origin and scope set; a first-party allow-list.</li><li>Child-grant issuance and the step-up ceiling.</li><li>A key bundle from the signer for approved `/priv` scopes only. Delivering keys to child apps is open (Q12): the SDK draft can't narrow a bundle or let the agent sign key approvals (K6).</li><li>A page listing the apps signed in on this browser, with revoke one or all.</li></ul> | Passport team | L |
| P2 | pubky-passport | Ring-linked mode: hold an agent grant from Ring instead of a root key | Passport team | M |
| R0 | pubky-ring | Release grant auth, already merged in [#360](https://github.com/pubky/pubky-ring/issues/360). It is a prerequisite for every Ring item below and for any Ring user signing in with grants. **In progress:** the release process has started | Ring team | S |
| R1 | pubky-ring | <ul><li>Show the client id, marked "unverified" for QR requests, and the scopes in plain words. **Agreed** by the Ring team.</li><li>A distinct screen for agent grants, showing the ceiling and expiry (after H1).</li><li>A separate "Encrypt and decrypt content" consent line (the SDK's wording) for each scope with the `e` action (K6), which the user can decline while approving storage. It is stronger than read access and can't be taken back. Ring must also parse `e` in deep links: an older build fails closed on `:rwe`.</li><li>The developer-only auto-auth never applies to them and can't ship reachable in release builds.</li></ul> | Ring team | M |
| R2 | pubky-ring | Sessions screen listing grants with per-grant revoke. **It exists** as draft [pubky-ring#369](https://github.com/pubky/pubky-ring/issues/369) ("Authorized Apps"), waiting on [pubky-core-ffi#37](https://github.com/pubky/pubky-core-ffi/issues/37), [react-native-pubky#42](https://github.com/pubky/react-native-pubky/issues/42), [#43](https://github.com/pubky/react-native-pubky/issues/43) and the next react-native-pubky release. After H1: group by parent, and revoke a whole browser | Ring team | S after #369 |
| B1 | Bitkit | R1's consent changes (including the `e` line and declining it), plus scoped-key derivation and delivery for `e` scopes (K6) | Bitkit team | S–M |
| ~~Y1~~ | pubky/paykit-rs | **Withdrawn (2 Oct).** Storage interface in `paykit-lib`: not needed, since messaging moves to pubky-chat (E1) | — | — |
| ~~Y2~~ | pubky/paykit-rs | **Withdrawn (2 Oct).** WASM package of `paykit-sdk`: Paykit plans none, and browser payments need only a public read | — | — |
| Y3 | pubky/paykit-rs | **Taken by Paykit as [#169](https://github.com/pubky/paykit-rs/issues/169):** the Noise key signed by the identity key and verified on every link operation, including the handshake's static key (gap closed 3 Oct) | Paykit team | M |
| A1 | pubky/pubky-app | **[#2614](https://github.com/pubky/pubky-app/issues/2614) (vlada):** <ul><li>New logins get per-app grants signed directly by Ring.</li><li>Legacy cookies keep restoring until they expire.</li><li>Sign-out revokes pubky.app's own grant.</li><li>Locks step-up.</li><li>Client id set to the origin host.</li></ul> Release gates: H5, H6, R0 | pubky-app maintainers | M (in review) |
| A2 | pubky/pubky-app | Get the grant from the agent instead of directly from Ring. Lock Server sign-in moves to the grant. Recovery-phrase and file logins move to Passport | pubky-app maintainers | S–M |
| F1 | BitcoinErrorLog/pubky-app (Shop) | One sign-in path through the agent for every signer. Delete the cookie path, the session bridge (`src/libs/vibe-session/*`), the `AuthToken` dual post, the scope union and the Bitkit-only branch, after a workspace-wide dead-code check | us | M |
| E1 | BitcoinErrorLog/pubky-app (Shop) | Replaces F2. Shop messaging moves to the shared pubky-chat library (MLS) on the app's own grant session; see the [chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md). Retire the vendored `paykit-wasm` | us | L |
| F3 | BitcoinErrorLog marketplace service and Lock Server fork | Accept the Shop's grant plus a PoP addressed to the service, requiring the service's capability. Remove the `AuthToken` route. **Update 8 Oct:** [pubky-homeserver#680](https://github.com/pubky/pubky-homeserver/issues/680) (Severin, merge hoped 9 Oct) is this mechanism: `create_custom_pop(data)` signs service-chosen JSON (audience, challenge) with the grant's client key and returns grant plus proof, and `verify_custom_grant_pop` checks it offline. The inbox server uses it; the marketplace service and Locks can adopt the same bundle for F3 | us | M |
| F4 | BitcoinErrorLog/paykit-rs-official | Retire `paykit-wasm` after E1 | us | S |

**Order.**

- **First, because they unblock work already written:** H5, H6 and R0 gate [#2614](https://github.com/pubky/pubky-app/issues/2614) (A1).
- **In parallel:**
  - H1, K1 and K3, which are the root;
  - E1 (pubky-chat on MLS), which messaging needs before anyone leaves cookies;
  - K4 and K6.
- **Then:** P1–P2, R1–R2 and B1.
- **Then:** A2, F1–F3.
- **Last:** H4.

**Without H1,** everything else still holds except silent sign-in for Ring users: they approve once per app per browser, once R0 ships. Until R0, Ring users stay on cookies. Passport-key users get full SSO from P1 alone, because Passport already holds their key.

## 7. Questions for the Pubky core team

The code can't answer these. Each gates the item named.

1. **Delegation shape (H1, K1).** Will core accept one-level delegable grants? Which form? **Update 8 Oct:** Severin objects (non-extractable sessions; delegation invites attackers), and tomos's session agent ([#681](https://github.com/pubky/pubky-homeserver/pull/681)) is the proposed alternative; see §4.
   - Child grants signed by the delegate's key, carrying the parent: verifiable offline by services and mirrors.
   - A child the homeserver records at the agent's request: no new token format, but only valid where it was recorded.

   How does a parent's revocation reach mirrors?

   Still open as of 2 Oct. The scoped-key work (K6) designs no delegated grants. Its SDK draft has no agent-issued key approvals (Q12).
2. **Cookie removal (H4).** In which version does `POST /session` go?
3. **Several bearers per grant (H5, H6).** This question was first raised by vlada in #pubky-core on 21 Sep.
   - In which homeserver version will `replace_for_grant` keep several bearers per grant, and what bound will it use (we suggest 8, evicting the oldest)?
   - Will the same release make a request that carries `Authorization` ignore cookies?
4. **Services as relying parties (H3, F3).** Is it endorsed for a service to accept a grant with a PoP addressed to itself? What is the convention for a capability that names a service? How should a service learn of revocation: an introspection endpoint, a short re-check interval, or a public status lookup?
5. **What `client_id` means.** Will core define it as the verified web origin, or a verified app-link domain, and add a field marking it as verified? What should signers display when it isn't? **Update 8 Oct:** Severin on #680: `client_id` "is basically meaningless at this stage of Pubky as any app can supply any client_id" ([comment](https://github.com/pubky/pubky-homeserver/pull/680#discussion_r4216482234); the reviewer's P1 to verify it was [withdrawn](https://github.com/pubky/pubky-homeserver/pull/680#discussion_r4216632057) on that basis). So nothing in the Shop's SSO plan may rely on `client_id` for authorization: services authorize on the grant's `iss`, `caps` and the PoP, and `client_id` is display-only until core verifies it.
6. **Lifetimes.** Is the 2-year default intended? Should agent grants have a shorter maximum enforced by the homeserver?
7. **Grant management.** Ring's grant list ([#369](https://github.com/pubky/pubky-ring/issues/369)) waits on [pubky-core-ffi#37](https://github.com/pubky/pubky-core-ffi/issues/37) and react-native-pubky [#42](https://github.com/pubky/react-native-pubky/issues/42) and [#43](https://github.com/pubky/react-native-pubky/issues/43). When will those release? Is a revoke-all endpoint planned?
8. **Ring auto-auth.** Answered by the Ring team: it is a developer setting. Remaining ask: keep it unreachable in release builds.
9. **Passport as the agent (P1, P2).** Will the Passport team own the agent role and a mode that holds no root key?
10. **Paykit (Y1–Y3).** *Answered by Ben, 2 Oct:* no storage interface, WASM package or custom-message API; state is shared per identity by design; signed Noise keys come in [#169](https://github.com/pubky/paykit-rs/issues/169). Messaging moves to pubky-chat, where one conversation spans every app (E1). The handshake static-key binding we asked for landed on 3 Oct; nothing remains asked.
11. **Scoped keys (K6).** *Answered by Andrei, 2 Oct:*
    - scope matching follows grants, with file keys and subtree seeds, and never reaches a sibling path;
    - `/pub/` and `/priv/` are separate trees;
    - keys travel beside the grant in the encrypted relay payload;
    - Passport agents receive scoped seeds and derive locally (the SDK draft lets them derive file keys but not pass keys to child apps; see Q12);
    - revocation blocks future `/priv` retrieval but not downloaded keys, so cryptographic revocation needs rotation;
    - purposes stay with the caller, through HKDF;
    - the root uses a dedicated namespace.

    Still open: delegated grants (Q1), which this work doesn't design.
12. **Keys for child apps (K6, P1).** In the SDK draft ([pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668)), key approvals are signed by the identity key, and a key bundle can't be narrowed. How should the agent deliver scoped keys to a child app: an agent-signed approval carrying a narrowed bundle (an SDK addition, tied to H1), or a per-app request to the signer?
