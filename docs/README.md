# Docs

## Shop launch

Handoff readiness lives in these two docs; start with the team brief.

- [Team brief](launch/shop-team-brief.md): repos, local setup, test and release rules, the current status, first tasks for each team, per-service release, deploy and rollback with known documentation gaps, and who to ask, for developers taking over the Shop.
- [Beta launch and handoff plan](launch/shop-launch-plan.md): this week's deadlines and what's frozen, launch blockers, the two-week timeline, infrastructure options, risks and the open decisions with who makes each, for the [shop.pubky.app](https://shop.pubky.app) beta.

## Single sign-on

- [SSO proposal](sso/sso-proposal-for-team.md): the problem, the proposed delegated-grant model, phases, per-repo changes and asks for each Pubky team.
- [SSO design](sso/pubky-sso-design.md): the design detail behind the proposal, with the code facts it rests on and the open questions for the Pubky core team.

## Other folders

- [spec-feedback/](spec-feedback/): technical briefs for upstream maintainers.
- [contributions/](contributions/): PR triage.
- [vibes/](vibes/) and [vrt/](vrt/): agent operations notes and visual-regression screenshots.

## How to comment

- **Questions, objections or answers to an open question:** [open an issue](https://github.com/pubky/pubky-marketplace/issues/new). Name the doc and section in the title, for example "SSO proposal §4 Q3: one bearer per grant".
- **Line-level comments:** open a pull request against `master` that edits the doc, or comment on lines in any open PR touching it.
- **Corrections and edits:** send a pull request with the change. Keep links between these docs relative so they work on GitHub and in clones.
