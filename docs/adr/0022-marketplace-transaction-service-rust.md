# ADR 0022: Marketplace Transaction Service Implemented in Rust

## Status

Accepted — 2026-08-20

## Context

ADR 0019 requires a separately deployable Marketplace Transaction Service with PostgreSQL persistence, real Pubky authentication, an append-only event log, and outbox workers. The prototype branch shipped a TypeScript service (`services/marketplace/`) with an in-memory repository, a forgeable actor header, and sandbox-only commands. That prototype encodes the domain rules well — its ~1,100-line test suite covers idempotency, revision checks, one-winner auctions, and state transitions — but it is explicitly not a deployment backend.

A production implementation language had to be chosen: harden the TypeScript service, or reimplement in Rust.

## Decision

The production Marketplace Transaction Service is implemented in **Rust**, alongside the rest of the Pubky server infrastructure (homeserver, Nexus).

- The TypeScript in-memory service is retained **only** as the labeled sandbox/demo adapter for local development and deterministic demos. It is never deployed as authority and its sandbox commands are rejected by the real service.
- The prototype's TypeScript test suite is the executable specification: every case is ported to the Rust suite, command by command, before the corresponding command is enabled.
- The canonical state/transition tables are defined once in the Rust service, which emits a machine-readable contract (JSON) that the web client's `src/libs/commerce` contracts are validated against in CI (cross-language contract tests).

## Consequences

### Positive ✅

- Consistent operations story with the other Pubky Rust services (packaging, deployment, observability).
- Stronger concurrency guarantees and cheaper correctness proofs for compare-and-swap inventory, proxy bidding, and ledger postings.
- Single source of truth for state machines eliminates the client/service enum divergence found in the prototype.

### Negative ❌

- Slower initial delivery than hardening the existing TypeScript service.
- The team maintains domain logic in Rust while the client contracts remain TypeScript; the generated contract artifact is a hard CI dependency.

### Neutral ⚠️

- The sandbox TypeScript service and the Rust service must agree on wire contracts; the same generated contract validates both.

## Alternatives Considered

### Harden the TypeScript prototype

**Pros**: reuses the existing code and test suite directly; fastest path to a durable sandbox.

**Cons**: a long-lived financial-invariant service in a runtime with weaker concurrency primitives; diverges operationally from the rest of the Pubky server stack.

**Why not chosen**: the service is permanent infrastructure; the port cost is bounded because the domain rules are already captured in portable tests.

## Related Decisions

- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
- [Marketplace implementation plan](../ecommerce/implementation-plan.md)
