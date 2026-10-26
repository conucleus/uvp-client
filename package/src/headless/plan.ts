/**
 * Headless plan compilation extra: compile a Zhixu definition with the Node
 * compiler and expose its registration args. Registering a plan (sign/submit)
 * goes through the core plan.register operation; this module owns no write flow.
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
import { ValidationError } from '../core/validation.js';

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
