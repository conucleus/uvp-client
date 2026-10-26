/**
 * Order birth transaction surface: re-exports the triggerOrderFromOutsideFor
 * typed-data and calldata builders owned by @uvp-eth/protocol-bindings, so the
 * client never hand-copies the state-machine ABI or digest.
 */
export {
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
  deriveTriggerOrderId,
} from '@uvp-eth/protocol-bindings';

export type {
  BuildTriggerOrderFromOutsideTypedDataInput,
  TriggerOrderFromOutsideForCall,
  TriggerOrderFromOutsideForCallArgs,
  TriggerOrderFromOutsideForCallConfig,
  TriggerOrderFromOutsidePayload,
  TriggerOrderFromOutsideTypedData,
} from '@uvp-eth/protocol-bindings';
