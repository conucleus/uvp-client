/**
 * Typed-data single source: re-exports the plan/order/invite/finalize/signal/
 * patch/dock EIP-712 builders and validators owned by
 * @uvp-eth/protocol-bindings. No type or digest is redefined here.
 */
export {
  PLAN_COMMIT_PRIMARY_TYPE,
  PLAN_COMMIT_TYPED_DATA_FIELDS,
  PRODUCT_SUBMIT_DOMAIN_NAME,
  PRODUCT_SUBMIT_DOMAIN_VERSION,
  SIGNAL_SUBMISSION_PRIMARY_TYPE,
  SIGNAL_SUBMISSION_TYPED_DATA_FIELDS,
  STAGE_DOCK_SUPPLIER_SELECTION_PRIMARY_TYPE,
  STAGE_DOCK_SUPPLIER_SELECTION_TYPED_DATA_FIELDS,
  STAGE_SUPPLIER_PATCH_PRIMARY_TYPE,
  STAGE_SUPPLIER_PATCH_TYPED_DATA_FIELDS,
  buildDerivedSignalTypedData,
  buildPlanCommitTypedData,
  buildSignalSubmissionTypedData,
  buildStageDockSupplierSelectionTypedData,
  buildStageSupplierPatchTypedData,
  buildUVPOrderFinalizeTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  factAttributionHash,
  recoverSignalSubmissionSigner,
  recoverStageDockSupplierSelectionSigner,
  validateTypedDataForSigning,
  validateUVPOrderFinalizeTypedData,
  validateUVPStageInviteAcceptTypedData,
  validateUVPStageInviteCreateTypedData,
} from '@uvp-eth/protocol-bindings';

export type {
  BuildPlanCommitTypedDataInput,
  BuildSignalSubmissionTypedDataInput,
  BuildStageDockSupplierSelectionTypedDataInput,
  BuildStageSupplierPatchTypedDataInput,
  PlanCommitPayload,
  PlanCommitTypedData,
  ProductSubmitTypedData,
  ProductSubmitTypedDataField,
  SignalAttributionPayload,
  SignalSubmissionTypedData,
  StageFile,
  StageDockSupplierSelectionPayload,
  StageDockSupplierSelectionTypedData,
  StageSupplierPatchPayload,
  StageSupplierPatchTypedData,
  TypedDataSigningMismatchReason,
  UVPOrderFinalizeTypedData,
  UVPStageInviteAcceptTypedData,
  UVPStageInviteCreateTypedData,
} from '@uvp-eth/protocol-bindings';
