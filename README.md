# uvp-client

Public UVP client: one package with four entries — `core`, `browser`,
`headless`, and `cli`. It is the single client-side implementation for product
transport, participant signing, chain signal build/submit, and the executor
CLI; it never owns orders, sessions, keys, or a server process.

- `package/`: the `@uvp-eth/uvp-client` workspace package.

| Entry | Responsibility |
|---|---|
| `@uvp-eth/uvp-client/core` | Runtime-agnostic transport/auth, chain target, signal build/decode/submit, validation, signing helpers, evidence hashing. |
| `@uvp-eth/uvp-client/browser` | Injected EIP-1193 wallet signing + Product V3 client + session/deadline/format helpers; host injects provider and session. |
| `@uvp-eth/uvp-client/headless` | Private-key wallet handling, HookReady watcher/runtime, job store/retry, executor doctor. |
| `@uvp-eth/uvp-client/cli` | Executor commands: wallet, doctor, watch, signal. |

Dependencies are only `@uvp-eth/product-dto`, `@uvp-eth/protocol-bindings`,
`viem`, and `commander`; order-kernel is merged here, not re-exported.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The package depends
on `@uvp-eth/protocol-bindings` and `@uvp-eth/product-dto`, both owned by
`uvp-protocol`.

Use the `uvp-eth` umbrella checkout for local integration development so pnpm
can resolve cross-repository `workspace:*` dependencies. A standalone checkout
requires those two packages to be published or linked into an equivalent local
workspace.

Relayers and executors may submit transactions, but business actions must remain
signed by authorized participant keys.

## Boundaries

- Chain events and contract state are the source of truth.
- The browser entry never reads env/localStorage/private keys; the host injects
  the session token and EIP-1193 provider.
- The headless entry owns private-key handling for scripts/bots only.
- The package never creates order-level authorization, custodies keys, or runs
  escrow/settlement flows.
