# Documentation

Project documents for the Pubky Marketplace come first; the Shop client's standards, conventions and architectural decisions follow under [Client standards and architecture](#client-standards-and-architecture).

## Shop launch

Handoff readiness lives in these two docs; start with the team brief.

- [Team brief](launch/shop-team-brief.md): repos, local setup, test and release rules, the current status, first tasks for each team, per-service release, deploy and rollback with known documentation gaps, and who to ask, for developers taking over the Shop.
- [Beta launch and handoff plan](launch/shop-launch-plan.md): this week's deadlines and what's frozen, launch blockers, the two-week timeline, infrastructure options, risks and the open decisions with who makes each, for the [shop.pubky.app](https://shop.pubky.app) beta.

## Single sign-on

- [SSO proposal](sso/sso-proposal-for-team.md): the problem, the proposed delegated-grant model, phases, per-repo changes and asks for each Pubky team.
- [SSO design](sso/pubky-sso-design.md): the design detail behind the proposal, with the code facts it rests on and the open questions for the Pubky core team.

## Other folders

- [marketplace-overview.md](marketplace-overview.md): every repository, branch and document behind the marketplace feature.
- [spec-feedback/](spec-feedback/): technical briefs for upstream maintainers.
- [contributions/](contributions/): PR triage.
- [vibes/](vibes/) and [vrt/](vrt/): agent operations notes and visual-regression screenshots.

## How to comment

- **Questions, objections or answers to an open question:** [open an issue](https://github.com/pubky/pubky-marketplace/issues/new). Name the doc and section in the title, for example "SSO proposal §4 Q3: one bearer per grant".
- **Line-level comments:** open a pull request against `master` that edits the doc, or comment on lines in any open PR touching it.
- **Corrections and edits:** send a pull request with the change. Keep links between these docs relative so they work on GitHub and in clones.

## Client standards and architecture

Single source of truth for all project standards, conventions, and architectural decisions.

### Quick Reference

| Working on...           | Read these docs                                                                   |
| ----------------------- | --------------------------------------------------------------------------------- |
| `src/core/`             | `architecture.md`, `local-first.md`, `error-handling.md`, `data-patterns.md`      |
| `src/components/`       | `components.md`, `skeleton-architecture.md`, `z-index.md`, `component-testing.md` |
| `src/libs/env/`         | `environment.md`                                                                  |
| Writing tests           | `component-testing.md`                                                            |
| Making commits          | `commit-message.md`                                                               |
| Architectural decisions | `adr-guidelines.md`, `adr/`                                                       |

### Documentation Files

| File                       | Description                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `architecture.md`          | Core layered architecture, dependency rules, anti-patterns                                            |
| `local-first.md`           | Local-first write patterns, controller naming, useLiveQuery rules                                     |
| `data-patterns.md`         | Composite IDs, streams, TTL, pipes normalization                                                      |
| `error-handling.md`        | Error conventions using AppError and Err.\* factories                                                 |
| `components.md`            | Component patterns, Shadcn, atomic design, Figma, **icon imports** (`lucide-react`, `@/icons`, utils) |
| `component-testing.md`     | Unit test and snapshot test rules                                                                     |
| `skeleton-architecture.md` | Skeleton loader placement, naming, and testing patterns                                               |
| `z-index.md`               | Z-index layering conventions                                                                          |
| `commit-message.md`        | Conventional commit format                                                                            |
| `environment.md`           | Environment variable configuration                                                                    |
| `adr-guidelines.md`        | When and how to write ADRs                                                                            |

#### Shop (marketplace)

| File                              | Description                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `ecommerce/onboarding.md`         | Start here: repositories, access, run, test, merge, who to ask                |
| `ecommerce/RUNNING.md`            | Running the marketplace locally in every mode, and the live test suites       |
| `ecommerce/release.md`            | Release train, VRT baselines, Vercel deploy, signed-in production proof, tags |
| `ecommerce/runbook-production.md` | Kill switch, rollback, Vercel domain moves, Railway restarts                  |
| `ecommerce/status.md`             | What is real and what is simulated                                            |

#### Migrations

| File                                     | Description                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `migrations/2305-i18n-conflict-guide.md` | Resolving branch conflicts against the i18n removal (delete after the open-PR wave clears) |

### Architecture Decision Records

Stored in `adr/`. See `architecture.md` for the full index.

### AI and Editor Workflows

This repository keeps documentation tool-agnostic, but some editor workflows are available for faster feedback loops.

- Cursor local code review: `/review` (skill definition in `.cursor/skills/code-review/SKILL.md`)
- Cross-tool AI entry point: see `../AGENTS.md`
- Commit message format: see `commit-message.md`

### Keeping Documentation Updated

When making significant changes to:

- **Core architecture**: Update `architecture.md` + create ADR
- **Component patterns** (layout, Shadcn, **icon import conventions**): Update `components.md`
- **Skeleton loaders**: Update `skeleton-architecture.md`
- **Error handling**: Update `error-handling.md`
- **Testing patterns**: Update `component-testing.md`
- **Environment variables**: Update `environment.md`
