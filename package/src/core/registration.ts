/**
 * Plan registration transaction builders: encode the two-step Solidity
 * registration flow (`commitPlan` + `finalizePlan`) from precompiled register
 * arguments. Pure calldata only — no signer, network, or compiler import. The
 * ABI is the protocol-bindings state-machine ABI; the typed-data digest comes
 * from protocol-bindings' plan-commit builder.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
  STATE_MACHINE_ABI,
  buildPlanCommitTypedData,
  type PlanCommitTypedData,
} from '@uvp-eth/protocol-bindings';
import {
  normalizeAddressChecksummed,
  normalizeBytes32,
  parseBigNumberish,
  ValidationError,
} from './validation.js';

export type PlanInstructionOp = 'SIGNAL' | 'NOT' | 'AND' | 'OR' | 'DELAY';

export const PLAN_INSTRUCTION_OP_CODES: Readonly<Record<PlanInstructionOp, number>> = {
  SIGNAL: 0,
  NOT: 1,
  AND: 2,
  OR: 3,
  DELAY: 4,
};

export type PlanRegistrationInstruction =
  | {
    readonly op: 'SIGNAL';
    readonly sourceId: Hex | string;
    readonly signalId: Hex | string;
    readonly signalKey?: Hex | string;
  }
  | { readonly op: 'NOT' }
  | { readonly op: 'AND' | 'OR'; readonly arity: number }
  | { readonly op: 'DELAY'; readonly delaySeconds: number | string };

export interface PlanRegistrationHook {
  readonly hookId: Hex | string;
  readonly stageId: Hex | string;
  readonly hookName: Hex | string;
  readonly kind?: 'receive' | 'admission';
  readonly flags: number;
  readonly instructions: readonly PlanRegistrationInstruction[];
  readonly dependencyKeys: readonly (Hex | string)[];
  readonly routeId?: Hex | string;
}

export interface PlanRegistrationExecutorCandidate {
  readonly stageId: Hex | string;
  readonly executor: Address | string;
}

export interface PlanRegistrationArgs {
  readonly planId: Hex | string;
  readonly planHash: Hex | string;
  readonly hooksHash: Hex | string;
  readonly capabilitiesRoot: Hex | string;
  readonly dockRoutesRoot: Hex | string;
  readonly dockInterfaceRoot: Hex | string;
  readonly executorCandidatesRoot: Hex | string;
  readonly hooks: readonly PlanRegistrationHook[];
  readonly executorCandidates: readonly PlanRegistrationExecutorCandidate[];
}

export interface StateMachineCallConfig {
  readonly stateMachineAddress: Address | string;
  readonly chainId?: number;
}

export interface PlanTransactionCall {
  readonly address: Address;
  readonly functionName: 'commitPlan' | 'finalizePlan';
  readonly data: Hex;
  readonly chainId?: number;
}

export interface PlanCommitCallArgs {
  readonly publisher: Address | string;
  readonly birthAuthorizer?: Address | string;
  readonly deadline: bigint | number | string;
  readonly registration: PlanRegistrationArgs;
  readonly signature: Hex | string;
}

export interface PlanRegistrationBuild {
  readonly typedData: PlanCommitTypedData;
  readonly commitCall: PlanTransactionCall;
  readonly finalizeCall: PlanTransactionCall;
}

interface PlanCommitTuple {
  readonly publisher: Address;
  readonly hooksHash: Hex;
  readonly capabilitiesRoot: Hex;
  readonly dockRoutesRoot: Hex;
  readonly dockInterfaceRoot: Hex;
  readonly executorCandidatesRoot: Hex;
  readonly birthAuthorizer: Address;
  readonly deadline: bigint;
}

interface PlanCommitHookTuple {
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly hookName: Hex;
  readonly flags: number;
  readonly instructions: readonly CompactInstructionTuple[];
  readonly dependencyKeys: readonly Hex[];
}

interface CompactInstructionTuple {
  readonly op: number;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly arity: number;
  readonly delaySeconds: bigint;
}

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex;

export function buildPlanCommitTypedDataFor(
  config: Pick<StateMachineCallConfig, 'stateMachineAddress' | 'chainId'>,
  args: Pick<PlanCommitCallArgs, 'publisher' | 'birthAuthorizer' | 'deadline' | 'registration'>,
): PlanCommitTypedData {
  const commit = planCommitTuple(config, args);
  return buildPlanCommitTypedData({
    chainId: requireChainId(config.chainId),
    verifyingContract: normalizeAddressChecksummed(config.stateMachineAddress, 'stateMachineAddress'),
    publisher: commit.publisher,
    hooksHash: commit.hooksHash,
    capabilitiesRoot: commit.capabilitiesRoot,
    dockRoutesRoot: commit.dockRoutesRoot,
    dockInterfaceRoot: commit.dockInterfaceRoot,
    executorCandidatesRoot: commit.executorCandidatesRoot,
    birthAuthorizer: commit.birthAuthorizer,
    deadline: commit.deadline,
  });
}

export function buildPlanCommitCall(
  config: StateMachineCallConfig,
  args: PlanCommitCallArgs,
): PlanTransactionCall {
  const address = normalizeAddressChecksummed(config.stateMachineAddress, 'stateMachineAddress');
  const commit = planCommitTuple(config, args);
  const signature = normalizeSignature(args.signature);
  const hooks = encodePlanRegistrationHooks(args.registration.hooks);
  const executorCandidates = args.registration.executorCandidates.map((candidate) => ({
    stageId: normalizeBytes32(candidate.stageId, 'executorCandidates[].stageId'),
    executor: normalizeAddressChecksummed(candidate.executor, 'executorCandidates[].executor'),
  }));
  const data = encodeFunctionData({
    abi: STATE_MACHINE_ABI,
    functionName: 'commitPlan',
    args: [commit, hooks, executorCandidates, signature],
  });
  return callObject(address, 'commitPlan', data, config.chainId);
}

export function buildPlanFinalizeCall(
  config: StateMachineCallConfig,
  planId: Hex | string,
): PlanTransactionCall {
  const address = normalizeAddressChecksummed(config.stateMachineAddress, 'stateMachineAddress');
  const data = encodeFunctionData({
    abi: STATE_MACHINE_ABI,
    functionName: 'finalizePlan',
    args: [normalizeBytes32(planId, 'planId')],
  });
  return callObject(address, 'finalizePlan', data, config.chainId);
}

export function buildPlanRegistration(
  config: StateMachineCallConfig,
  args: PlanCommitCallArgs,
): PlanRegistrationBuild {
  return {
    typedData: buildPlanCommitTypedDataFor(config, args),
    commitCall: buildPlanCommitCall(config, args),
    finalizeCall: buildPlanFinalizeCall(config, args.registration.planId),
  };
}

export function encodePlanRegistrationHooks(
  hooks: readonly PlanRegistrationHook[],
): readonly PlanCommitHookTuple[] {
  if (hooks.length === 0) {
    throw new ValidationError('plan registration requires at least one hook');
  }
  return hooks.map((hook) => ({
    hookId: normalizeBytes32(hook.hookId, 'hooks[].hookId'),
    stageId: normalizeBytes32(hook.stageId, 'hooks[].stageId'),
    hookName: normalizeBytes32(hook.hookName, 'hooks[].hookName'),
    flags: normalizeFlags(hook.flags),
    instructions: hook.instructions.map(encodeInstruction),
    dependencyKeys: hook.dependencyKeys.map((key, index) =>
      normalizeBytes32(key, `hooks[].dependencyKeys[${index}]`)),
  }));
}

function planCommitTuple(
  config: StateMachineCallConfig,
  args: Pick<PlanCommitCallArgs, 'publisher' | 'birthAuthorizer' | 'deadline' | 'registration'>,
): PlanCommitTuple {
  const publisher = normalizeAddressChecksummed(args.publisher, 'publisher');
  return {
    publisher,
    hooksHash: normalizeBytes32(args.registration.hooksHash, 'hooksHash'),
    capabilitiesRoot: normalizeBytes32(args.registration.capabilitiesRoot, 'capabilitiesRoot'),
    dockRoutesRoot: normalizeBytes32(args.registration.dockRoutesRoot, 'dockRoutesRoot'),
    dockInterfaceRoot: normalizeBytes32(args.registration.dockInterfaceRoot, 'dockInterfaceRoot'),
    executorCandidatesRoot: normalizeBytes32(
      args.registration.executorCandidatesRoot,
      'executorCandidatesRoot',
    ),
    birthAuthorizer: args.birthAuthorizer === undefined
      ? publisher
      : normalizeAddressChecksummed(args.birthAuthorizer, 'birthAuthorizer'),
    deadline: parseBigNumberish(args.deadline, 'deadline'),
  };
}

function encodeInstruction(instruction: PlanRegistrationInstruction): CompactInstructionTuple {
  switch (instruction.op) {
    case 'SIGNAL':
      return {
        op: PLAN_INSTRUCTION_OP_CODES.SIGNAL,
        sourceId: normalizeBytes32(instruction.sourceId, 'instructions[].sourceId'),
        signalId: normalizeBytes32(instruction.signalId, 'instructions[].signalId'),
        arity: 0,
        delaySeconds: 0n,
      };
    case 'NOT':
      return {
        op: PLAN_INSTRUCTION_OP_CODES.NOT,
        sourceId: ZERO_BYTES32,
        signalId: ZERO_BYTES32,
        arity: 0,
        delaySeconds: 0n,
      };
    case 'AND':
    case 'OR':
      return {
        op: PLAN_INSTRUCTION_OP_CODES[instruction.op],
        sourceId: ZERO_BYTES32,
        signalId: ZERO_BYTES32,
        arity: normalizeArity(instruction.arity),
        delaySeconds: 0n,
      };
    case 'DELAY':
      return {
        op: PLAN_INSTRUCTION_OP_CODES.DELAY,
        sourceId: ZERO_BYTES32,
        signalId: ZERO_BYTES32,
        arity: 0,
        delaySeconds: parseBigNumberish(instruction.delaySeconds, 'instructions[].delaySeconds'),
      };
  }
}

function normalizeArity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new ValidationError('instructions[].arity must be a uint16-safe integer');
  }
  return value;
}

function normalizeFlags(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new ValidationError('hooks[].flags must be a uint8-safe integer');
  }
  return value;
}

function normalizeSignature(signature: Hex | string): Hex {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new ValidationError('signature must be a 65-byte hex string');
  }
  return signature as Hex;
}

function requireChainId(chainId: number | undefined): number {
  if (!Number.isSafeInteger(chainId) || chainId === undefined || chainId <= 0) {
    throw new ValidationError('chainId must be a positive integer for typed data');
  }
  return chainId;
}

function callObject(
  address: Address,
  functionName: PlanTransactionCall['functionName'],
  data: Hex,
  chainId: number | undefined,
): PlanTransactionCall {
  return {
    address,
    functionName,
    data,
    ...(chainId !== undefined ? { chainId } : {}),
  };
}
