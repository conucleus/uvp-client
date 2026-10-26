/**
 * Typed-data single source: re-exports the plan/order/invite/finalize/signal
 * EIP-712 builders and validators owned by @uvp-eth/protocol-bindings. No
 * type or digest is redefined here.
 */
export {
  PRODUCT_SUBMIT_DOMAIN_NAME,
  PRODUCT_SUBMIT_DOMAIN_VERSION,
  PLAN_COMMIT_PRIMARY_TYPE,
  PLAN_COMMIT_TYPED_DATA_FIELDS,
  buildPlanCommitTypedData,
  buildProductSubmitTypedData,
  buildDerivedSignalTypedData,
  buildStageExecutorPatchTypedData,
  buildStageResourcePatchTypedData,
  buildUVPOrderFinalizeTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  validateUVPOrderFinalizeTypedData,
  validateUVPStageInviteAcceptTypedData,
  validateUVPStageInviteCreateTypedData,
  validateTypedDataForSigning,
} from '@uvp-eth/protocol-bindings';

export type {
  BuildPlanCommitTypedDataInput,
  BuildProductSubmitTypedDataInput,
  PlanCommitPayload,
  PlanCommitTypedData,
  ProductSubmitTypedData,
  ProductSubmitTypedDataField,
  SignalAuthorizationPayload,
  TypedDataSigningMismatchReason,
  UVPOrderFinalizeTypedData,
  UVPStageInviteAcceptTypedData,
  UVPStageInviteCreateTypedData,
} from '@uvp-eth/protocol-bindings';
