import { describe, expect, it } from 'vitest';
import contractArtifact from './contracts/state-machines.json';
import { commerceAggregateMachines } from './state-machines';
import {
  auctionStateSchema,
  dropStateSchema,
  listingStateSchema,
  offerStateSchema,
  orderStateSchema,
  paymentStateSchema,
  reservationStateSchema,
  returnStateSchema,
} from './transaction-contracts';

/**
 * Cross-language contract test (ADR-0022): the client's TypeScript state
 * tables and enums must match the Marketplace Transaction Service's canonical
 * artifact, vendored from `pubky-marketplace-service/contracts/state-machines.json`
 * (emitted by `cargo run -p marketplace-domain --bin emit-contracts`; the
 * service's own `contract_artifact_is_in_sync` test keeps that file honest).
 *
 * When the service contract changes, re-vendor the JSON and reconcile the
 * TypeScript tables — the service is canonical, so this test failing means the
 * CLIENT is wrong (or the vendored copy is stale), never that the test should
 * be loosened.
 */

type ContractTransition = {
  from: string;
  to: string;
  via: { trigger: string; name: string }[];
};

type ContractAggregate = {
  aggregate: string;
  states: string[];
  initial: string;
  transitions: ContractTransition[];
  commands: string[];
  unreachable_states: string[];
};

const aggregates = contractArtifact.aggregates as ContractAggregate[];

const stateEnumsByAggregate = {
  listing: listingStateSchema,
  reservation: reservationStateSchema,
  offer: offerStateSchema,
  auction: auctionStateSchema,
  order: orderStateSchema,
  payment: paymentStateSchema,
  return: returnStateSchema,
  drop: dropStateSchema,
} as const;

function clientEdges(transitions: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(transitions)
    .flatMap(([from, targets]) => targets.map((to) => `${from} -> ${to}`))
    .sort();
}

function contractEdges(transitions: ContractTransition[]): string[] {
  return transitions.map(({ from, to }) => `${from} -> ${to}`).sort();
}

describe('client contracts match the canonical service artifact', () => {
  it('covers exactly the aggregates the service declares', () => {
    expect(Object.keys(commerceAggregateMachines).sort()).toEqual(aggregates.map(({ aggregate }) => aggregate).sort());
    expect(Object.keys(stateEnumsByAggregate).sort()).toEqual(aggregates.map(({ aggregate }) => aggregate).sort());
  });

  it.each(aggregates.map((aggregate) => [aggregate.aggregate, aggregate] as const))(
    'matches the %s state vocabulary',
    (name, contract) => {
      const stateEnum = stateEnumsByAggregate[name as keyof typeof stateEnumsByAggregate];
      expect([...stateEnum.options].sort()).toEqual([...contract.states].sort());
    },
  );

  it.each(aggregates.map((aggregate) => [aggregate.aggregate, aggregate] as const))(
    'matches the %s initial state',
    (name, contract) => {
      const machine = commerceAggregateMachines[name as keyof typeof commerceAggregateMachines];
      expect(machine.initial).toBe(contract.initial);
    },
  );

  it.each(aggregates.map((aggregate) => [aggregate.aggregate, aggregate] as const))(
    'matches the %s transition edges',
    (name, contract) => {
      const machine = commerceAggregateMachines[name as keyof typeof commerceAggregateMachines];
      expect(clientEdges(machine.transitions)).toEqual(contractEdges(contract.transitions));
    },
  );

  it('declares the buyer-side listing.sync command on the listing aggregate', () => {
    // `listing.sync` is the service-side heal for listings published before
    // durable-mode registration existed: the service fetches the canonical
    // seller-signed homeserver record itself, so ANY authenticated user may
    // issue it. A vendored artifact missing it is stale.
    const listing = aggregates.find(({ aggregate }) => aggregate === 'listing');
    expect(listing?.commands).toContain('listing.sync');
    expect(listing?.commands).toContain('listing.register');
  });

  it.each(aggregates.map((aggregate) => [aggregate.aggregate, aggregate] as const))(
    'declares every %s state in the transition table, reachable or not',
    (name, contract) => {
      const machine = commerceAggregateMachines[name as keyof typeof commerceAggregateMachines];
      expect(Object.keys(machine.transitions).sort()).toEqual([...contract.states].sort());
      // Unreachable states must exist in the table but never be a target.
      const targets = new Set(Object.values<readonly string[]>(machine.transitions).flat());
      for (const unreachable of contract.unreachable_states) {
        expect(Object.keys(machine.transitions)).toContain(unreachable);
        expect(targets.has(unreachable)).toBe(false);
      }
    },
  );
});
