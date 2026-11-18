# @uvp-eth/uvp-client

Public UVP client SDK and executor CLI. One package, six entries: browser
hosts use `/browser`, scripts and bots use `/headless`, shared operation and
protocol primitives live in `/core`, chain projection reads use `/chain-read`,
Node-only server tooling uses `/server`, and the executor binary is `/cli`.
Chain events and contract state are the only source of business truth; this
package produces and reads signals, it never owns orders, sessions, or keys.

## Entries

| Entry | Responsibility (one sentence) |
|---|---|
| `@uvp-eth/uvp-client/core` | Runtime-agnostic operation layer: `OperationName`/`SignedOperation`/`OperationResult`, one prepare+sign engine for all operations, direct/relay transports, signal build/decode/submit (order signals, trigger creation with orderId 0, pure file patches, optional signed `patchHash`), stage file read helpers (`getStageFile`/`stageFilesHash`), validation, signing helpers, evidence hashing, and re-exported protocol typed data. No Node builtins. |
| `@uvp-eth/uvp-client/chain-read` | Typed HTTP client for chain-services' generic `/chain/*` projection reads plus the bigint projection decoders; wire DTOs/structural decoders are single-sourced in `@uvp-eth/chain-read-contract`, failures stay typed (`invalid_config`/`timeout`/`transport`/`http`/`not_found`/`invalid_response`). |
| `@uvp-eth/uvp-client/server` | Node-only server tooling: server-side `@uvp-eth/compiler` primitives plus file-based evidence hashing. Never imported by `/browser` or `/core`. |
| `@uvp-eth/uvp-client/browser` | Browser-host client: `createBrowserClient` exposes the same operation set through the injected EIP-1193 wallet (direct or relay); wallet signing primitives, deadline/format derivations, and the stage supplier patch plus dock supplier selection typed-data surfaces — no compiler/env/localStorage/private keys. |
| `@uvp-eth/uvp-client/headless` | Script/bot client: `createHeadlessClient` exposes the same operation set signed by a local private key (direct RPC or relay); Node plan compilation and the HookReady watcher remain extras, plus wallet handling and the non-spending doctor. |
| `@uvp-eth/uvp-client/cli` | Executor CLI: `plan compile/register`, `order trigger|finalize`, `invite accept|create`, `registry sign`, `wallet`, `doctor`, and the watcher commands (`chain-once`/`chain-watch`/`chain-signal`). |

There is no root entry and no wildcard export; consumers pick one of the six
subpaths. ABI, EIP-712 typed data, plan-registration calldata, the HookReady
decoder, `filePatchHash`, and canonical hashing are single-sourced in
`@uvp-eth/protocol-bindings`; chain-read wire DTOs are single-sourced in
`@uvp-eth/chain-read-contract`; Zhixu compilation is single-sourced in
`@uvp-eth/compiler` (headless and server only). Used-car product DTOs and
product transport/kernel live in `@used-car/app-contract` and
`@used-car/product-client` (used-car repo), not in this package.

## Operations

`/core` owns the one operation vocabulary and execution path; shells only plug
in a signer and a delivery mode.

```ts
import { OPERATION_NAMES, prepareOperation, signOperation, createDirectTransport } from '@uvp-eth/uvp-client/core';

const prepared = prepareOperation({ operation: 'signal.submit', /* operation fields */ });
const signed = await signOperation(prepared, signer);
```

- Operation names: `plan.register`, `order.trigger`, `order.finalize`,
  `invite.accept`, `invite.create`, `signal.submit`, `stagePatch.submit`,
  `stageDock.select`, `registry.write`.
- `SubmitMode = "direct" | "relay"`, passed to `createBrowserClient` /
  `createHeadlessClient`; the operation API is the same in both modes.
- Direct transport broadcasts the prepared calls through an injected
  `sendCall` seam (wallet provider or RPC wallet); relay transport POSTs the
  `SignedOperation` envelope as JSON to `${relayUrl}${relayPath}` (default
  `/relay`) and expects `{status: "submitted"|"accepted", txHashes?, relayRef?,
  operation?}`. Relay failures carry `operation`/`code`/`retryable`
  (`OperationError`).
- Signal submissions (trigger creation and order signals) accept an empty
  signature on the direct path: `submitter` is the sending wallet, so direct
  execution needs no typed-data prompt. The relay path signs
  `UVPStateMachineSignalSubmission` typed data (domain `0.20`) and appends the
  65-byte participant signature to `submitSignal(SignalSubmission, bytes)`.
- Message operations (`order.finalize`, `invite.accept`, `invite.create`,
  `registry.write`) have no chain call: the shells sign them and the caller
  delivers them (order service/app backend, registry). `invite.create` signs
  the buyer's `UVPStageInviteCreate` terms (`UVPOrderBook/1`); the app backend
  verifies the buyer and then mints inviteId/token itself.

### Order trigger

Trigger creation is one `SignalSubmission` with `orderId = 0`; the protocol has
no buyer or birth-authorizer role:

```ts
const prepared = prepareOperation({
  operation: 'order.trigger',
  chainId,
  stateMachineAddress,
  signer: supplierAccount,
  signal: {
    planId,
    source: 'slot-a',
    stageIdentifier: 'exec.main',
    signalName: 'START',
    idempotencyKey,           // required: the contract keeps (submitter, key) -> orderId
  },
  deadline,
});
```

- The trigger signal must resolve to the plan's trigger hook and its stage's
  assigned supplier account; the state machine performs those checks.
- `idempotencyKey` is required for `order.trigger` and never generated
  silently: persisting it is what makes a retried trigger return
  `DuplicateTriggerKey(submitter, key, existingOrderId)` instead of creating a
  second order.
- The contract generates `orderId` (`keccak256(prevrandao, state machine,
  orderNonce)` with collision retry); the client never derives it. After a
  direct submission the result carries `orderId` decoded from the
  `SignalSubmitted` receipt log, and the `HookReady`/`SignalSubmitted` events
  are the authoritative source for callers that only have a transaction hash.
- `signal.submit` is the existing-order lane: `signalId != 0` is an order
  signal (first-writer-wins; a duplicate signal is absorbed but its file patch
  is still applied), `signalId == 0` is a pure stage file patch.

## Signed writes

All signed writes belong to the client, not to chain-services:

| Operation | Entry | Shape |
|---|---|---|
| `plan.register` | `browser` / `headless` / `cli` | 5-field `commitPlan` typed data + calldata (publisher/hooksHash/capabilitiesRoot/supplierBindingsRoot/deadline, with `supplierBindings`), then `finalizePlan` |
| `order.trigger` | `core` / `browser` / `headless` / `cli` | `SignalSubmission` with `orderId = 0`, submitter = trigger stage supplier; direct empty signature or relay `UVPStateMachineSignalSubmission` signature |
| `order.finalize` / `invite.accept` | `browser` / `headless` / `cli` | protocol-bindings UVPOrderFinalize / UVPStageInviteAccept typed data, validated before signing |
| `invite.create` | `core` / `browser` / `headless` / `cli` | buyer-signed UVPStageInviteCreate terms (`UVPOrderBook/1`, single-sourced in protocol-bindings) |
| `signal.submit` | `core` / `browser` / `headless` | `UVPStateMachineSignalSubmission` + `submitSignal` calldata: the signer is the source stage's assigned supplier account (SID active) and the delivering account is only the relayer (EOA ECDSA / contract EIP-1271) |
| `stagePatch.submit` | `core` / `browser` / `headless` | stage supplier patch typed data (supplierId/previousSupplierId/patchNonce) + `applyStageSupplierPatchFor` calldata |
| `stageDock.select` | `core` / `browser` / `headless` | dock supplier selection typed data (dockId/supplierId/patchNonce) + `selectStageDockSupplierFor` calldata |
| `registry.write` | `browser` / `headless` / `cli` | registry EIP-712 record, single-sourced in `@uvp-eth/protocol-bindings` (`UVPZhixuRegistry/1`); headless exposes `publishZhixuRecord`/`publishIdentityClaim` default builders |

Signal submission authority is the source stage's **assigned supplier
account** (plan default supplier, active stage-patch supplier, or the per-order
dynamic assignment; the SID must be active), resolved on chain from
`UVPSupplierRegistry.accountOf`; there is no order-level authorization array in
the client operation inputs or calldata. The selected supplier account is
permanently bound to its SID — there is no account rotation to track.

`idempotencyKey` is required non-zero on every submission; for order signals
and pure file patches it may be omitted and the client derives a stable
non-zero key from the signal identity (so retried watcher requests keep the
same calldata identity), while `order.trigger` always requires the caller's
persisted key. Deadlines are always present (default now + 1 hour, never zero)
and are rejected by the state machine once expired.

The browser path never imports the compiler or reads private keys. The headless
path signs with a local private key. Registry storage/HTTP is not a client
transport: headless `publishZhixuRecord`/`publishIdentityClaim` build the
registry's own typed data (no local copy), sign it through `registry.write`, and
hand the signed operation to the caller's submitter.

### Stage file patches

A stage file patch rides the same `SignalSubmission`: `filePatch` is the
protocol-bindings `FilePatch` shape and the signed `patchHash` is
`filePatchHash(filePatch)` (single-sourced in protocol-bindings). `filesDigest`
is not a client input — the contract computes it from `(planId, orderId,
filePatch)` after the order id exists.

- A standalone pure patch uses `orderId != 0`, `signalId = 0`, non-empty
  `filePatch.ops`; files are applied to the target stage with
  `signalStageId = 0`.
- An order signal may carry a patch too; the state machine absorbs a duplicate
  signal but still applies the patch independently.
- Write authority is the writer stage's assigned supplier account plus, for a
  cross-stage target, its `fileWriters` capability proof.
- `getStageFile` and `stageFilesHash` read the file resource module through the
  `FILE_RESOURCE_MODULE_ABI` exported by protocol-bindings. A failed or malformed
  read throws `StageFileReadError` (`invalid_config`/`read_failed`/`invalid_response`)
  instead of being reported as an empty file map entry.

## Wallet Sessions

`/browser` exposes a wallet-session transport: challenge → `personal_sign` →
verify → session token. The host injects wallet signing and the token store
(e.g. its own localStorage adapter); the package never reads env/localStorage
and never touches private keys.

```ts
import { createWalletSessionTransport } from '@uvp-eth/uvp-client/browser';

const session = createWalletSessionTransport({
  baseUrl: 'https://participants.example',
  personalSign: (address, message) => wallet.personalSign(message, address),
  tokenStore: { read: () => hostToken(), write: (token) => hostSaveToken(token) },
});

const { sessionToken, anchoredAddress } = await session.proveWalletControl(walletAddress);
```

Failures are `WalletSessionError` with an explicit `code`
(`invalid_config`/`invalid_address`/`signature_failed`/`timeout`/`transport`/
`redirect_refused`/`http`/`invalid_response`), `status`, server `errorCode` and
`retryable`, so hosts can distinguish "user rejected", "service down" and
"malformed response" instead of treating them all as logged out.

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
│   ├── registration.ts         # plan commit/finalize calldata builders
│   ├── signing.ts              # private-key-from-env loading
│   ├── chain-target.ts         # evm/solana target vocabulary
│   ├── validation.ts           # address/bytes32/number validation
│   ├── evidence.ts             # canonical JSON + evidence hashes
│   ├── errors.ts               # executor error classification
│   └── signal/                 # SignalSubmission build, HookReady/SignalSubmitted decode, submit
├── browser/
│   ├── client.ts               # createBrowserClient (EIP-1193, direct/relay)
│   ├── write.ts                # provider sign/send primitives
│   ├── wallet/                 # EIP-1193 provider, connector types, signing
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
- `order trigger`: submit `submitSignal` with `orderId = 0` from flags
  (`--plan-id`, `--source`, `--stage`, `--signal-name`,
  `--idempotency-key`, optional `--payload-hash`/`--attribution`/
  `--file-patch`/`--deadline-seconds`). Direct mode sends the empty-signature
  call and reports the generated `orderId` decoded from the receipt.
- `order finalize` / `invite accept`: sign the validated UVPOrderFinalize /
  UVPStageInviteAccept typed data; delivery stays with the order service.
- `invite create --payload <json>`: buyer signs `UVPStageInviteCreate` terms;
  delivery (minting the invite) stays with the app backend.
- `registry sign`: sign a registry EIP-712 record; registry HTTP stays in the
  registry package.

Watcher/executor commands remain: `wallet new|address`, `faucet info`,
`doctor`, `chain-once` / `chain-watch` (scan `HookReady` logs and submit
configured `submitSignal` callbacks; state persists under `--state-dir` unless
`--job-store memory`), and `chain-signal` (build or broadcast one direct
empty-signature `submitSignal` transaction; `--order-id` omitted/zero means
trigger creation). `chain-once`/`chain-watch` exit `1` when a scan result
carries a non-benign error or a job ends `failed`/`dead_letter`.

## Executor Config

```json
{
  "supplierId": "6f1a3c2d-8e4b-4a57-9c3d-1b2e4f6078a9",
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

`supplierId` here is optional watcher/job audit metadata (a SID UUID string);
on-chain submission authority still comes from the wallet key being the stage's
assigned supplier account. Handlers route by `stageIdentifier#hookName`, then
`stageIdentifier`, hook id, stage id, and finally `*`. A static signal may carry hashed `sourceId`/`signalId`
pairs instead of text names, may pin its own `planId`, and may provide an
`idempotencyKey`. The watcher derives one stable deadline per job from the
job's detection time, so retries and restarts rebuild identical calldata.

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

const signedTrigger = await operations.sign({ operation: 'order.trigger', /* ... */ });
```

In relay mode the wallet signs the trigger/signal submission typed data; the
relay pays for the transaction. In direct mode the wallet is the submitter and
the transaction carries the empty signature, so only one wallet prompt is
needed.

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

`createStateMachineWatcher` uses the fixed `UVPStateMachine` artifact ABI
recorded in
`uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.22.json`:
`HookReady(bytes32 planId, bytes32 orderId, bytes32 hookId, bytes32 stageId,
bytes32 hookName)`, `SignalSubmitted(bytes32 planId, bytes32 orderId, ...)`,
and `submitSignal((planId, orderId, sourceId, signalId, payloadHash,
idempotencyKey, attribution, filePatch, patchHash, submitter, deadline)
submission, bytes signature)`. The kit consumes that surface only through
`@uvp-eth/protocol-bindings`' exported ABI and typed-data field tables — never
hand-copied here.

## Boundaries

- No HTTP server, no callback/job runtime process, and no database.
- No registry storage or compiler in the browser entry; registry typed-data/record shape stays single-sourced in `@uvp-eth/protocol-bindings` (the client never depends on the registry storage package).
- No order creation, order-id derivation, or order-level authorization: trigger creation is a `submitSignal` with `orderId = 0` and the state machine generates the order id; signal submission authority is the stage's assigned supplier account, resolved on chain from `UVPSupplierRegistry` (SID must be active).
- No supplier registration or status writes: `UVPSupplierRegistry` SIDs are
  self-registered by the supplier account itself and activated/suspended/
  revoked by the platform store's registrar — this client has no such
  operation.
- No key custody: CLI/wallet helpers read only explicit env vars and never
  print secrets.
- No escrow, release, refund, exchange, or payment-provider flows.
