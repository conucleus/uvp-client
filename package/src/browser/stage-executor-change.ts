/**
 * D13 stage executor change surface: re-exports the
 * UVPStagePatchModuleStageExecutorChange builder, signer recovery, domain
 * constants and field table owned by @uvp-eth/protocol-bindings. No typehash,
 * field, domain or digest is redefined here; hosts sign/recover through the
 * browser entry instead of hand-writing the EIP-712 shape.
 */
export {
  STAGE_EXECUTOR_CHANGE_DOMAIN_NAME,
  STAGE_EXECUTOR_CHANGE_DOMAIN_VERSION,
  STAGE_EXECUTOR_CHANGE_PRIMARY_TYPE,
  STAGE_EXECUTOR_CHANGE_TYPED_DATA_FIELDS,
  buildStageExecutorChangeTypedData,
  recoverStageExecutorChangeSigner,
} from '@uvp-eth/protocol-bindings';

export type {
  BuildStageExecutorChangeTypedDataInput,
  StageExecutorChangePayload,
  StageExecutorChangeTypedData,
} from '@uvp-eth/protocol-bindings';
