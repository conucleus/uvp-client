/**
 * Plan registration surface: the transaction builders are owned by
 * @uvp-eth/protocol-bindings; this module re-exports them and validates a
 * compiled registration minimally before it becomes an operation.
 */
import type { Hex } from 'viem';
import type {
  PlanRegistrationArgs,
  PlanRegistrationSource,
} from '@uvp-eth/protocol-bindings';
import { planRegistrationArgs } from '@uvp-eth/protocol-bindings';
import { ZERO_BYTES32 } from './constants.js';
import { normalizeBytes32, ValidationError } from './validation.js';

export interface CompiledPlanRegistration extends PlanRegistrationSource {
  readonly planId: Hex | string;
}

export function planRegistrationFromCompiled(compiled: CompiledPlanRegistration): PlanRegistrationArgs {
  const planId = requireNonZeroBytes32(compiled.planId, 'planId');
  const planHash = requireNonZeroBytes32(compiled.planHash, 'planHash');
  const hooksHash = requireNonZeroBytes32(compiled.hooksHash, 'hooksHash');
  const capabilitiesRoot = requireBytes32(compiled.capabilitiesRoot, 'capabilitiesRoot');
  const supplierBindingsRoot = requireBytes32(compiled.supplierBindingsRoot, 'supplierBindingsRoot');
  if (!Array.isArray(compiled.hooks) || compiled.hooks.length === 0) {
    throw new ValidationError('compiled plan registration requires at least one hook');
  }
  for (const [index, hook] of compiled.hooks.entries()) {
    if (typeof hook !== 'object' || hook === null) {
      throw new ValidationError(`hooks[${index}] must be an object`);
    }
    requireBytes32(hook.hookId, `hooks[${index}].hookId`);
    requireBytes32(hook.stageId, `hooks[${index}].stageId`);
    requireBytes32(hook.hookName, `hooks[${index}].hookName`);
    if (!Array.isArray(hook.dependencyKeys) || hook.dependencyKeys.length === 0) {
      throw new ValidationError(`hooks[${index}].dependencyKeys must not be empty`);
    }
  }
  if (!Array.isArray(compiled.supplierBindings)) {
    throw new ValidationError('compiled plan registration requires a supplierBindings array');
  }
  return planRegistrationArgs(
    {
      planHash,
      hooksHash,
      capabilitiesRoot,
      supplierBindingsRoot,
      hooks: compiled.hooks,
      supplierBindings: compiled.supplierBindings,
    },
    planId,
  );
}

function requireBytes32(value: Hex | string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

function requireNonZeroBytes32(value: Hex | string, field: string): Hex {
  const normalized = requireBytes32(value, field);
  if (normalized === ZERO_BYTES32) {
    throw new ValidationError(`${field} must be a non-zero bytes32`);
  }
  return normalized;
}

export {
  PLAN_INSTRUCTION_OP_CODES,
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  buildPlanRegistration,
  encodePlanRegistrationHooks,
  planRegistrationArgs,
  supplierIdFromUuid,
  uuidFromSupplierId,
} from '@uvp-eth/protocol-bindings';

export type {
  PlanCommitCallArgs,
  PlanInstructionOp,
  PlanRegistrationArgs,
  PlanRegistrationBuild,
  PlanRegistrationHook,
  PlanRegistrationInstruction,
  PlanRegistrationSource,
  PlanTransactionCall,
  StageSupplierBinding,
  StateMachineCallConfig,
  SupplierBindingKind,
} from '@uvp-eth/protocol-bindings';
