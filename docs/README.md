# Docs

## Shop launch

- [Beta launch and handoff plan](launch/shop-launch-plan.md): scope, decisions, the two-week timeline, infrastructure options and risks for the [shop.pubky.app](https://shop.pubky.app) beta.
- [Team brief](launch/shop-team-brief.md): repos, local setup, test and release rules, current status and first tasks for developers taking over the Shop.

## Single sign-on

- [SSO proposal](sso/sso-proposal-for-team.md): the problem, the proposed delegated-grant model, phases, per-repo changes and asks for each Pubky team.
- [SSO design](sso/pubky-sso-design.md): the design detail behind the proposal, with the code facts it rests on and the open questions for the Pubky core team.

## Other folders

- [spec-feedback/](spec-feedback/): technical briefs for upstream maintainers.
- [contributions/](contributions/): PR triage.
- [vibes/](vibes/) and [vrt/](vrt/): agent operations notes and visual-regression screenshots.

## How to comment

- **Questions, objections or answers to an open question:** [open an issue](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/new). Name the doc and section in the title, for example "SSO proposal §4 Q3: one bearer per grant".
- **Line-level comments:** open a pull request against `master` that edits the doc, or comment on lines in any open PR touching it.
- **Corrections and edits:** send a pull request with the change. Keep links between these docs relative so they work on GitHub and in clones.
