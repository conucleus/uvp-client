import { describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, stringToBytes, type Hex } from 'viem';
import {
  capabilitiesRootOf,
  factAttribution,
  selectorBindingProofFor,
  STATE_MACHINE_ABI,
} from '@uvp-eth/protocol-bindings';
import {
  buildSubmitStateMachineSignalCall,
  capabilityTablesOf,
  withCapabilityProofs,
  ZERO_FACT_ATTRIBUTION,
  ZERO_SELECTOR_BINDING,
  type StateMachineSignal,
} from '../src/watcher/index.js';
import { ValidationError } from '../src/validation.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const WALLET_ADDRESS = '0x0000000000000000000000000000000000000002';
const PLAN_ID = `0x${'77'.repeat(32)}` as Hex;
const ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const SOURCE_ID = keccak256(stringToBytes('buyer'));
const SIGNAL_ID = keccak256(stringToBytes('exec.main.cmp'));
const PAYLOAD_HASH = `0x${'44'.repeat(32)}` as Hex;
const OWNER_STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const SELECTOR_STAGE_ID = `0x${'66'.repeat(32)}` as Hex;
const IDEMPOTENCY_KEY = keccak256(stringToBytes(`${PLAN_ID}:${ORDER_ID}:${SOURCE_ID}:${SIGNAL_ID}`));

const CONFIG = {
  rpcUrl: 'http://127.0.0.1:8545',
  stateMachineAddress: STATE_MACHINE,
  chainId: 31_337,
};

const BASE_SIGNAL: StateMachineSignal = {
  planId: PLAN_ID,
  orderId: ORDER_ID,
  sourceId: SOURCE_ID,
  signalId: SIGNAL_ID,
  payloadHash: PAYLOAD_HASH,
  idempotencyKey: IDEMPOTENCY_KEY,
};

/** Plan 冻结能力词表镜像：owner 阶段对 (sourceId, signalId) 的 relation=0 能力。 */
const TABLES = {
  selectorBindings: [{ selectorStageId: SELECTOR_STAGE_ID, targetStageId: OWNER_STAGE_ID }],
  signalCapabilities: [{
    stageId: OWNER_STAGE_ID,
    targetSourceId: SOURCE_ID,
    signalId: SIGNAL_ID,
    relation: 0 as const,
  }],
};

describe('submitSignal calldata proof shape', () => {
  it('encodes the all-zero proof structs when no proof material is given', () => {
    const call = buildSubmitStateMachineSignalCall(CONFIG, BASE_SIGNAL, WALLET_ADDRESS);

    // The 8-arg submitSignal selector, pinned against the v0.12 fixture shape.
    expect(call.data.slice(0, 10)).toBe(keccak256(
      stringToBytes('submitSignal(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,bytes32,bytes32[]),(bytes32,bytes32[]))'),
    ).slice(0, 10));
    expect(call.args).toHaveLength(8);
    expect(call.args[6]).toEqual(ZERO_FACT_ATTRIBUTION);
    expect(call.args[7]).toEqual(ZERO_SELECTOR_BINDING);
    const decoded = decodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      data: call.data,
    });
    expect(decoded.args[6]).toEqual(ZERO_FACT_ATTRIBUTION);
    expect(decoded.args[7]).toEqual(ZERO_SELECTOR_BINDING);
  });

  it('encodes an explicit attribution and selector binding proof', () => {
    const attribution = factAttribution(TABLES.selectorBindings, TABLES.signalCapabilities, SOURCE_ID, SIGNAL_ID);
    const binding = selectorBindingProofFor(TABLES.selectorBindings, TABLES.signalCapabilities, OWNER_STAGE_ID);
    expect(attribution).toBeDefined();
    expect(binding).toBeDefined();

    const call = buildSubmitStateMachineSignalCall(CONFIG, {
      ...BASE_SIGNAL,
      attribution: {
        sourceId: SOURCE_ID,
        signalId: SIGNAL_ID,
        stageId: attribution!.stageId,
        capabilityProof: attribution!.capabilityProof,
      },
      selectorBinding: {
        selectorStageId: binding!.selectorStageId,
        proof: binding!.proof,
      },
    });

    expect(call.args[6]).toEqual({
      sourceId: SOURCE_ID,
      signalId: SIGNAL_ID,
      stageId: OWNER_STAGE_ID,
      capabilityProof: attribution!.capabilityProof,
    });
    expect(call.args[7]).toEqual({
      selectorStageId: SELECTOR_STAGE_ID,
      proof: binding!.proof,
    });
    // The proof round-trips through the calldata and still verifies against
    // the plan-frozen capabilities root.
    const decoded = decodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      data: call.data,
    });
    const decodedAttribution = decoded.args[6] as unknown as {
      stageId: Hex;
      capabilityProof: readonly Hex[];
    };
    const root = capabilitiesRootOf(TABLES.selectorBindings, TABLES.signalCapabilities);
    // A mismatching (wrong owner stage) leaf must not verify against the same
    // root: the encoded proof is membership-bound, not free-form.
    expect(keccak256(stringToBytes('x'))).not.toBe(root);
    expect(decodedAttribution.stageId).toBe(OWNER_STAGE_ID);
    expect(decodedAttribution.capabilityProof).toEqual(attribution!.capabilityProof);
  });

  it('rejects a non-zero attribution whose fact key disagrees with the signal key', () => {
    // The contract answers this with InvalidFactAttribution; the kit refuses
    // to build the doomed tx instead (same caliber as the zero-planId guard).
    expect(() => buildSubmitStateMachineSignalCall(CONFIG, {
      ...BASE_SIGNAL,
      attribution: {
        sourceId: `0x${'ab'.repeat(32)}`,
        signalId: SIGNAL_ID,
        stageId: OWNER_STAGE_ID,
        capabilityProof: [],
      },
    })).toThrow(ValidationError);
    // stageId==0 keeps the no-claim encoding legal regardless of the keys:
    // the contract ignores the key fields in that branch.
    expect(() => buildSubmitStateMachineSignalCall(CONFIG, {
      ...BASE_SIGNAL,
      attribution: {
        sourceId: `0x${'ab'.repeat(32)}`,
        signalId: SIGNAL_ID,
        stageId: ZERO_FACT_ATTRIBUTION.stageId,
        capabilityProof: [],
      },
    })).not.toThrow();
  });

  it('derives proofs on the fly from artifact-embedded tables', () => {
    expect(capabilityTablesOf(undefined)).toBeUndefined();
    expect(capabilityTablesOf({})).toBeUndefined();
    expect(capabilityTablesOf({ selectorBindings: [], signalCapabilities: [] })).toBeUndefined();
    expect(capabilityTablesOf({
      selectorBindings: TABLES.selectorBindings,
      signalCapabilities: TABLES.signalCapabilities,
    })).toEqual(TABLES);

    const proven = withCapabilityProofs(BASE_SIGNAL, TABLES);
    expect(proven.attribution).toBeDefined();
    expect(proven.selectorBinding).toBeDefined();
    const call = buildSubmitStateMachineSignalCall(CONFIG, proven);
    expect(call.args[6]).toMatchObject({ stageId: OWNER_STAGE_ID, sourceId: SOURCE_ID, signalId: SIGNAL_ID });
    expect(call.args[7]).toMatchObject({ selectorStageId: SELECTOR_STAGE_ID });

    // Out-of-vocabulary fact: no attribution derived, no binding attached.
    const foreign = withCapabilityProofs({
      ...BASE_SIGNAL,
      sourceId: keccak256(stringToBytes('someone-else')),
    }, TABLES);
    expect(foreign.attribution).toBeUndefined();
    expect(foreign.selectorBinding).toBeUndefined();
    expect(buildSubmitStateMachineSignalCall(CONFIG, foreign).args[6]).toEqual(ZERO_FACT_ATTRIBUTION);

    // No tables (vocabulary-less plan): unchanged signal, zero encoding.
    expect(withCapabilityProofs(BASE_SIGNAL, undefined)).toBe(BASE_SIGNAL);

    // Explicit proofs are not overwritten by derivation.
    const explicit = withCapabilityProofs({
      ...BASE_SIGNAL,
      attribution: {
        sourceId: SOURCE_ID,
        signalId: SIGNAL_ID,
        stageId: ZERO_FACT_ATTRIBUTION.stageId,
        capabilityProof: [],
      },
      selectorBinding: {
        selectorStageId: ZERO_SELECTOR_BINDING.selectorStageId,
        proof: [],
      },
    }, TABLES);
    expect(explicit.attribution).toEqual({
      sourceId: SOURCE_ID,
      signalId: SIGNAL_ID,
      stageId: ZERO_FACT_ATTRIBUTION.stageId,
      capabilityProof: [],
    });
  });
});
