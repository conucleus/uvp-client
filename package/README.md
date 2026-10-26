# @uvp-eth/uvp-client

Public UVP client SDK and executor CLI. One package, four entries: browser
hosts use `/browser`, scripts and bots use `/headless`, shared transport and
protocol primitives live in `/core`, and the executor binary is `/cli`.
Chain events and contract state are the only source of business truth; this
package produces and reads signals, it never owns orders, sessions, or keys.

## Entries

| Entry | Responsibility (one sentence) |
|---|---|
| `@uvp-eth/uvp-client/core` | Runtime-agnostic transport/auth-session seam, chain target, ABI-driven signal build/decode/submit, validation, signing helpers, and evidence hashing. |
| `@uvp-eth/uvp-client/browser` | Browser-host client: injected EIP-1193 wallet signing, Product V3 transport client, participant session read model, deadline/format derivations, and product typed-data verification — no env/localStorage/private-key access. |
| `@uvp-eth/uvp-client/headless` | Script/bot client: private-key wallet handling, `HookReady` watcher and watch runtime, watch-job store/retry, and the non-spending executor doctor. |
| `@uvp-eth/uvp-client/cli` | Executor CLI: `wallet`, `doctor`, `chain-once`/`chain-watch` (watch), and `chain-signal` (signal) over the headless/core entries. |

There is no root entry and no wildcard export; consumers pick one of the four
subpaths. ABI, EIP-712 typed data, and canonical hashing are single-sourced in
`@uvp-eth/protocol-bindings`; API DTOs are single-sourced in
`@uvp-eth/product-dto`.

## Local Commands

```bash
pnpm install
pnpm --filter @uvp-eth/uvp-client typecheck
pnpm --filter @uvp-eth/uvp-client test
pnpm --filter @uvp-eth/uvp-client build
```

`dist/` is a local, gitignored build output; `build` cleans it before compiling
so a tarball never carries modules that were removed from `src/`. Workspace
consumers import the TypeScript sources through the package `exports`; the
`bin` entry (`dist/cli/index.js`) exists after a build, and a packed tarball
carries both `src/` (for `exports`) and `dist/` (for the bin).

## Source Layout

```text
package/src/
├── core/                       # shared by browser and headless
│   ├── transport.ts            # product HTTP transport + product API errors
│   ├── signing.ts              # private-key-from-env loading
│   ├── chain-target.ts         # evm/solana target vocabulary
│   ├── validation.ts           # address/bytes32/number validation
│   ├── evidence.ts             # canonical JSON + evidence hashes
│   ├── errors.ts               # executor error classification
│   └── signal/                 # HookReady decode, submitSignal build/submit
├── browser/
│   ├── product/kernel/         # Product V3 client, config, draft, typed data
│   ├── wallet/                 # EIP-1193 provider, connector types, signing
│   ├── session/                # participant session read model
│   ├── tasks/deadline.ts       # UTC deadline parsing/formatting
│   └── format/                 # base-unit amount display
├── headless/
│   ├── watcher/                # scan/reorg, job store, execution receipts
│   ├── runtime.ts              # watch assembly, storage resolution, state-dir lock
│   ├── doctor.ts               # config/RPC/contract/wallet diagnostic
│   └── wallet.ts               # wallet env files, address derivation, faucet
└── cli/                        # command entry, options, output, commands/
```

## CLI

```bash
uvp-client --help
```

- `wallet new|address`, `faucet info`: local wallet material from explicit env
  vars; keys are never printed.
- `doctor`: non-spending diagnostic over a handler config, RPC chain id/head,
  state-machine contract code, and the signer wallet; exits non-zero on a
  failed check.
- `chain-once` / `chain-watch`: scan `HookReady` logs and submit configured
  `submitSignal` callbacks. State (jobs + scan cursor) persists under
  `--state-dir` unless `--job-store memory` is passed.
- `chain-signal`: build or broadcast one `submitSignal` transaction;
  `--dry-run` prints the deterministic call instead of broadcasting.

`chain-once`/`chain-watch` exit `1` when a scan result carries a non-benign
error or a job ends `failed`/`dead_letter`.

## Executor Config

```json
{
  "supplierId": "role-a",
  "walletAddress": "0x0000000000000000000000000000000000000002",
  "chainId": 31337,
  "stateMachineAddress": "0x0000000000000000000000000000000000000001",
  "stateMachines": [
    { "stateMachineAddress": "0x0000000000000000000000000000000000000001", "status": "active" }
  ],
  "dryRun": true,
  "retry": { "maxAttempts": 3, "baseDelayMs": 0 },
  "handlers": {
    "exec.main#START": {
      "signals": [
        { "source": "slot-a", "stageIdentifier": "exec.main", "signalName": "cmp" }
      ]
    }
  }
}
```

Handlers route by `stageIdentifier#hookName`, then `stageIdentifier`, hook id,
stage id, and finally `*`. A static signal may carry hashed `sourceId`/`signalId`
pairs instead of text names, and may pin its own `planId`.

## Browser Client

```ts
import {
  createProductClient,
  getBrowserEthereumProvider,
  requestProductSubmitSignature,
  verifyInviteAcceptTypedData,
  parseDeadlineUtcMs,
} from '@uvp-eth/uvp-client/browser';

const client = createProductClient({
  baseUrl: 'https://chain-services.example',
  getSessionToken: () => hostSessionToken(),
});
```

The host injects `baseUrl`, `fetch`, and the session-token reader; the package
never reads env/localStorage or private keys. Product API errors surface as
`ProductError` with `kind`/`status`/`errorCode` so hosts can branch on
`unauthorized`/`forbidden`/`not_found`/`conflict`/`gone`/`unavailable` rather
than parse messages.

## Watcher Defenses

- **Finality buffer**: scan only up to `head - confirmations` (default 1);
  declaring a non-local runtime makes an explicit positive `--confirmations`
  mandatory.
- **Cursor continuity**: block hashes plus spaced anchors detect reorgs and
  rescan from the common ancestor; a deeper reorg falls back to `--from-block`.
- **Chunked logs**: `--max-get-logs-block-span` splits deep `eth_getLogs`
  ranges.
- **Backoff**: failed polls back off exponentially; unconfirmed broadcasts are
  re-checked by receipt before any rebroadcast, with on-chain
  `SignalAlreadyExists` as the dedupe verdict.
- **Run claims**: pid-held claims prevent concurrent runs; dead claims are
  taken over by later scans or `retryStateMachineJob`, and an operator can
  `deadLetterStateMachineJob`/`reviveStateMachineJob` explicitly.

## ABI Boundary

`createStateMachineWatcher` uses the fixed `UVPStateMachine v0.15` compact-hook
ABI recorded in
`uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.17.json`:
`HookReady(bytes32 planId, bytes32 orderId, bytes32 hookId, bytes32 stageId,
bytes32 hookName)` and `submitSignal(planId, orderId, sourceId, signalId,
payloadHash, idempotencyKey, attribution)`. The kit consumes that surface only
through `@uvp-eth/protocol-bindings`' exported ABI and typed-data field tables —
never hand-copied here.

## Boundaries

- No HTTP server, no callback/job runtime process, and no database.
- No order creation or order-level authorization; orders bind submitter
  wallets to source/signal permissions on `UVPStateMachine`.
- No key custody: CLI/wallet helpers read only explicit env vars and never
  print secrets.
- No escrow, release, refund, exchange, or payment-provider flows.
