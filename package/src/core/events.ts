/**
 * Engine event decode: typed decoders for the state machine, stage patch, file
 * resource and supplier registry ABIs. Shapes and topics derive from
 * @uvp-eth/protocol-bindings; raw event fields stay raw, no derived labels.
 */
import {
  decodeEventLog,
  getAbiItem,
  toEventSelector,
  type AbiEvent,
  type Address,
  type GetEventArgs,
  type Hex,
} from 'viem';
import {
  FILE_RESOURCE_MODULE_ABI,
  STAGE_PATCH_MODULE_ABI,
  STATE_MACHINE_ABI,
  SUPPLIER_REGISTRY_ABI,
  UVP_STATE_MACHINE_ARTIFACT_ABI,
  type StateMachineRawLog,
} from '@uvp-eth/protocol-bindings';
import { ExecutorKitError } from './validation.js';
import {
  supplierStatusWordOf,
  type SupplierStatusWord,
} from './status-words.js';

export type EngineEventErrorCode = 'unknown_event' | 'decode_failed' | 'invalid_args';

export class EngineEventError extends ExecutorKitError {
  override readonly name = 'EngineEventError';
  readonly code: EngineEventErrorCode;

  constructor(code: EngineEventErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface DecodedEventMeta {
  readonly address?: Address;
  readonly blockNumber?: bigint;
  readonly transactionHash?: Hex;
  readonly logIndex?: number;
}

export interface DecodedEvent<TName extends string, TArgs> extends DecodedEventMeta {
  readonly eventName: TName;
  readonly args: TArgs;
}

type EngineEventArgsOptions = {
  readonly EnableUnion: false;
  readonly IndexedOnly: false;
  readonly Required: true;
};

type EventArgsOf<TAbi extends readonly unknown[], TName extends string> = GetEventArgs<
  TAbi,
  TName,
  EngineEventArgsOptions
>;

export interface StageSupplierPatchAppliedArgs {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly selector: Address;
  readonly supplierId: Hex;
  readonly previousSupplierId: Hex;
  readonly patchNonce: bigint;
}

export type StateMachineEventName =
  | 'PlanCommitted'
  | 'PlanFinalized'
  | 'OrderTriggered'
  | 'SignalSubmitted'
  | 'HookReady'
  | 'TimerPoked'
  | 'StageMaterialized'
  | 'StageSupplierAssigned';

export type StateMachineEvent = {
  [K in StateMachineEventName]: DecodedEvent<
    K,
    EventArgsOf<typeof UVP_STATE_MACHINE_ARTIFACT_ABI, K>
  >;
}[StateMachineEventName];

export type StagePatchEventName = 'StageSupplierPatchApplied';

export type StagePatchEvent = DecodedEvent<
  'StageSupplierPatchApplied',
  StageSupplierPatchAppliedArgs
>;

export type StageFileEventName = 'StageFilePatchApplied';

export type StageFileEvent = DecodedEvent<
  'StageFilePatchApplied',
  EventArgsOf<typeof FILE_RESOURCE_MODULE_ABI, 'StageFilePatchApplied'>
>;

export type SupplierRegistryEventName = 'SupplierRegistered' | 'SupplierStatusChanged';

export interface SupplierStatusChangedArgs {
  readonly supplierId: Hex;
  readonly previousStatus: SupplierStatusWord;
  readonly newStatus: SupplierStatusWord;
  readonly account: Address;
}

export type SupplierRegistryEvent =
  | DecodedEvent<
      'SupplierRegistered',
      EventArgsOf<typeof SUPPLIER_REGISTRY_ABI, 'SupplierRegistered'>
    >
  | DecodedEvent<'SupplierStatusChanged', SupplierStatusChangedArgs>;

export type EngineEvent = StateMachineEvent | StagePatchEvent | StageFileEvent | SupplierRegistryEvent;

const STATE_MACHINE_EVENT_NAMES: readonly StateMachineEventName[] = [
  'PlanCommitted',
  'PlanFinalized',
  'OrderTriggered',
  'SignalSubmitted',
  'HookReady',
  'TimerPoked',
  'StageMaterialized',
  'StageSupplierAssigned',
];
const STAGE_PATCH_EVENT_NAMES: readonly StagePatchEventName[] = ['StageSupplierPatchApplied'];
const STAGE_FILE_EVENT_NAMES: readonly StageFileEventName[] = ['StageFilePatchApplied'];
const SUPPLIER_REGISTRY_EVENT_NAMES: readonly SupplierRegistryEventName[] = [
  'SupplierRegistered',
  'SupplierStatusChanged',
];

const STATE_MACHINE_TOPICS = eventTopicsOf(
  UVP_STATE_MACHINE_ARTIFACT_ABI,
  STATE_MACHINE_EVENT_NAMES,
);
const STAGE_PATCH_TOPICS = eventTopicsOf(STAGE_PATCH_MODULE_ABI, STAGE_PATCH_EVENT_NAMES);
const STAGE_FILE_TOPICS = eventTopicsOf(FILE_RESOURCE_MODULE_ABI, STAGE_FILE_EVENT_NAMES);
const SUPPLIER_REGISTRY_TOPICS = eventTopicsOf(
  SUPPLIER_REGISTRY_ABI,
  SUPPLIER_REGISTRY_EVENT_NAMES,
);

export function isStateMachineEventLog(log: StateMachineRawLog): boolean {
  const topic = topicOf(log);
  return topic !== undefined && STATE_MACHINE_TOPICS.has(topic);
}

export function isStagePatchEventLog(log: StateMachineRawLog): boolean {
  const topic = topicOf(log);
  return topic !== undefined && STAGE_PATCH_TOPICS.has(topic);
}

export function isStageFileEventLog(log: StateMachineRawLog): boolean {
  const topic = topicOf(log);
  return topic !== undefined && STAGE_FILE_TOPICS.has(topic);
}

export function isSupplierRegistryEventLog(log: StateMachineRawLog): boolean {
  const topic = topicOf(log);
  return topic !== undefined && SUPPLIER_REGISTRY_TOPICS.has(topic);
}

export function decodeStateMachineEvent(log: StateMachineRawLog): StateMachineEvent {
  const eventName = STATE_MACHINE_TOPICS.get(requiredTopic(log));
  switch (eventName) {
    case 'PlanCommitted':
      return stateMachineEventOf(log, 'PlanCommitted');
    case 'PlanFinalized':
      return stateMachineEventOf(log, 'PlanFinalized');
    case 'OrderTriggered':
      return stateMachineEventOf(log, 'OrderTriggered');
    case 'SignalSubmitted':
      return stateMachineEventOf(log, 'SignalSubmitted');
    case 'HookReady':
      return stateMachineEventOf(log, 'HookReady');
    case 'TimerPoked':
      return stateMachineEventOf(log, 'TimerPoked');
    case 'StageMaterialized':
      return stateMachineEventOf(log, 'StageMaterialized');
    case 'StageSupplierAssigned':
      return stateMachineEventOf(log, 'StageSupplierAssigned');
    default:
      throw unknownEvent('state machine', log);
  }
}

export function decodeStateMachineEvents(logs: readonly StateMachineRawLog[]): StateMachineEvent[] {
  return logs.filter(isStateMachineEventLog).map(decodeStateMachineEvent);
}

export function decodeStagePatchEvent(log: StateMachineRawLog): StagePatchEvent {
  const eventName = STAGE_PATCH_TOPICS.get(requiredTopic(log));
  if (eventName !== 'StageSupplierPatchApplied') {
    throw unknownEvent('stage patch module', log);
  }
  const decoded = decodeLog(STAGE_PATCH_MODULE_ABI, 'StageSupplierPatchApplied', log);
  const args = decoded as StageSupplierPatchAppliedArgs;
  return withLog(log, { eventName: 'StageSupplierPatchApplied', args });
}

export function decodeStagePatchEvents(logs: readonly StateMachineRawLog[]): StagePatchEvent[] {
  return logs.filter(isStagePatchEventLog).map(decodeStagePatchEvent);
}

export function decodeStageFileEvent(log: StateMachineRawLog): StageFileEvent {
  const eventName = STAGE_FILE_TOPICS.get(requiredTopic(log));
  if (eventName !== 'StageFilePatchApplied') {
    throw unknownEvent('file resource module', log);
  }
  const decoded = decodeLog(FILE_RESOURCE_MODULE_ABI, 'StageFilePatchApplied', log);
  return withLog(log, {
    eventName: 'StageFilePatchApplied',
    args: decoded as StageFileEvent['args'],
  });
}

export function decodeStageFileEvents(logs: readonly StateMachineRawLog[]): StageFileEvent[] {
  return logs.filter(isStageFileEventLog).map(decodeStageFileEvent);
}

export function decodeSupplierRegistryEvent(log: StateMachineRawLog): SupplierRegistryEvent {
  const eventName = SUPPLIER_REGISTRY_TOPICS.get(requiredTopic(log));
  switch (eventName) {
    case 'SupplierRegistered': {
      const decoded = decodeLog(SUPPLIER_REGISTRY_ABI, 'SupplierRegistered', log);
      return withLog(log, {
        eventName: 'SupplierRegistered',
        args: decoded as Extract<SupplierRegistryEvent, { readonly eventName: 'SupplierRegistered' }>['args'],
      });
    }
    case 'SupplierStatusChanged': {
      const decoded = decodeLog(SUPPLIER_REGISTRY_ABI, 'SupplierStatusChanged', log) as {
        readonly supplierId: Hex;
        readonly previousStatus: unknown;
        readonly newStatus: unknown;
        readonly account: Address;
      };
      const previousStatus = supplierStatusWordOf(decoded.previousStatus);
      const newStatus = supplierStatusWordOf(decoded.newStatus);
      return withLog(log, {
        eventName: 'SupplierStatusChanged',
        args: {
          supplierId: decoded.supplierId,
          previousStatus,
          newStatus,
          account: decoded.account,
        },
      });
    }
    default:
      throw unknownEvent('supplier registry', log);
  }
}

export function decodeSupplierRegistryEvents(
  logs: readonly StateMachineRawLog[],
): SupplierRegistryEvent[] {
  return logs.filter(isSupplierRegistryEventLog).map(decodeSupplierRegistryEvent);
}

function stateMachineEventOf<K extends StateMachineEventName>(
  log: StateMachineRawLog,
  eventName: K,
): Extract<StateMachineEvent, { readonly eventName: K }> {
  const decoded = decodeLog(UVP_STATE_MACHINE_ARTIFACT_ABI, eventName, log);
  return withLog(log, { eventName, args: decoded }) as Extract<
    StateMachineEvent,
    { readonly eventName: K }
  >;
}

function decodeLog(abi: readonly unknown[], eventName: string, log: StateMachineRawLog): unknown {
  let decoded: unknown;
  try {
    decoded = decodeEventLog({
      abi: abi as never,
      eventName: eventName as never,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch (error) {
    throw new EngineEventError(
      'decode_failed',
      `${eventName} log data could not be decoded: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new EngineEventError('decode_failed', `${eventName} log did not decode to an event object`);
  }
  const args = (decoded as { readonly args?: unknown }).args;
  if (args === undefined) {
    throw new EngineEventError('decode_failed', `${eventName} log decoded without args`);
  }
  return args;
}

function eventTopicsOf(
  abi: readonly unknown[],
  names: readonly string[],
): ReadonlyMap<string, string> {
  const allowed = new Set(names);
  const topics = new Map<string, string>();
  for (const item of abi) {
    const entry = item as { readonly type?: unknown; readonly name?: unknown };
    if (entry.type !== 'event' || typeof entry.name !== 'string' || !allowed.has(entry.name)) {
      continue;
    }
    topics.set(toEventSelector(item as AbiEvent).toLowerCase(), entry.name);
  }
  return topics;
}

function topicOf(log: StateMachineRawLog): string | undefined {
  const topic = log.topics[0];
  return typeof topic === 'string' ? topic.toLowerCase() : undefined;
}

function requiredTopic(log: StateMachineRawLog): string {
  const topic = topicOf(log);
  if (topic === undefined) {
    throw new EngineEventError('unknown_event', 'log has no topics[0] to identify the event');
  }
  if (topic === ZERO_TOPIC) {
    throw new EngineEventError('unknown_event', 'anonymous events are not part of the engine ABIs');
  }
  return topic;
}

function withLog<TName extends string, TArgs>(
  log: StateMachineRawLog,
  event: { readonly eventName: TName; readonly args: TArgs },
): DecodedEvent<TName, TArgs> {
  return {
    eventName: event.eventName,
    args: event.args,
    ...(typeof log.address === 'string' ? { address: log.address as Address } : {}),
    ...(log.blockNumber === undefined || log.blockNumber === null
      ? {}
      : { blockNumber: log.blockNumber }),
    ...(log.transactionHash === undefined || log.transactionHash === null
      ? {}
      : { transactionHash: log.transactionHash }),
    ...(log.logIndex === undefined || log.logIndex === null
      ? {}
      : { logIndex: typeof log.logIndex === 'bigint' ? Number(log.logIndex) : log.logIndex }),
  };
}

function unknownEvent(abi: string, log: StateMachineRawLog): EngineEventError {
  return new EngineEventError(
    'unknown_event',
    `log topic ${topicOf(log) ?? '(none)'} is not an event of the ${abi} ABI`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

const ORDER_TRIGGERED_EVENT_ITEM = getAbiItem({ abi: STATE_MACHINE_ABI, name: 'OrderTriggered' }) as AbiEvent;
const SIGNAL_SUBMITTED_EVENT_ITEM = getAbiItem({ abi: STATE_MACHINE_ABI, name: 'SignalSubmitted' }) as AbiEvent;
const STAGE_SUPPLIER_ASSIGNED_EVENT_ITEM = getAbiItem({
  abi: STATE_MACHINE_ABI,
  name: 'StageSupplierAssigned',
}) as AbiEvent;

export const STAGE_FILE_PATCH_APPLIED_TOPIC = toEventSelector(
  getAbiItem({ abi: FILE_RESOURCE_MODULE_ABI, name: 'StageFilePatchApplied' }) as AbiEvent,
);

export const SIGNAL_SUBMITTED_TOPIC = toEventSelector(SIGNAL_SUBMITTED_EVENT_ITEM);

export interface StateMachineStepLogClient {
  getLogs(args: {
    address: Address;
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly StateMachineRawLog[]>;
}

export async function fetchStateMachineStepEventLogs(
  client: StateMachineStepLogClient,
  input: {
    readonly address: Address;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  },
): Promise<{
  readonly triggeredLogs: readonly StateMachineRawLog[];
  readonly signalLogs: readonly StateMachineRawLog[];
  readonly assignedLogs: readonly StateMachineRawLog[];
}> {
  const [triggeredLogs, signalLogs, assignedLogs] = await Promise.all([
    client.getLogs({
      address: input.address,
      event: ORDER_TRIGGERED_EVENT_ITEM,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    }),
    client.getLogs({
      address: input.address,
      event: SIGNAL_SUBMITTED_EVENT_ITEM,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    }),
    client.getLogs({
      address: input.address,
      event: STAGE_SUPPLIER_ASSIGNED_EVENT_ITEM,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    }),
  ]);
  return { triggeredLogs, signalLogs, assignedLogs };
}