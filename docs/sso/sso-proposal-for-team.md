# Single sign-on across Pubky apps: proposal

**For:** Pubky core, Ring, Bitkit, Passport, Paykit and pubky.app developers.

**Scope:** sign-in, sessions and authorization for [pubky.app](https://pubky.app), [shop.pubky.app](https://shop.pubky.app) (the Shop), and any future first-party or third-party Pubky app.

**Code checked:** 1 Oct 2026, on these branches:

- [pubky/pubky-core](https://github.com/pubky/pubky-core) `main` (v0.14.0)
- [pubky/pubky-ring](https://github.com/pubky/pubky-ring)
- [pubky/pubky-passport](https://github.com/pubky/pubky-passport)
- [pubky/paykit-rs](https://github.com/pubky/paykit-rs)
- [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official)
- [pubky/pubky-app](https://github.com/pubky/pubky-app) `main`
- the Shop, a fork of pubky-app at [BitcoinErrorLog/pubky-app](https://github.com/BitcoinErrorLog/pubky-app/tree/release/shop-v0.6.8), branch `release/shop-v0.6.8`

## Summary

Today, Pubky web apps share one homeserver cookie per browser. That causes four problems:

- the Shop and pubky.app overwrite each other's scopes;
- users who sign in with Passport or Bitkit get no Encrypted Links messaging;
- there is no real single sign-on;
- any app with Paykit access can tamper with another app's messaging.

**The proposal:**

- **Grants become the only session type.**
- **The homeserver accepts one level of delegation.** The user's signer (Ring, Bitkit or Passport) approves once per browser and gives a grant to a browser **account agent**, which is Pubky Passport. That grant lets the agent issue narrower grants to individual apps, labelled with the origin the browser reports.
- **Every app keeps its own grant, its own key and its own revocation.**
- **Messaging runs on the app's own grant session,** through the shared pubky-chat library on MLS. Paykit keeps Encrypted Links for payments.
- **Keys for private data travel beside the grant.** The signer derives stable keys scoped to the grant's paths and sends them in the encrypted relay payload, never inside the grant itself.

The root change is in the homeserver and SDK. The other changes are each team adopting it.

---

## 1. The problem

### 1.1 One cookie per browser, shared by every site

A cookie session is set by the homeserver on its own host (`homeserver.pubky.app`), one per user per browser:

- Every website that talks to that homeserver from the same browser rides the same cookie.
- The homeserver's own [grant-auth guide](https://github.com/pubky/pubky-core/blob/main/docs/v0.10-migration/grant-auth.md) states it: "website B can receive the same homeserver cookie used by website A and potentially exercise A's permissions". It marks cookie auth "deprecated and scheduled for removal".
- On Safari, the cookie is a blocked third-party cookie for any app not on a `pubky.app` hostname.

**Where things stand:**

- pubky.app `main` still signs Ring users in with cookies (`signinCookie`, `startCookieAuthFlow`). Its grant migration is draft PR [pubky/pubky-app#2614](https://github.com/pubky/pubky-app/issues/2614), by vlada; §2.7 covers how it fits.
- The Shop signs Ring users in with cookies too. It uses grants only for Bitkit (and, in the beta, Passport).
- **Ring grant auth ships from v2.0.**
  - Ring's grant auth ([pubky/pubky-ring#360](https://github.com/pubky/pubky-ring/issues/360), merged 3 Sep) is first released in [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct), which also adds grant management ([#369](https://github.com/pubky/pubky-ring/pull/369)).
  - [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) (4 Sep) supports cookie auth only, on Android and iOS ("v1.19 did not ship with grant auth", [#375](https://github.com/pubky/pubky-ring/issues/375)). Its Android build carries a pre-0.10 native library that rejects grant deep links. Users on v1.19 must update before an app drops cookie sign-in.
  - Ring itself works as designed. The problems below come from the shared cookie and from the messaging library.

### 1.2 The Shop and pubky.app overwrite each other's scopes

Each new cookie sign-in replaces the previous session's capabilities for the whole browser:

| App | Scopes it requests |
|---|---|
| pubky.app | `/pub/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r` |
| Shop | `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw` |

The result:

- **Signing in on the Shop strips pubky.app's Locks access.**
- **Signing in on pubky.app strips the Shop's Paykit and `/priv` access.** The Shop then shows re-approval prompts.
- **Signing out of either site ends the session for both.**

The earlier cookie bridge ([pubky/pubky-app#2484](https://github.com/pubky/pubky-app/issues/2484)) passed this shared cookie between sites. It is switched off in both live Shop builds.

### 1.3 Passport and Bitkit users have no messaging

The Shop's Encrypted Links messaging uses `paykit-wasm`. That package exists only in our fork, [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) (`paykit-wasm/`).

**Why it only works with cookies:**

- It is built on pubky 0.8 and carries its own HTTP client.
- Its only credential is the cookie, which the browser attaches automatically (`credentials: include`).
- A grant session lives inside the app's own SDK instance, with a non-extractable key, so a separately compiled library can't use it.

**The effect:**

- Bitkit and Passport sign-ins are grant sessions, so those users get no messaging.
- The Shop can't move Ring users to grants without taking messaging away from them too.

Upstream [pubky/paykit-rs](https://github.com/pubky/paykit-rs) is on pubky 0.12 and already accepts grant sessions in `paykit-sdk`. It ships no WASM package and, per Ben (2 Oct), plans none. So the fix is not in Paykit: Shop messaging moves to the shared pubky-chat library on MLS (E1), and until then stays on Ring cookie sessions.

### 1.4 No single sign-on between first-party apps

**Grants are per app, which is correct.** Each grant is bound to one app's proof-of-possession (PoP) key.

**But every new grant needs a signer approval.** Two first-party apps therefore mean two approvals per browser. A future app means one more. A lost browser session means another.

**Today's "shared" sign-in is the cookie,** which is the problem in §1.1.

### 1.5 Signer approvals are open to phishing

| Signer | What it shows the user | Weakness |
|---|---|---|
| Ring | `x-source`, a name the requesting app declares. It doesn't display the grant's `client_id` | Any page can claim any name. (Ring's auto-auth setting is developer-only and off by default; it just mustn't be reachable in release builds) |
| Passport | The callback host the app declares | Approves any app; doesn't check which origin opened it |

**What the homeserver checks:** the grant's `client_id` is self-declared. The homeserver's grant module says "the security boundary is capability scoping, not `client_id`".

**So:** any website can show a QR claiming to be `shop.pubky.app` and get a grant for its own key.

### 1.6 Any app with Paykit access can tamper with another app's messaging

- Paykit publishes each app's messaging key in an unsigned **receiver marker** under `/pub/paykit/v0/{app}/...`.
- The marker is trusted only because nobody but the folder's owner can write that folder.
- The Shop requests `/pub/paykit/:rw`, which covers every app's folder. Any app holding that scope can replace another app's marker and intercept new links.

**Where this stands (Ben, 2 Oct):**

- Upstream Paykit shares state across all of an identity's apps by design, so narrowing the scope to one folder can't isolate an app. Scope narrowing is dropped.
- Upstream signs the Noise key with the identity key in [pubky/paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169), which closes the swap for Paykit's own links. The handshake gap we raised is closed too (3 Oct): Ben's commits `4eda7102` and `73345917` check the peer's static key against the signed key before any transport use, on handshake completion and on restore. A mismatch fails into recovery-required, and substitution tests cover both roles and restored links.
- The Shop's own unsigned marker stays on the frozen messaging stack until E1. The Shop then drops `/pub/paykit/:rw`.

### 1.7 Services need a second sign-in

The Shop's marketplace service can't see the homeserver cookie, so it authenticates a legacy `AuthToken` instead.

- **The interim fix:** the Shop sends the same token bytes to both the homeserver and the service ([single-approval.md](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/single-approval.md)). That avoids a second QR.
- **What it costs:** while the token is in flight, it carries the full scope set.
- **The same applies to the Lock Server,** which pubky.app signs into through its own iframe flow.

---

## 2. The proposed solution

### 2.1 The model

| Concept | Definition |
|---|---|
| **Identity** | The user's key. It lives in a signer: Ring, Bitkit, or Passport in the browser |
| **Authorization** | A **grant**: a JWS signed by the user's key, containing `{iss, client_id, caps, cnf, jti, iat, exp}` and binding a set of capabilities to one app's own key (`cnf`). This already exists in pubky-core |
| **Session** | An app holding its grant and key. The one-hour bearer is a cache the SDK refreshes |
| **Signed-in state** | Lives in the **browser, on one dedicated agent origin**: Passport at `passport.pubky.app`. The agent holds a grant from the signer that allows it to issue narrower grants to apps |
| **Verifier and revocation authority** | The homeserver. It already checks every request against the stored grant and closes private streams on revocation |

### 2.2 What changes in the protocol

1. **A `d` (delegate) capability action.** For example, `/pub/pubky.app/:rwd` means "may grant `rw` under `/pub/pubky.app/` to another key". The `d` scopes of the agent's grant form its **ceiling**.
2. **Child grants.** The agent signs a grant for an app's key. The homeserver accepts it only if all of these hold:
   - it is signed by the parent grant's `cnf` key;
   - its capabilities are within the parent's `d` scopes and carry no `d` themselves (one level only);
   - its expiry is no later than the parent's;
   - the parent is active.

   A homeserver that doesn't support child grants rejects them, because the signature isn't the user's. The change fails closed.
3. **Cascade revocation.** The homeserver stores each child's parent. Revoking the agent's grant revokes every child. The agent can list and revoke its own children without root.
4. **A verified client id.** The agent sets `client_id` from the origin the browser reports when the app asks it, and refuses any mismatch. evil.com can only get grants labelled evil.com.

The original auth spec ([`docs/AUTH.md`](https://github.com/pubky/pubky-core/blob/main/docs/AUTH.md), "No delegation") deferred delegation because a verifier would have to look up and check revocation asynchronously. Under grant auth the homeserver already stores every grant, so checking the parent is a local lookup.

**The ceiling grows with use:**

- It starts with the scopes of the app being signed into, plus the first-party set.
- When an app needs a scope outside it, the signer is asked to extend it.

### 2.3 What users experience

**Signing in for the first time in a browser (on the Shop):**

1. The user clicks "Sign in". The Shop creates its own key and asks Passport, through a hidden frame (first-party) or a popup (third-party).
2. Passport has nothing for this browser yet, so it shows: Pubky Ring (QR, or a deep link on mobile), Bitkit, or Continue with Google.
3. Ring shows one distinct screen: "Let this browser sign you in to apps, up to: *scopes*. Expires *date*." **The user approves once.**
4. Passport issues the Shop's grant, and the user is signed in.
5. The marketplace service accepts the same grant, so the first purchase needs no further approval.

**Opening pubky.app afterwards:** pubky.app asks Passport the same way. It is first-party and its origin is verified, so Passport issues the grant immediately. **The user does nothing.**

**Opening a third-party app:** a Passport popup asks once: "Allow example.com to use `/pub/example.com/:rw`?" After that, the popup opens and closes by itself.

**Asking for more:** an app that needs a scope outside the browser's ceiling triggers one Ring prompt showing what is being added.

**A new device or browser:** one signer approval, then every app works. Each browser shows in Ring as its own entry, for example "Passport · Chrome on macOS".

**Signing out:**

| Action | Effect |
|---|---|
| Sign out of one app | That app revokes its own grant. Other apps stay signed in |
| Sign out of this browser | Passport revokes its grant, and every app in this browser is signed out on its next request |
| Sign out everywhere | Ring, which holds a root session, lists every grant by browser and app and revokes them |

**Messaging:**

- Each app runs the shared pubky-chat library (MLS) on **its own** grant session. The library borrows that session and never restores it ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)).
- Passport, Bitkit and Ring users all get messaging once the Shop moves to it (E1). Until then, Shop messaging stays on Ring cookie sessions.

**Private data:**

- When an app's grant covers a `/priv` scope the user approved for decryption, it receives that scope's key beside the grant (§2.9).
- The signer shows this as its own consent line.

**Phishing:**

- **Web:** a site can only get grants under its own origin.
- **Native apps:** use a verified app link for the return.
- **A QR scanned on another device can't be tied to a website.** Anyone can relay a genuine QR. That QR is used only for the once-per-browser approval, on its own screen, marked "unverified" where the origin can't be checked, and never auto-approved.

### 2.4 How this works across browsers

| Situation | Behaviour |
|---|---|
| First-party apps (`*.pubky.app`) | Same-site with `passport.pubky.app`, so the hidden frame can read Passport's storage. Sign-in is silent |
| Third-party apps | Browsers partition storage in embedded frames, so these use a popup, which needs one click |
| Safari | Deletes site storage after 7 days of Safari use with no user interaction. That costs at most one re-approval; visits to any `*.pubky.app` site count |
| Several tabs of one app | Share one grant. This needs the homeserver fix in §2.6 |

### 2.5 Why this beats the alternatives

| Alternative | Why it is worse |
|---|---|
| **Cookie bridge** ([#2484](https://github.com/pubky/pubky-app/issues/2484)), or lending `*.pubky.app` hostnames | <ul><li>Keeps the ambient, shared cookie: every site rides one scope set, and the last sign-in wins.</li><li>Off-domain apps break on Safari.</li><li>It is deprecated.</li><li>Script injected on any participating site can act with the shared session.</li></ul> |
| **Ring bundle:** one approval issues grants to several apps at sign-in | <ul><li>Only covers apps that are present and coordinated at sign-in. Each app must host a companion frame for every other app, and third-party frames are partitioned.</li><li>A new app, a new scope or a lost session goes back to the signer.</li><li>It is consent to several apps at once, not single sign-on.</li><li>Its only advantage is no homeserver change.</li></ul> |
| **Ring auto-approve**, or remembered consent in Ring | <ul><li>Ring can't tell which website showed a QR, and `client_id` is self-declared.</li><li>A phishing page claiming `shop.pubky.app` would get a silent grant.</li><li>Ring's existing auto-auth is a developer setting, not this.</li></ul> |
| **A user session at the homeserver** that issues per-app grants | <ul><li>The homeserver is cross-origin to every app, so that session is a cookie again, or partitioned storage.</li><li>It doesn't carry to mirrors.</li><li>It makes the storage provider an identity provider.</li><li>A variant where the homeserver *records* a child at the agent's request is an acceptable way to implement this proposal (question Q1).</li></ul> |
| **pubky.app as the broker** | <ul><li>The site that renders user content, the most exposed to injected script, would hold the power to issue grants.</li><li>A dedicated Passport origin is a small static app with no user content.</li></ul> |
| **The user's key in the browser for everyone** (Passport's Google mode) | <ul><li>Needs no protocol change.</li><li>But it abandons the cold-key model for Ring users.</li></ul> |
| **Signer push:** Passport forwards each request to Ring | <ul><li>The phone must be online for every new session.</li><li>It needs push infrastructure.</li><li>It turns the cold key into a remote signing service.</li></ul> |

**The agent's grant power is bounded and revocable as one unit.** It is still a smaller hot credential than what exists today: the cookie, which every site rides, and Passport's root key in browser storage. Scoped keys it would hold are the exception: a leaked key can't be revoked, only rotated away from (§2.9).

### 2.6 Prerequisite: several tabs on one grant

**Credit:** vlada, in #pubky-core on 21 Sep, while planning pubky.app's grant migration.

**The problem.** The homeserver keeps one bearer per grant. In both v0.11.0 and v0.14.0 `main`, `replace_for_grant` deletes every session for the grant before inserting the new one. `MAX_SESSIONS_PER_GRANT` exists only in comments and tests. So:

1. Tab A restores the grant and gets bearer A.
2. Tab B restores the same grant and gets bearer B. Bearer A is deleted.
3. Tab A's next write gets a 401, although the grant is still valid.
4. If tab A restores again, it kills bearer B, and the two tabs keep invalidating each other.

Every grant-only web app hits this. That includes pubky.app under [#2614](https://github.com/pubky/pubky-app/issues/2614), the Shop, and every app the agent signs in.

**Recommended fix (H5): the homeserver keeps several live bearers per grant.**

- Up to `MAX_SESSIONS_PER_GRANT`, a small bound such as 8. Beyond it, the oldest is evicted, in the same atomic statement.
- Revoking the grant still deletes all of them.
- Each tab mints its own bearer with a PoP from the shared non-extractable key.

According to #2614, the homeserver team has already confirmed the limitation and offered this fix.

**Why not one tab owning the bearer and sharing it** through a BroadcastChannel or a SharedWorker:

- **Browsers freeze or discard background tabs,** on mobile especially. A frozen or closed leader stalls every other tab, and the takeover mints a new bearer anyway.
- **SharedWorker isn't available in Chrome on Android.**
- **Every app, and every library that borrows the session, would need the same election and handoff code.** The homeserver fix is one change that every client gets for free.
- **There is no security gain.** Every tab has the same origin and key, so copying one bearer to all of them protects nothing.

**Second prerequisite (H6), from #2614: no cookie fallback.**

- While legacy cookies exist, a request whose bearer is missing, expired or revoked must not be authorized by the cookie the browser attaches. That includes another app's cookie, such as the Shop's Ring cookie.
- The homeserver should ignore cookies on any request that carries `Authorization`. The SDK should send grant-session requests without browser credentials.

### 2.7 How pubky.app's migration fits (#2614)

**[#2614](https://github.com/pubky/pubky-app/issues/2614) is pubky.app's half of moving off cookies, and this proposal builds on it.**

| #2614 does | Fit with this proposal |
|---|---|
| New Ring, file, phrase and sign-up logins get grants. Valid cookie sessions keep restoring. There is no new cookie login and no fallback to cookies | Same model: one grant per app, cookies only phased out |
| Ordinary login requests `/pub/pubky.app/:rw`. Locks asks for `/priv/social/:rw,/priv/locks.app/:r` through a step-up | Same as the agent's per-app grant and ceiling step-up |
| Client id from runtime config (`PUBKY_RUNTIME_AUTH_CLIENT_ID`); a restore with another client id is refused | **Set it to the origin host** (`pubky.app`, `staging.pubky.app`). The agent will set client ids from the verified origin, and any other value would force a re-authorization at the switch |
| Secrets in `browserSessionStore`; Web Locks and generation checks across tabs; no restore-on-401 loop | Compatible. These coordinate app state; H5 removes the bearer conflict |
| Release gates: several bearers per grant, no cookie fallback, shipped Ring grant builds ([pubky-ring#375](https://github.com/pubky/pubky-ring/issues/375)) | These are exactly H5, H6 and R0 |

**Two points differ from the target design:**

1. **Recovery-phrase and file logins produce a root grant inside pubky.app.** Under this design the key belongs in a signer, which can be Passport, so long term those logins move to Passport (A2).
2. **#2614 moves Locks' creator-originals path** from `/priv/app.locks/content/` to `/priv/locks.app/`. The Shop's beta scope union follows whichever path ships.

**Before the agent exists,** #2614 works as is, with Ring signing pubky.app's grant directly. When the agent ships, only where the grant comes from changes (A2).

### 2.8 Ring's side of the agent grant

**What Ring approves.**

- One grant request from Passport, delivered the usual way (QR or deep link, relay, client public key).
- The client id is `passport.pubky.app` and the client key is the agent's non-extractable key.
- The listed scopes carry a `d` (may delegate) action, for example `/pub/pubky.app/:rwd,/pub/paykit/v0/marketplace/:rwd`.
- Ring signs one grant JWS with the user's key, exactly as it does today. Only the scopes and the screen differ.

**What the screen shows.**

- A distinct title: "Let this browser sign you in to apps".
- The agent's origin (`passport.pubky.app`), marked unverified when it came from a QR.
- The scopes it may pass on, in plain words. These are the ceiling: no app it signs in can get more.
- The maximum lifetime: the agent grant's own expiry, which also caps every app grant it issues.
- A note that every app it signs in can be revoked as one group.
- Developer auto-auth never applies.

**Revocation.**

- The agent grant appears in Ring's grant list ([#369](https://github.com/pubky/pubky-ring/issues/369)) as one entry, for example "Passport · Chrome on macOS", with the apps it signed in nested under it.
- Revoking the entry revokes the agent grant. The homeserver then revokes every child grant, and those apps are signed out on their next request.
- Each child can also be revoked on its own.

**What changes for Ring.**

- **Signing:** nothing new. It is the same grant format, with `d` in the capability string. Today `d` parses as an unknown action, so Ring needs only to display it.
- **Verification:** none. Ring never verifies child grants; the homeserver does (H1).
- **Possible format change:** if core adds a separate child-lifetime cap or a parent field to the grant list (Q1, Q6), Ring reads and displays it.
- **Grouping:** needs H1's parent link in the list response.

The exact format depends on core's answer to Q1.

### 2.9 Encryption keys beside the grant

`/priv` is readable only by its owner's sessions, but it is stored in plaintext on the homeserver. Andrei and Sev's scoped keys let apps encrypt it with keys the operator never sees. The SDK side is in draft as [pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668) (K6). The design, as Andrei answered our questions on 2 Oct:

| Question | Answer |
|---|---|
| Does key scope match grant scope? | Yes. `/pub/app` gets an exact-file key; `/pub/app/` gets a subtree seed. Neither reaches `/pub/app-evil` |
| `/pub/` or `/priv/`? | Both work and derive separate trees. `/priv/` adds the homeserver's access control. Recovering an archive needs the root plus a backup of the private ciphertext at its original paths |
| Rotation and revocation | Random data-key wrapping is optional and not yet implemented. Revoking a grant blocks future `/priv` retrieval, but can't invalidate keys or ciphertext already downloaded. Cryptographic revocation requires key rotation |
| Delivery and delegation | Keys travel beside the grant, in the encrypted relay payload, outside the grant the homeserver stores. Passport agents receive scoped seeds and derive locally. No delegated grants are designed here |
| Separate keys per purpose | Up to the caller. The SDK derives stable scoped keys. Apps use HKDF with their own versioned labels for separate encryption, HMAC or X25519 keys. No purpose API is planned. The root uses a dedicated namespace |

**What the SDK draft settles (6 Oct):**

- **Approvals are signed by the identity key.** The signer sends the grant and a key bundle together, signed by the user's key. The app checks that signature against the grant's issuer. Apps opt in per sign-in with the V1 approval format.
- **Apps get file keys, not seeds.** The bundle keeps directory seeds inside it, and apps derive keys for file paths only. An app derives the file key of a fixed path it chooses, then its own HKDF purpose keys.
- **Bundles can't be narrowed.** A holder derives file keys, but can't hand a narrower bundle to another app.
- **Explicit `e` permission (7 Oct, [#668](https://github.com/pubky/pubky-homeserver/pull/668#issuecomment-6035403798)).** Keys are delivered only for scopes that carry the new `e` action. `r` and `w` no longer deliver keys, and `e` grants no storage access (`/pub/chat/:rwe` = storage plus keys, `/pub/chat/:e` = keys only). Signers may approve storage while declining `e`. Upgrade order: the homeserver first (older homeservers reject grants that carry `e`), then apps and signers together (older signers fail closed on `:rwe`, and approvals from the earlier draft are rejected on restore).
- **Link secret: fixed (6 Oct).** The approval is sealed with HPKE to an app-held recipient key (`ek=`), so a leaked QR or link can't open the keys.

**What this means for each party:**

- **Signers (Ring, Bitkit, Passport):** derive and deliver keys only for scopes with `e`. Show "Encrypt and decrypt content" as its own consent line for each `e` scope, apart from storage access, and let the user decline it, because keys can't be taken back (R1, B1).
- **The agent (P1):** would hold a key bundle only for `/priv` scopes the user approved for decryption. Delivering keys to child apps is deferred to a later `v2` (§4, Q12; Andrei, 7 Oct); until then each child app asks the signer: the SDK draft can't narrow a bundle, and the agent can't sign a key approval. A leaked key stays leaked, so the agent's small static origin and strict CSP matter more here.
- **Apps:** wrap a random data key under a key derived with HKDF from the file key of a fixed path, rather than encrypting with the scoped key directly, so the data key can rotate. Keep encrypted paths stable. Treat grant revocation as access control, not key revocation.
- **Core:** delegated grants (H1, Q1) are still open. Child-app key delivery (Q12) depends on them, or on a per-app request to the signer.

---

## 3. The plan

### 3.1 Phases

| Phase | What ships | Depends on |
|---|---|---|
| **0. Beta stopgaps** (being built now) | Ring sign-in requests both sites' scopes; Passport sign-in on the Shop; honest sign-out copy. See §3.2 | Nothing upstream |
| **1a. Grants per app** | <ul><li>Several bearers per grant and no cookie fallback (H5, H6).</li><li>Ring grant-auth release (R0).</li><li>pubky.app's [#2614](https://github.com/pubky/pubky-app/issues/2614) ships (A1), with one Ring approval per app per browser and no scope overwriting.</li></ul> | Q3; R0 |
| **1b. Foundations** | <ul><li>Delegable grants in the homeserver and SDK (H1, K1).</li><li>The agent protocol spec (K3).</li><li>SDK gaps (K4).</li><li>Scoped keys in the SDK, delivered beside the grant (K6; in progress).</li></ul> | Answers to Q1, Q2, Q4, Q5 |
| **2. Signers and agent** | <ul><li>Passport as account agent, with a Ring-linked mode (P1, P2).</li><li>Ring and Bitkit consent and session screens (R1, R2, B1).</li></ul> | H1, K1, K3; R0 for the Ring items |
| **3. Apps and services** | <ul><li>pubky.app (A2) and the Shop (F1) sign in through the agent with grants only.</li><li>Shop messaging on the shared pubky-chat library (E1).</li><li>The marketplace service and Lock Server accept the app's grant (F3).</li></ul> | Phase 2; pubky-chat Phase 2 for E1; H3 for F3 |
| **4. Cleanup** | <ul><li>The homeserver removes cookie auth (H4).</li><li>The fork's `paykit-wasm` is retired (F4).</li></ul> | All clients moved |

### 3.2 During the beta

**Three stopgaps are being built for the Shop beta.** None of them is single sign-on.

None of them depends on Ring's grant auth being released. The Ring stopgap is a cookie sign-in, and Passport sign-in uses Passport's own grant flow.

1. **Ring sign-in requests both sites' scopes.**
   - The Shop's Ring cookie sign-in asks for the union of the two scope sets: `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r`.
   - So a Shop sign-in no longer strips pubky.app's Locks access.
   - The cost, accepted: the Shop holds pubky.app's `/priv/social`. This is removed in phase 3.
2. **Passport sign-in on the Shop.** "Continue with Google" through the Passport popup, using SDK 0.11's grant flow. No Passport change is needed.
3. **Honest sign-out copy.**
   - For Ring (cookie) sessions, the copy says that signing out of the Shop also signs pubky.app out in this browser.
   - Bitkit and Passport sessions sign out of the Shop only.

**What beta users will see:**

- **One approval per site.** Signing in on pubky.app doesn't sign you in to the Shop, and the reverse.
- **pubky.app can still narrow the Shop.** Signing in on pubky.app after the Shop narrows the Shop's session, and the Shop then asks for re-approval for messaging and watchlist sync.
- **Messaging needs Ring for now.** Passport and Bitkit users can browse and buy but can't message yet, and the Shop says so without implying Ring is the only way in.
- **Ring sign-out is shared.** Signing out of the Shop with a Ring session signs pubky.app out in that browser.
- **Bitkit sign-up** after a wipe can fail at authorize, tracked in [synonymdev/bitkit-android#1398](https://github.com/synonymdev/bitkit-android/issues/1398). Shop copy no longer implies only Ring can create an identity ([pubky/pubky-marketplace#49](https://github.com/pubky/pubky-marketplace/issues/49)).

### 3.3 Change list per repo

**Sizes describe technical scope:**

- **S:** one component, no wire-format change.
- **M:** several modules or a new UI surface in one repo; any wire change is additive.
- **L:** a protocol change with new verification rules, a database migration, and coordination across repos.

**Pubky core** ([pubky/pubky-core](https://github.com/pubky/pubky-core)): homeserver, SDK and docs

| # | Change | Size | Depends on |
|---|---|---|---|
| **H1** | **Delegable grants, the root change.** <ul><li>`d` action.</li><li>Child-grant verification (signer is the parent's `cnf`, capabilities within the parent's `d` scopes, no `d`, expiry no later than the parent's, parent active).</li><li>Parent link stored; cascade revocation, including revocation notices that close private streams.</li><li>A delegate session can list and revoke its own children.</li></ul> | L | Q1 |
| H2 | Revoke-all for root sessions ("sign out everywhere"). Optional, since list-then-revoke works today | S | — |
| H3 | Grant status for services: an introspection endpoint, or a documented re-check rule | S–M | Q4 |
| H4 | Remove cookie auth once clients have moved; waits for the Shop's messaging cutover (E1) | S | Phase 3 |
| K1 | SDK for Rust, JS and the FFI (react-native-pubky): <ul><li>signer side approves an agent-grant request and shows its ceiling;</li><li>delegate side signs child grants with a non-extractable key;</li><li>a helper to verify a grant plus a PoP addressed to a service.</li></ul> | M | H1 |
| **H5** | **Several bearers per grant (§2.6).** `replace_for_grant` keeps up to `MAX_SESSIONS_PER_GRANT` sessions (suggest 8), evicting the oldest atomically; revocation still deletes all | S | Q3 |
| **H6** | **No cookie fallback (§2.6).** A request carrying `Authorization` ignores cookies; the SDK sends grant-session requests without browser credentials | S | Q3 |
| K4 | SDK gaps #2614 works around: delete one abandoned delegated proof key by attempt; a structured "missing record" error; `list()` reports IndexedDB errors | S | — |
| K3 | Agent request protocol spec: message types, versioning, origin rules, errors. Written with the Passport team | S | Q5 |
| K6 | **Scoped keys (draft: [pubky-homeserver#668](https://github.com/pubky/pubky-homeserver/pull/668), Andrei).** Stable keys derived from the root, scoped like capabilities; signer-side derivation and delivery beside the grant in an approval signed by the identity key; app-side file-key derivation (§2.9) | M | — |

**Passport** ([pubky/pubky-passport](https://github.com/pubky/pubky-passport))

| # | Change | Size | Depends on |
|---|---|---|---|
| **P1** | **The account agent.** <ul><li>A `postMessage` API, with `client_id` set from the verified origin.</li><li>Consent remembered per origin and scope set; a first-party allow-list.</li><li>Child-grant issuance and ceiling step-up.</li><li>A key bundle for approved `/priv` scopes only. Delivering keys to child apps is open (§2.9, Q12).</li><li>A page listing the apps signed in on this browser, with revoke one or all.</li></ul> | L | H1, K1, K3; K6 for keys |
| P2 | Ring-linked mode: hold an agent grant from Ring instead of the user's root key | M | P1 |

**Ring** ([pubky/pubky-ring](https://github.com/pubky/pubky-ring)) and **Bitkit**

| # | Change | Size | Depends on |
|---|---|---|---|
| R0 | **Release grant auth**, already merged in [#360](https://github.com/pubky/pubky-ring/issues/360). Every Ring user's move off cookies depends on it (F1 for Ring users, A1), and so do R1 and R2. **In progress:** the release process has started | S | — |
| R1 | Ring consent: <ul><li>show `client_id`, marked "unverified" for QR requests, and the scopes in plain words. **Agreed** by the Ring team;</li><li>a distinct agent-grant screen showing the ceiling and expiry (§2.8);</li><li>a separate "Encrypt and decrypt content" consent line for each `e` scope, which the user can decline while approving storage, and parsing of `e` in deep links (§2.9);</li><li>the developer-only auto-auth never applies to it and can't ship reachable in release builds.</li></ul> | M | K1 for the agent screen; K6 for keys |
| R2 | Ring sessions screen: list grants with per-grant revoke. **Exists** as draft [pubky-ring#369](https://github.com/pubky/pubky-ring/issues/369) ("Authorized Apps"), waiting on [pubky-core-ffi#37](https://github.com/pubky/pubky-core-ffi/issues/37), [react-native-pubky#42](https://github.com/pubky/react-native-pubky/issues/42), [#43](https://github.com/pubky/react-native-pubky/issues/43) and the next react-native-pubky release. After H1: group by browser, and revoke a whole browser | S after #369 | #369's dependencies; H1 for grouping |
| B1 | Bitkit: R1's consent changes (including the `e` line and declining it), plus scoped-key derivation and delivery for `e` scopes, on [bitkit-android](https://github.com/synonymdev/bitkit-android) and [bitkit-ios](https://github.com/synonymdev/bitkit-ios) | S–M | K1; K6 for keys |

**Paykit** ([pubky/paykit-rs](https://github.com/pubky/paykit-rs)): answered by Ben on 2 Oct (Q10)

| # | Change | Status |
|---|---|---|
| ~~Y1~~ | A storage interface in `paykit-lib` | **Withdrawn.** Messaging moves to pubky-chat (E1), so nothing needs it |
| ~~Y2~~ | WASM package of `paykit-sdk` | **Withdrawn.** Paykit plans none, and browser payments need only a public read |
| Y3 | Signed Noise key | **Taken upstream** as [#169](https://github.com/pubky/paykit-rs/issues/169), signed by the identity key and verified on every link operation, including the handshake's static key on completion and restore (gap closed 3 Oct) |

A custom-message API is not needed either, and scope narrowing is dropped because Paykit state is shared per identity by design.

**pubky.app** ([pubky/pubky-app](https://github.com/pubky/pubky-app))

| # | Change | Size | Depends on |
|---|---|---|---|
| A1 | **[#2614](https://github.com/pubky/pubky-app/issues/2614) (vlada, draft):** <ul><li>New logins get per-app grants signed directly by Ring.</li><li>Legacy cookies keep restoring.</li><li>Sign-out revokes pubky.app's own grant.</li><li>Locks step-up.</li><li>Client id set to the origin host.</li></ul> | M (in review) | H5, H6, R0 |
| A2 | Get the grant from the agent instead of directly from Ring. Lock Server sign-in moves to the grant. Recovery-phrase and file logins move to Passport | S–M | P1, A1 |

**Shop and our services** (BitcoinErrorLog): we own these

| # | Change | Size | Depends on |
|---|---|---|---|
| F1 | One sign-in path through the agent for every signer. Remove the cookie path, the session bridge (`src/libs/vibe-session/*`), the `AuthToken` dual post, the scope union and the Bitkit-only branch, after a dead-code check | M | P1 |
| E1 | Replaces F2: Shop messaging moves to the shared pubky-chat library (MLS) on the app's own grant session ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)) | L | pubky-chat Phase 2 |
| F3 | The marketplace service and our Lock Server fork accept the app's grant plus a PoP addressed to the service, requiring the service's capability; the `AuthToken` route is removed | M | K1, H3 |
| F4 | Retire `paykit-wasm` in [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) | S | E1 |

### 3.4 Suggested order and timeline

The beta opens about **15 Oct**. After that, each phase starts when its dependencies land; there are no dates beyond these gates.

| When | Work |
|---|---|
| **Now to the beta** | <ul><li>Phase 0 ships.</li><li>The core team answers Q1–Q5, with Q3 first because it gates #2614. Paykit answered Q10 and Andrei answered Q11 on 2 Oct.</li><li>Core ships H5 and H6; Ring ships R0. Together they unblock #2614.</li><li>Design reviews start for H1 and K3; K6 is already being implemented.</li></ul> |
| **From the answers** | <ul><li>Two tracks in parallel: H1, K1, K3 and K4 (core); K6 (core) with signer support in Ring, Bitkit and Passport.</li><li>A1 (#2614) ships once H5, H6 and R0 are deployed.</li><li>Ring releases grant auth (R0), which doesn't wait on anything here.</li><li>Ring starts R1 as soon as K1's request format is fixed.</li></ul> |
| **When H1 and K1 are released** | <ul><li>P1 and P2 (Passport), R2 (Ring), B1 (Bitkit).</li><li>F3 (us), once H3 is settled.</li></ul> |
| **When P1 is live on staging** | <ul><li>A2 (pubky.app) and F1 (us).</li><li>E1 (us), once pubky-chat Phase 2 ships.</li><li>A cross-app QA matrix: each signer on each app; sign-out at each level; third-party popup; new browser; Safari.</li></ul> |
| **When both apps and the services run without cookies** | H4 (core) and F4 (us) |

**The critical path to grant-only apps** is H5, H6 and R0, then A1 (#2614).

**The critical path to SSO** is H1 → K1 → P1 → F1 and A2. The Shop's move to pubky-chat (E1) runs alongside it and gates messaging for Passport and Bitkit users.

### 3.5 What works even if the core change is delayed

| Available without H1 | Effect |
|---|---|
| **E1** | All users get messaging on their own grant session, and the Shop drops `/pub/paykit/:rw`. That ends the cross-app marker exposure and lets the Shop drop cookies for Ring |
| **K6** | Apps encrypt `/priv` data under keys the operator never sees. It needs signer support, not delegation |
| **A1 ([#2614](https://github.com/pubky/pubky-app/issues/2614)) with H5, H6 and R0** | pubky.app on grants: no cookie overwriting from pubky.app's side, and its sign-out signs out pubky.app only. It needs only the two small homeserver fixes and the Ring release, not H1 |
| **F1 without the agent** | The Shop uses grant sessions for every signer, one approval per app per browser. No more scope overwriting, and sign-out stops being shared. **For Ring users this needs R0** (the Ring grant-auth release) as well as E1, so they keep messaging |
| **P1 for Passport-key users** | Passport already holds their key, so it can sign per-app grants directly, with full SSO and origin-verified client ids, and no protocol change |
| **R1 and R2** | Showing `client_id` and scopes (agreed) reduces phishing now. The grant list in #369 gives users per-app revoke |
| **F3 with an app-scoped service capability** | Removes the `AuthToken` dual post |

**What waits for H1:** silent sign-in for **Ring** users across apps. Without it, they approve once per app per browser, once R0 ships. Until R0, Ring users stay on cookie sign-in.

---

## 4. Open questions for the Pubky core team

1. **Delegation (gates H1, K1).** Will core accept one-level delegable grants, with a `d` action, child grants signed by the parent grant's `cnf` key, and cascade revocation?
   - If yes, which form: (a) child grants that carry the parent and can be verified offline by services and mirrors, or (b) children the homeserver records at the agent's request?
   - How should a parent's revocation reach mirrors?
   - Still open as of 2 Oct. The scoped-key work (K6) designs no delegated grants.
2. **Cookie removal (gates H4).** In which homeserver version will cookie auth (`POST /session`) be removed?
3. **Several bearers per grant (gates H5, H6 and #2614).** This question was first raised by vlada in #pubky-core on 21 Sep.
   - In which homeserver version will `replace_for_grant` keep several bearers per grant, and what bound will it use (we suggest 8, evicting the oldest)?
   - Will the same release make a request that carries `Authorization` ignore cookies?
4. **Services as relying parties (gates H3, F3).**
   - May a service authenticate a user by accepting the app's grant plus a PoP whose audience is the service?
   - What is the naming convention for a capability that names a service?
   - Which revocation check should services use: an introspection endpoint, a re-check interval, or a public status lookup?
5. **`client_id` (gates K3, R1).** Will core define `client_id` as the verified web origin (or verified app-link domain) and add a field marking it verified? What should a signer display when it isn't verified?
6. **Lifetimes.** Is the SDK's 2-year default grant lifetime intended? Should the homeserver enforce a shorter maximum for agent grants, and if so, how long?
7. **Grant management (gates R2).** Ring's grant list ([#369](https://github.com/pubky/pubky-ring/issues/369)) waits on [pubky-core-ffi#37](https://github.com/pubky/pubky-core-ffi/issues/37) and react-native-pubky [#42](https://github.com/pubky/react-native-pubky/issues/42) and [#43](https://github.com/pubky/react-native-pubky/issues/43). When will those release? Is a revoke-all endpoint planned?
8. **Ring auto-auth.** *Answered by the Ring team:* it is a developer setting, off by default. Remaining ask: keep it unreachable in release builds, and never apply it to agent grants.
9. **Passport as the agent (gates P1, P2).** Will the Passport team own the account-agent role, including a mode that holds an agent grant instead of the user's root key?
10. **Paykit (gates Y1–Y3).** *Answered by Ben, 2 Oct:*
    - No storage interface, WASM package or custom-message API. Y1 and Y2 are withdrawn.
    - State is shared across an identity's apps by design, so there is no per-app inbox to choose.
    - Signed Noise keys are [#169](https://github.com/pubky/paykit-rs/issues/169).
    - Messaging moves to pubky-chat, where one conversation spans every app.
    - The handshake static-key check we asked for landed in `4eda7102` and `73345917` (3 Oct). Nothing remains asked of Paykit for SSO.
    - It shipped in the Paykit rc60–rc62 prereleases (3 Oct). rc60 pins pubky-noise at revision `42e00f22`, so [pubky-noise#39](https://github.com/pubky/pubky-noise/issues/39) no longer gates it.
11. **Scoped keys (K6).** *Answered by Andrei, 2 Oct;* the answers are in §2.9.
12. **Keys for child apps (K6, P1).** Key approvals are signed by the identity key, and a bundle can't be narrowed. Should the agent deliver keys through an agent-signed approval carrying a narrowed bundle (an SDK addition, tied to H1), or should each child app's key request go to the signer?

---

## 5. Asks per team

**Pubky core:**

- **By the beta (about 15 Oct):** answers to Q1–Q7.
- **First:** H5 and H6, which unblock pubky.app's [#2614](https://github.com/pubky/pubky-app/issues/2614) now. Please answer Q3 first.
- **Then:** own H1, K1, K3 (with Passport) and K4, then H3, and H2 if wanted. H1 and K1 are the critical path to SSO.
- **Last:** H4, once clients have moved.

**Passport:**

- **By the beta:** answer Q9, and co-author the agent protocol (K3) with core.
- **When H1 and K1 land:** P1 and P2.

No Passport change is needed for the beta stopgap (Passport sign-in on the Shop).

**Ring:**

**Status of the Ring answers (1 Oct):**

- R0 grant-auth release: in progress.
- R1 origin and scopes on the approval screen: agreed.
- R2 grant list and revoke: exists as [#369](https://github.com/pubky/pubky-ring/issues/369).
- Q8 auto-auth: developer-only.
- Agent grant: Ring asked for detail, which is in §2.8.

**Remaining asks:**

- **Now:** ship R0. Add the client id and plain-word scopes to the approval screen (R1). Land [#369](https://github.com/pubky/pubky-ring/issues/369) when its FFI and react-native-pubky dependencies release. Keep auto-auth out of reach in release builds.
- **When K1's request format is fixed:** the agent-grant screen (§2.8).
- **When H1 lands:** group #369's list by browser, and add revoke-browser.

**Bitkit:**

- **For the beta:** ship the authorize fix in [synonymdev/bitkit-android#1398](https://github.com/synonymdev/bitkit-android/issues/1398).
- **When K1's request format is fixed:** B1.

**Paykit:**

- Q10 is answered, and Y1 and Y2 are withdrawn.
- No remaining ask. [#169](https://github.com/pubky/paykit-rs/issues/169) now checks the handshake's static key against the signed key, with substitution tests (3 Oct). It shipped in the Paykit rc60–rc62 prereleases (3 Oct).

**pubky.app:**

- **Now, A1 = [#2614](https://github.com/pubky/pubky-app/issues/2614):**
  - Set `PUBKY_RUNTIME_AUTH_CLIENT_ID` to the origin host.
  - Keep its release gates; they are H5, H6 and R0.
  - Tell us the final Locks paths. The Shop's beta scope union uses the 1.12.0 cookie string ([#2719](https://github.com/pubky/pubky-app/issues/2719)) and will follow `/priv/locks.app/` if that ships.
  - We're glad to review #2614.
- **When P1 is on staging:** A2. Get the grant from the agent, and move recovery-phrase and file logins to Passport.

**Us (Shop):**

- **Now:** ship the three stopgaps.
- **When P1 lands:** F1. E1 follows pubky-chat Phase 2.
- **When K1 and H3 land:** F3.
- **Last:** F4.

We don't push to `pubky/*` or `synonymdev/*`. Every change in those repos is the owning team's.
