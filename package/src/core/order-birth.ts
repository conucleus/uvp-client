/**
 * Order birth transaction surface: re-exports the order-birth typed-data and
 * calldata builders owned by @uvp-eth/protocol-bindings (the EOA
 * triggerOrderFromOutsideFor path and the signature-less authorizer direct
 * entry), so the client never hand-copies the state-machine ABI or digest.
 */
export {
  buildTriggerOrderFromOutsideByAuthorizerCall,
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
  deriveTriggerOrderId,
} from '@uvp-eth/protocol-bindings';

export type {
  BuildTriggerOrderFromOutsideTypedDataInput,
  TriggerOrderFromOutsideByAuthorizerCall,
  TriggerOrderFromOutsideByAuthorizerCallArgs,
  TriggerOrderFromOutsideByAuthorizerCallConfig,
  TriggerOrderFromOutsideByAuthorizerPayload,
  TriggerOrderFromOutsideForCall,
  TriggerOrderFromOutsideForCallArgs,
  TriggerOrderFromOutsideForCallConfig,
  TriggerOrderFromOutsidePayload,
  TriggerOrderFromOutsideTypedData,
} from '@uvp-eth/protocol-bindings';
