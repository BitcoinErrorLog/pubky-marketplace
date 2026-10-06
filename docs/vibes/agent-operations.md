# Agent Operations Charter

This charter records the operating rules used on the marketplace work. It is a project rulebook, not a process brand.

## Rules

1. **Write only inside approved repos.**  
   Rationale: marketplace work lands under the `BitcoinErrorLog` org; upstream PRs and any other org are the owner's boundary.

2. **Never let agents push, open PRs, or perform remote writes.**  
   Rationale: the parent or owner verifies remotes and decides when code leaves the machine.

3. **Name the worktree, branch, and HEAD in every brief.**  
   Rationale: concurrent marketplace work used many branches, and ambiguity caused stale-lineage risk.

4. **Use one agent per worktree.**  
   Rationale: two writers in one tree make diffs, proofs, and rollback provenance untrustworthy.

5. **Treat sibling repos as read-only unless explicitly assigned.**  
   Rationale: the umbrella handoff needs facts from Shop, service, Nexus, rails, verifier, and specs without drifting their branches.

6. **Prove before claiming.**  
   Rationale: a feature is real only after literal command output or a live deployed-stack proof shows it working.

7. **Paste exact proof commands and outputs into the ledger.**  
   Rationale: summaries hide which stack, identity, branch, or mode was actually tested.

8. **The parent re-runs cheap proofs before merge.**  
   Rationale: implementer reports are claims until the coordinator checks lint, typecheck, targeted tests, status, and key artifacts.

9. **Use live deployed-stack proofs for deployment claims.**  
   Rationale: local mocks cannot prove Railway/Vercel env, homeserver grants, relays, processor callbacks, or Nexus replay behavior.

10. **Never substitute stubs, mocks, TODOs, or placeholder behavior for product work.**  
    Rationale: the project already distinguishes deterministic test doubles from shipped behavior; blurring that boundary makes the ledger false.

11. **If a shortcut seems necessary, stop and ask.**  
    Rationale: scope pressure is not approval to ship fake or partial mechanics.

12. **Use a different model family for review than implementation.**  
    Rationale: independent failure modes caught real P1 issues in bridge, auth, deploy, and documentation work.

13. **Run Kimi external audit for secrets, keys, sessions, crypto, auth, and privacy.**  
    Rationale: messaging key custody, session bridge, AuthToken handling, attestors, and payment signing are sensitive surfaces.

14. **Cap fix-review rounds at three.**  
    Rationale: after three rounds, unresolved risky mechanisms are demoted or cut instead of consuming indefinite review time.

15. **Demote rather than force a complex mechanism through.**  
    Rationale: the step-up design kept the safe public-SDK path and rejected the wider token-to-session path.

16. **Do not deploy without a rollback path named first.**  
    Rationale: Vercel and Railway changes were bounded only when the previous deployment/redeploy path was known before action.

17. **Keep deploys service-scoped.**  
    Rationale: Railway stacks have independent services and volumes; rolling one service should not imply resetting another.

18. **State the data/volume consequence before destructive operations.**  
    Rationale: replay cursors, Postgres migrations, Lock Server identity, Paykit creator records, Fulcrum, and bitcoind state are coupled.

19. **Require human approval for money-path changes.**  
    Rationale: payment rails, signing keys, processor modes, and mainnet/testnet choices change user and operator risk.

20. **Require human approval for migrations that drop data.**  
    Rationale: forward-only schema drops can be acceptable on empty production or staging test data, but only as an explicit decision.

21. **Require human approval for external filings and compliance actions.**  
    Rationale: reports, tax, legal filings, and content-compliance roles are business authority, not agent authority.

22. **Require human approval for destructive ops.**  
    Rationale: resets, deletes, branch removals, volume wipes, and key rotations can destroy history or invalidate credentials.

23. **Require human approval for DNS/domain moves.**  
    Rationale: moving `shop.pubky.app` changes live user traffic and cannot be treated as a routine deploy.

24. **Require human approval for anything touching another org's repo.**  
    Rationale: upstream Pubky/Vibes PRs belong to the owner even when fork branches live under `BitcoinErrorLog`.

25. **Record every landed change in the ledger or docs.**  
    Rationale: future maintainers need provenance for what changed, what proof ran, and which gaps remain.

26. **Keep secrets named, not printed.**  
    Rationale: handoffs need to say `Railway variable PAYKIT_REQUEST_SIGNING_KEY`, not expose the value.

27. **Prefer source-of-truth docs over chat memory.**  
    Rationale: the current state lives in `docs/ecommerce/status.md`, deploy runbooks, ADRs, and the active plan.

28. **Mark unverifiable facts as unverifiable.**  
    Rationale: the handoff should be useful on day two, not falsely confident on day one.
