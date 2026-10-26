# @uvp-eth/uvp-client

Public UVP client SDK and executor CLI. One package, four entries: browser
hosts use `/browser`, scripts and bots use `/headless`, shared operation and
protocol primitives live in `/core`, and the executor binary is `/cli`.
Chain events and contract state are the only source of business truth; this
package produces and reads signals, it never owns orders, sessions, or keys.

## Entries

| Entry | Responsibility (one sentence) |
|---|---|
| `@uvp-eth/uvp-client/core` | Runtime-agnostic operation layer: `OperationName`/`SignedOperation`/`OperationResult`, one prepare+sign engine for all operations, direct/relay transports, buyer-intent vs birthAuthorizer split, plan-registration builders, signal build/decode/submit, product-service transport seam, validation, signing helpers, evidence hashing, and re-exported protocol typed data. |
| `@uvp-eth/uvp-client/browser` | Browser-host client: `createBrowserClient` exposes the same operation set through the injected EIP-1193 wallet (direct or relay); Product V3 client, session read model, deadline/format, and typed-data verification — no compiler/env/localStorage/private keys. |
| `@uvp-eth/uvp-client/headless` | Script/bot client: `createHeadlessClient` exposes the same operation set signed by a local private key (direct RPC or relay); Node plan compilation and the HookReady watcher remain extras, plus wallet handling and the non-spending doctor. |
| `@uvp-eth/uvp-client/cli` | Executor CLI: `plan compile/register`, `order birth-intent|birth-authorize|finalize`, `invite accept`, `signal submit`, `registry sign`, `wallet`, `doctor`, and the watcher commands (`chain-once`/`chain-watch`/`chain-signal`). |

There is no root entry and no wildcard export; consumers pick one of the four
subpaths. ABI, EIP-712 typed data, and canonical hashing are single-sourced in
`@uvp-eth/protocol-bindings`; API DTOs are single-sourced in
`@uvp-eth/product-dto`; Zhixu compilation is single-sourced in
`@uvp-eth/compiler` (headless only).

## Operations

`/core` owns the one operation vocabulary and execution path; shells only plug
in a signer and a delivery mode.

```ts
import { OPERATION_NAMES, prepareOperation, signOperation, createDirectTransport } from '@uvp-eth/uvp-client/core';

const prepared = prepareOperation({ operation: 'signal.submit', /* operation fields */ });
const signed = await signOperation(prepared, signer);
```

- Operation names: `plan.register`, `order.birth`, `order.finalize`,
  `invite.accept`, `signal.submit`, `stagePatch.submit`, `registry.write`.
- `SubmitMode = "direct" | "relay"`, passed to `createBrowserClient` /
  `createHeadlessClient`; the operation API is the same in both modes.
- Direct transport broadcasts the signed calls through an injected
  `sendCall` seam (wallet provider or RPC wallet); relay transport POSTs the
  `SignedOperation` envelope as JSON to `${relayUrl}${relayPath}` (default
  `/relay`) and expects `{status: "submitted"|"accepted", txHashes?, relayRef?,
  operation?}`. Relay failures carry `operation`/`code`/`retryable`
  (`OperationError`).
- Message operations (`order.finalize`, `invite.accept`, `registry.write`) and
  the buyer birth intent have no chain call: the shells sign them and the
  caller delivers them (order service, registry, birth relayer).

### Order birth: intent vs authorization

`core/birth.ts` keeps the two roles disjoint:

| Role | Builder | Signature | Delivery |
|---|---|---|---|
| buyer | `buildOrderBirthIntent` (`UVPOrderBirth/1` EIP-712: planId, orderId, buyer, termsHash, nonce, deadline) | buyer wallet | relay (`order.birth`, `role: "buyer-intent"`) |
| plan birthAuthorizer | `buildOrderBirthAuthorization` + `orderBirthAuthorizationCall` (`triggerOrderFromOutsideFor`) | birthAuthorizer wallet | direct (`order.birth`, `role: "birth-authorizer"`) or relay |

The authorization signer must equal `trigger.submitter` (the plan's
birthAuthorizer); the browser relay path refuses to sign a birth authorization.
The buyer intent commits terms/participants through `termsHash` and the exact
birth fact through `orderId` — no duplicate participant fields.

## Signed writes

All signed writes belong to the client, not to chain-services:

| Operation | Entry | Shape |
|---|---|---|
| `plan.register` | `browser` / `headless` / `cli` | `commitPlan` typed data + calldata, then `finalizePlan` |
| `order.birth` | `core` / `browser` / `headless` / `cli` | buyer intent (relay) or birthAuthorizer `triggerOrderFromOutsideFor` (direct) |
| `order.finalize` / `invite.accept` | `browser` / `headless` / `cli` | protocol-bindings UVPOrderFinalize / UVPStageInviteAccept typed data, validated before signing |
| `signal.submit` | `core` / `browser` / `headless` / `cli` | `UVPStateMachineSignal` typed data + `submitSignalFor` calldata |
| `stagePatch.submit` | `core` / `browser` / `headless` | stage executor/resource patch typed data + `applyStage*PatchFor` calldata |
| `registry.write` | `browser` / `headless` / `cli` | registry EIP-712 record, single-sourced in `@uvp-eth/zhixu-registry/eip712`; headless exposes `publishZhixuRecord`/`publishIdentityClaim` default builders |

The browser path never imports the compiler or reads private keys. The headless
path signs with a local private key. Registry storage/HTTP is not a client
transport: headless `publishZhixuRecord`/`publishIdentityClaim` build the
registry's own typed data (no local copy), sign it through `registry.write`, and
hand the signed operation to the caller's submitter.

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
│   ├── operations.ts           # operation names/envelope/prepare/sign/client
│   ├── transport.ts            # direct/relay operation delivery + receipt errors
│   ├── birth.ts                # buyer intent vs birthAuthorizer authorization
│   ├── registration.ts         # plan commit/finalize calldata builders
│   ├── product-transport.ts    # product HTTP transport + product API errors
│   ├── signing.ts              # private-key-from-env loading
│   ├── chain-target.ts         # evm/solana target vocabulary
│   ├── validation.ts           # address/bytes32/number validation
│   ├── evidence.ts             # canonical JSON + evidence hashes
│   ├── errors.ts               # executor error classification
│   └── signal/                 # HookReady decode, signal build/submit
├── browser/
│   ├── client.ts               # createBrowserClient (EIP-1193, direct/relay)
│   ├── write.ts                # provider sign/send primitives
│   ├── product/kernel/         # Product V3 client, config, draft, typed data
│   ├── wallet/                 # EIP-1193 provider, connector types, signing
│   ├── session/                # participant session read model
│   ├── tasks/deadline.ts       # UTC deadline parsing/formatting
│   └── format/                 # base-unit amount display
├── headless/
│   ├── client.ts               # createHeadlessClient (private key, direct/relay)
│   ├── plan.ts                 # Zhixu → registration args (compiler extra)
│   ├── watcher/                # scan/reorg, job store, execution receipts
│   ├── runtime.ts              # watch assembly, storage resolution, state-dir lock
│   ├── doctor.ts               # config/RPC/contract/wallet diagnostic
│   └── wallet.ts               # wallet env files, address derivation, faucet
└── cli/                        # command entry, operation wiring, commands/
```

## CLI

```bash
uvp-client --help
```

Operation commands accept `--mode direct|relay`, `--relay-url <url>`,
`--relay-path <path>` (default `/relay`) and `--dry-run`:

- `plan register`: compile, sign `plan.register`, deliver commit+finalize.
- `order birth-intent`: buyer signs `UVPOrderBirthIntent`; relay-delivered.
- `order birth-authorize`: birthAuthorizer signs and delivers
  `triggerOrderFromOutsideFor` from a `--birth <json>` file
  (`trigger`, `authorizations`, `birthFactAttribution`).
- `order finalize` / `invite accept`: sign the validated UVPOrderFinalize /
  UVPStageInviteAccept typed data; delivery stays with the order service.
- `signal submit`: sign `submitSignalFor` (relayable executor signal).
- `registry sign`: sign a registry EIP-712 record; registry HTTP stays in the
  registry package.

Watcher/executor commands remain: `wallet new|address`, `faucet info`,
`doctor`, `chain-once` / `chain-watch` (scan `HookReady` logs and submit
configured `submitSignal` callbacks; state persists under `--state-dir` unless
`--job-store memory`), and `chain-signal` (build or broadcast one `submitSignal`
transaction). `chain-once`/`chain-watch` exit `1` when a scan result carries a
non-benign error or a job ends `failed`/`dead_letter`.

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

`createBrowserClient` exposes the operation set through the injected wallet:

```ts
import { createBrowserClient } from '@uvp-eth/uvp-client/browser';

const operations = createBrowserClient({
  provider,                       // EIP-1193
  signer: walletAddress,
  mode: 'relay',                  // or 'direct'
  relayUrl: 'https://relay.example',
});

const signedIntent = await operations.sign({ operation: 'order.birth', role: 'buyer-intent', /* ... */ });
```

The browser relay path signs the buyer intent only; direct delivery requires the
signer to be the plan birthAuthorizer for `order.birth`.

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
- No registry storage or compiler in the browser entry; registry typed-data/record shape stays single-sourced in `@uvp-eth/zhixu-registry/eip712` (headless imports only that pure subpath, never `pg`).
- No order creation or order-level authorization; orders bind submitter
  wallets to source/signal permissions on `UVPStateMachine`.
- No key custody: CLI/wallet helpers read only explicit env vars and never
  print secrets.
- No escrow, release, refund, exchange, or payment-provider flows.
