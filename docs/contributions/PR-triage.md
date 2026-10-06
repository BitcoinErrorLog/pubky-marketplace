# Teammate PR triage

Record of `BitcoinErrorLog/pubky-app` contribution PRs against the Shop integration line. Newest first. Product diffs that duplicate a shipped wave are closed; tests that still gate a regression are kept.

## 2026-09-07

| PR | Author | Topic | Disposition |
| --- | --- | --- | --- |
| [#20](https://github.com/BitcoinErrorLog/pubky-app/pull/20) | icota | Tax removal | Closed as superseded by Wave 2b. The guard test was cherry-picked as `c003e374` on `marketplace/pr25-ux` under his authorship so a reintroduced tax field still fails CI. |
| [#22](https://github.com/BitcoinErrorLog/pubky-app/pull/22) | icota | Local pickup with post-payment reveal | Changes requested. Not merged as-is. Absorbed into Wave 7 "Local pickup with scheduling" (design in progress at `docs/ecommerce/local-pickup-design.md` on `marketplace/w7-design`). |

Wave 7 owner decisions recorded with this triage: buyer may cancel if pickup terms change after payment; seller may delete details; one meeting point per order; pickup off without the encryption key; either party confirms handover, no automatic delivery; no pickup details on sandbox deployments; returns re-choose pickup or shipping with optional seller label.

Address-sharing policy these PRs must not weaken: a physical address is shared only when its owner chooses to, for a reason shown to them, with the one person who needs it; buyer→seller only the delivery address for shipped items once the order exists; seller→buyer nothing by default except a deliberately published pickup point revealed only to the paying buyer.

Service context: marketplace-service `c697e5f` is deployed on both stacks (delivery auto-complete worker, return flow surfacing); migration 0019 verified. Wave 6 backlog batch `9483446f` and graduation dossier `2e022af5` are on the Shop client line.
