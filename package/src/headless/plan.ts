/**
 * Headless plan write surface: compile a Zhixu definition with the Node
 * compiler, then build, sign, and optionally submit the two-step plan
 * registration (commitPlan + finalizePlan). Signing and submission are
 * injected; no key material or RPC client is owned here.
 */
import {
  compileZhixuOnchainHookPlan,
  loadZhixuDefinition,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs,
  type OnchainHookPlanArtifact,
  type SolidityRegisterPlanArgs,
  type ZhixuDefinition,
} from '@uvp-eth/compiler';
import type { Address, Hex } from 'viem';
import {
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  type PlanRegistrationArgs,
  type PlanTransactionCall,
} from '../core/registration.js';
import type { PlanCommitTypedData } from '../core/typed-data.js';
import { ValidationError } from '../core/validation.js';
import type { TransactionSubmitter, TypedDataSigner } from './signers.js';

export interface CompilePlanInput {
  readonly definitionPath?: string;
  readonly definitionYaml?: string;
  readonly definition?: ZhixuDefinition;
  readonly publisher: Address;
}

export interface CompiledPlan {
  readonly artifact: OnchainHookPlanArtifact;
  readonly registerArgs: SolidityRegisterPlanArgs;
  readonly planId: Hex;
}

export interface RegisterPlanInput {
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly registration: PlanRegistrationArgs;
  readonly signer: TypedDataSigner;
  readonly deadline: bigint | number | string;
  readonly birthAuthorizer?: Address | string;
  readonly submit?: TransactionSubmitter;
}

export interface RegisteredPlan {
  readonly planId: Hex;
  readonly typedData: PlanCommitTypedData;
  readonly signature: Hex;
  readonly commitCall: PlanTransactionCall;
  readonly finalizeCall: PlanTransactionCall;
  readonly commitTxHash?: Hex;
  readonly finalizeTxHash?: Hex;
}

export async function compilePlan(input: CompilePlanInput): Promise<CompiledPlan> {
  const definition = await resolveDefinition(input);
  const artifact = compileZhixuOnchainHookPlan(definition);
  const registerArgs = toSolidityRegisterPlanArgs(artifact);
  return {
    artifact,
    registerArgs,
    planId: planIdForPublisher(input.publisher, registerArgs.planHash) as Hex,
  };
}

export function planRegistrationArgs(
  registerArgs: SolidityRegisterPlanArgs,
  planId: Hex | string,
): PlanRegistrationArgs {
  return {
    planId,
    planHash: registerArgs.planHash,
    hooksHash: registerArgs.hooksHash,
    capabilitiesRoot: registerArgs.capabilitiesRoot,
    dockRoutesRoot: registerArgs.dockRoutesRoot,
    dockInterfaceRoot: registerArgs.dockInterfaceRoot,
    executorCandidatesRoot: registerArgs.executorCandidatesRoot,
    hooks: registerArgs.hooks,
    executorCandidates: registerArgs.executorCandidates,
  };
}

export async function registerPlan(input: RegisterPlanInput): Promise<RegisteredPlan> {
  const typedData = buildPlanCommitTypedDataFor(
    { stateMachineAddress: input.stateMachineAddress, chainId: input.chainId },
    {
      publisher: input.signer.address,
      deadline: input.deadline,
      registration: input.registration,
      ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
    },
  );
  const signature = await input.signer.signTypedData(typedData);
  const commitCall = buildPlanCommitCall(
    { stateMachineAddress: input.stateMachineAddress, chainId: input.chainId },
    {
      publisher: input.signer.address,
      deadline: input.deadline,
      registration: input.registration,
      signature,
      ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
    },
  );
  const finalizeCall = buildPlanFinalizeCall(
    { stateMachineAddress: input.stateMachineAddress, chainId: input.chainId },
    input.registration.planId,
  );

  if (!input.submit) {
    return {
      planId: normalizePlanId(input.registration.planId),
      typedData,
      signature,
      commitCall,
      finalizeCall,
    };
  }

  const commitTxHash = await input.submit.sendTransaction({
    to: commitCall.address,
    data: commitCall.data,
    chainId: input.chainId,
  });
  const finalizeTxHash = await input.submit.sendTransaction({
    to: finalizeCall.address,
    data: finalizeCall.data,
    chainId: input.chainId,
  });
  return {
    planId: normalizePlanId(input.registration.planId),
    typedData,
    signature,
    commitCall,
    finalizeCall,
    commitTxHash,
    finalizeTxHash,
  };
}

async function resolveDefinition(input: CompilePlanInput): Promise<ZhixuDefinition> {
  const sources = [input.definitionPath, input.definitionYaml, input.definition]
    .filter((value) => value !== undefined);
  if (sources.length !== 1) {
    throw new ValidationError('compilePlan requires exactly one of definitionPath, definitionYaml, or definition');
  }
  if (input.definition !== undefined) {
    return input.definition;
  }
  if (input.definitionPath !== undefined) {
    return await loadZhixuDefinition(input.definitionPath);
  }
  return parseZhixuDefinition(input.definitionYaml as string);
}

function normalizePlanId(planId: Hex | string): Hex {
  if (typeof planId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(planId)) {
    throw new ValidationError('planId must be a 32-byte hex string');
  }
  return planId as Hex;
}
