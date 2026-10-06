# Marketplace Transaction Service

This is the server-authoritative marketplace sequencer defined by ADR 0019.

Current slice:

- closed `listing.register` and `inventory.reserve` command contracts;
- actor-scoped idempotency and changed-replay rejection;
- expected-revision conflicts;
- serialized in-memory command execution for sandbox tests;
- one-winner inventory reservation;
- immutable event records;
- liveness/readiness routes;
- commands disabled unless `MARKETPLACE_MODE=sandbox` is explicit.

Run locally:

```bash
npm run marketplace:dev
```

The sandbox listens on `127.0.0.1:3100` by default.

This in-memory adapter is not a deployment backend. It deliberately fails readiness when started through `npm run marketplace:start` without an explicit sandbox mode. PostgreSQL persistence, Pubky authentication, durable outbox workers, and Locks verification must land before non-sandbox commands are enabled.
