# uvp-executor-kit

Executor tooling boundary: an SDK and CLI for external executors that watch
chain events, build and submit authorized state-machine signals, hash evidence,
and sign participant typed data.

- `package/`: the `@uvp-eth/executor-kit` workspace package.

The kit is SDK + CLI only. It has no HTTP server, callback/job runtime, or
Product API client; order/product transport belongs to
`@uvp-eth/order-kernel` and ABI/EIP-712/hashing belongs to
`@uvp-eth/protocol-bindings`.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The package depends
on `@uvp-eth/protocol-bindings`, which is owned by `uvp-protocol`.

Use the `uvp-eth` umbrella checkout for local integration development so pnpm
can resolve cross-repository `workspace:*` dependencies. A standalone checkout
requires `@uvp-eth/protocol-bindings` to be published or linked into an
equivalent local workspace.

Relayers and executors may submit transactions, but business actions must remain
signed by authorized participant keys.

## Boundaries

- Chain events and contract state are the source of truth; the kit only
  produces signals for `UVPStateMachine`.
- The kit never creates order-level authorization, custodies keys, or runs
  escrow/settlement flows.
- Participant signing helpers are exported at
  `@uvp-eth/executor-kit/participant`; the typed-data types come from
  `@uvp-eth/protocol-bindings`.
