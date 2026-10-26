# executor-kit

Executor **SDK + CLI** for the non-browser signal-producer surface of a UVP
deployment. The package watches `UVPStateMachine.HookReady` events, builds and
optionally submits authorized `submitSignal` callback transactions, hashes
off-chain evidence, and provides participant-wallet signing helpers.

The kit does **not** include an HTTP server, a callback/job runtime, or a
Product API client. Product/order transport belongs to
`@uvp-eth/order-kernel` (`/product/kernel`); ABI, EIP-712 typed data, and
canonical hashing belong to `@uvp-eth/protocol-bindings`. The kit imports both
directions one-way: kit → bindings; `order-kernel` never imports the kit.

## Local Commands

```bash
pnpm install
pnpm --filter @uvp-eth/executor-kit typecheck
pnpm --filter @uvp-eth/executor-kit test
pnpm --filter @uvp-eth/executor-kit build
```

`dist/` is a local, gitignored build output; `build` cleans it before compiling
so a tarball never carries modules that were removed from `src/`. Workspace
consumers import the TypeScript sources through the package `exports` and never
need `dist`; the `bin` entry (`dist/cli.js`) only exists after a build, and a
packed tarball carries both `src/` (for the `exports` map) and `dist/` (for the
bin).

## Source Layout

```text
package/src/
├── index.ts                   # SDK public surface
├── cli.ts                     # CLI entry: main/buildProgram and bin (dist/cli.js)
├── cli/
│   ├── commands/              # chain(watch/signal), doctor, wallet command groups
│   ├── options.ts             # CLI option shapes and parsing helpers
│   ├── output.ts              # scan-result exit-code adaptation
│   └── watcher.ts             # CLI watcher assembly (state-dir lock, storage, runtime env)
├── doctor.ts                  # non-spending config/RPC/contract/wallet diagnostic
├── watcher/
│   ├── watcher.ts             # scan and execution orchestration
│   ├── scan/logs.ts           # block chunking and log ordering
│   ├── scan/reorg.ts          # finality buffer, checkpoints, common-ancestor rollback
│   ├── jobs/                  # job model/store contract, retry, dead-letter, revive
│   ├── storage/               # memory/file job store, cursor store, state-dir lock
│   └── execution/             # handler config and receipt outcome rules
├── signal/                    # HookReady decode, submitSignal build, submission
├── participant/               # participant-wallet EIP-712 signing helpers
├── chain-target.ts            # target-chain vocabulary (evm/solana reservation)
├── evidence.ts                # canonical JSON and evidence hashes
├── errors.ts                  # executor error classification
├── signing.ts                 # private-key-from-env loading
├── transport.ts               # bigint-safe JSON output
├── validation.ts              # address/bytes32/number validation
└── wallet.ts                  # local wallet env-file and faucet helpers
```

## CLI

```bash
uvp-executor --help
```

### Wallet

```bash
uvp-executor wallet new --env-file .env.local
uvp-executor wallet address --private-key-env UVP_ETH_DEPLOYER_PRIVATE_KEY
uvp-executor faucet info --network base-sepolia --address 0x...
```

Wallet commands read keys only from explicit env vars (or write a new key to a
`0600` env file) and never print private key material.

### Doctor

Non-spending diagnostic for a config, RPC, state-machine deployment, and signer
wallet. It prints a JSON report and exits non-zero when any check fails.

```bash
uvp-executor doctor --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json

uvp-executor doctor \
  --rpc-url http://127.0.0.1:8545 \
  --chain-id 31337 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --wallet-address 0x0000000000000000000000000000000000000002

uvp-executor doctor \
  --config ./executor.json \
  --rpc-url http://127.0.0.1:8545 \
  --chain-id 31337 \
  --private-key-env UVP_EXECUTOR_PRIVATE_KEY
```

Checks: `config` (handler config normalization plus warnings for missing
wallet/chain/state-machine settings), `wallet` (signer address derived from the
named env var, compared with `--wallet-address`), `rpc` (chain id and head),
`chain-id` (probed chain id against `--chain-id`), and `state-machine` (contract
code at the address). No transaction is signed or broadcast.

### Watch

Scan `HookReady` logs once or continuously and submit dry-run/real callback
transactions:

```bash
uvp-executor chain-once \
  --rpc-url http://127.0.0.1:8545 \
  --chain-id 31337 \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --dry-run

uvp-executor chain-watch \
  --rpc-url http://127.0.0.1:8545 \
  --chain-id 31337 \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json \
  --dry-run
```

The fixture config declares its own `stateMachines[]` scan set. An explicit
`--state-machine` flag together with a config `stateMachines[]` is rejected —
the flag would otherwise be silently ignored by the scan set. Pass
`--state-machine` only when the config declares no `stateMachines[]`.

By default the chain commands persist watcher state to files so a restart
resumes where the previous process stopped instead of rescanning from
`--from-block`: jobs land in `<state-dir>/jobs.json` and the scan cursor (the
next block to scan) in `<state-dir>/cursor.json`. The state directory defaults
to `./uvp-watcher-state`, overridden by `--state-dir` or the
`UVP_WATCHER_STATE_DIR` env var; `--jobs-file <path>` places the jobs file
exactly at that path with the cursor beside it. The startup log reports the
resolved storage mode and paths. Pass `--job-store memory` to keep jobs and the
cursor in process memory; a persisted cursor whose chain id, state-machine set,
or chain genesis hash no longer matches the configuration is discarded with an
operator alert and rewritten on the next successful round (a reset dev chain at
the same chain id is caught by the genesis hash, not silently adopted).

State files are written atomically (temp file + rename). A crash-truncated or
structurally invalid `jobs.json`/`cursor.json` is moved aside to
`<file>.corrupt-<timestamp>` for inspection and recreated from scratch instead
of aborting every later read. Writers to one jobs file serialize through a
lock file beside it (`<jobs-file>.lock`, broken by age when a holder crashes),
and a state-dir process lock keeps two watchers off the same state directory.

### Signal

Build one `submitSignal` transaction, or broadcast it without running the
watcher:

```bash
uvp-executor chain-signal \
  --rpc-url http://127.0.0.1:8545 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --chain-id 31337 \
  --plan-id 0x2222222222222222222222222222222222222222222222222222222222222222 \
  --order-id 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --source slot-a \
  --stage exec.main \
  --signal-name cmp \
  --payload-hash 0x3333333333333333333333333333333333333333333333333333333333333333 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --dry-run
```

`--dry-run` only builds and prints what would be sent; without it the command
broadcasts by default. `--payload-ref` is rejected up front because
`submitSignal` has no payload-reference field; only the 32-byte `payloadHash`
goes on chain.

### Exit Codes

`chain-once`/`chain-watch` exit `1` when a scan result carries an error (except
the benign `missing_handler`/`duplicate_signal` outcomes) or when a job ends
`failed`/`dead_letter`. Schedulers should treat a non-zero exit as a failed
round.

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

## Watcher Defenses

- **Finality buffer**: each round scans only up to `head - confirmations`
  (default 1), so a short reorg cannot flip already-processed logs and their
  confirmed submissions behind the cursor. `--confirmations 0` restores tip
  scanning for throwaway local chains. Declaring a non-local runtime
  (`--runtime-env <env>` or `UVP_EXECUTOR_RUNTIME_ENV`) makes an explicit
  positive `--confirmations` mandatory.
- **Cursor block-hash continuity**: each successful round remembers the
  canonical hash of its last scanned block (plus exponentially spaced anchors
  inside the reorg window, default 64 blocks). On mismatch the watcher walks
  the anchors to the common ancestor and rescans from there; a reorg deeper
  than the window falls back to rescanning from `--from-block`.
- **Chunked log reads**: scan ranges larger than `--max-get-logs-block-span`
  (default 9999) are split into multiple `eth_getLogs` calls.
- **Poll backoff**: the watch loop never aborts on failed polls; consecutive
  failures back off exponentially (capped at 8x) and return to the configured
  cadence on the first successful round.
- **Resend backoff**: open jobs behind the cursor are revisited on later scans.
  A signal whose prior broadcast was never confirmed is settled by evidence
  first; only an unobtainable receipt triggers a rebroadcast with exponential
  backoff (30s base, 10min cap). On-chain dedupe stays the contract's
  `SignalAlreadyExists` check on the `(planId, orderId, sourceId, signalId)`
  tuple.
- **Run claims**: a job run is claimed by pid, so a second executor cannot run
  the same job concurrently. A claim whose pid is dead is taken over by later
  scans or a manual retry; a pid that reads alive but is not the executor can be
  cleared through the SDK dead-letter path.

The SDK exposes `retryStateMachineJob`, `deadLetterStateMachineJob`, and
`reviveStateMachineJob` for operator tooling; the CLI intentionally has no job
command group.

## ABI Boundary

`createStateMachineWatcher` uses the fixed `UVPStateMachine v0.15` compact-hook
ABI recorded in
`uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.17.json`:

- `HookReady(bytes32 planId, bytes32 orderId, bytes32 hookId, bytes32 stageId, bytes32 hookName)`;
- `submitSignal(bytes32 planId, bytes32 orderId, bytes32 sourceId, bytes32 signalId, bytes32 payloadHash, bytes32 idempotencyKey, (bytes32 sourceId, bytes32 signalId, bytes32 stageId, bytes32[] capabilityProof) attribution)`.

The kit consumes that surface only through `@uvp-eth/protocol-bindings`'s
exported ABI and typed-data field tables — never hand-copied here. The
`PRODUCT_SUBMIT` typed data keeps its frozen shape with the domain version
pinned by `@uvp-eth/protocol-bindings` (`UVPStateMachine` version `0.15`).

### Capability Proof Material (artifact index)

The watcher's `artifact` index may embed the two plan-frozen table mirrors:

```json
{
  "artifact": {
    "selectorBindings": [
      { "selectorStageId": "0x…", "targetStageId": "0x…" }
    ],
    "signalCapabilities": [
      { "stageId": "0x…", "targetSourceId": "0x…", "signalId": "0x…", "relation": 0 }
    ]
  }
}
```

When the tables are present, submissions derive proofs on the fly via
`@uvp-eth/protocol-bindings`'s `factAttribution`: a signal whose
`(sourceId, signalId)` hits a relation=0 capability submits with the owner
attribution; an out-of-vocabulary signal and a table-less artifact both submit
the all-zero struct. An explicit `attribution` field on a signal is never
overwritten by derivation. A non-zero `stageId` whose attribution keys disagree
with the signal keys is refused at build time (the contract's
`InvalidFactAttribution` is a guaranteed revert).

### Zero `payloadHash` Semantics

In `submitSignal(bytes32 ..., bytes32 payloadHash, bytes32 ...)`, the value
`bytes32(0)` is the protocol-defined encoding of "no payload". When a
handler/config signal definition omits `payloadHash`, the kit encodes exactly
`bytes32(0)`: the producer's explicit declaration that the signal carries no
off-chain payload. Any non-empty payload must be declared with its full 32-byte
hash.

## SDK Surface

- `createStateMachineWatcher`: watches `HookReady` logs, resolves handlers, and
  submits callback signals.
- `submitStateMachineSignal`: builds and optionally broadcasts
  `UVPStateMachine.submitSignal` transactions.
- `buildSubmitStateMachineSignalCall`: returns deterministic dry-run call data.
- `decodeHookReadyLog` and `hookReadyEventId`: normalize state-machine logs.
- `InMemoryStateMachineJobStore` and `FileStateMachineJobStore`: record watcher
  job state for retries and dead-lettering.
- `FileStateMachineCursorStore`: persists the watcher scan cursor (pass it as
  `cursorStore` to `createStateMachineWatcher`) so a restarted watcher resumes
  instead of rescanning from `fromBlock`.
- `retryStateMachineJob`, `deadLetterStateMachineJob`, `reviveStateMachineJob`:
  operator recovery over the watcher job store.
- `runExecutorDoctor`: the non-spending config/RPC/contract/wallet diagnostic
  used by the CLI `doctor` command.
- `hashEvidenceFile`: hashes off-chain evidence without storing plaintext.
- `loadPrivateKeyFromEnv`: loads a wallet key from an explicit env var without
  logging it.
- `@uvp-eth/executor-kit/participant`: EIP-1193 participant-wallet typed-data
  signing helpers; re-exports the protocol-bindings typed-data surface.

## Boundaries

- The kit does not create order-level authorization. Orders must already bind
  submitter wallets to source/signal permissions on `UVPStateMachine`.
- The kit does not custody private keys. CLI commands read only explicit env
  vars and never print secrets.
- The kit does not run escrow, release, refund, exchange, or payment-provider
  flows.
- The kit does not implement Product/order transport; use
  `@uvp-eth/order-kernel/product/kernel` for that boundary.
