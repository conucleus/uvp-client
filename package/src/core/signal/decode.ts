/**
 * HookReady decode surface: the topic and decoder are owned by
 * @uvp-eth/protocol-bindings; this module only re-exports them for the core
 * entry so the event shape keeps a single implementation.
 */
export {
  HOOK_READY_TOPIC,
  decodeHookReadyLog,
  hookReadyEventId,
  tryHookReadyEventId,
  tryNormalizeStateMachineAddress,
} from '@uvp-eth/protocol-bindings';

export type {
  StateMachineArtifactIndex,
  StateMachineHookMetadata,
  StateMachineHookReady,
  StateMachineRawLog,
  StateMachineSignalMetadata,
} from '@uvp-eth/protocol-bindings';
