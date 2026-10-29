// D4b 写动作签名面：链下写动作的 typed data 计划、bodyHash、writeSignature
// envelope 与 body 组装。域/字段/typehash/构造单源是 @uvp-eth/protocol-bindings
// （经 product-dto re-export），bodyHash/contentHash 单源是 @uvp-eth/canonical-json；
// 本模块不重写域/字段表，也不持有哈希实现，只按动作组合参数与签名 envelope。

import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDefinition } from "viem";
import {
  UVP_APP_BACKEND_DOMAIN_NAME,
  UVP_APP_BACKEND_DOMAIN_VERSION,
  UVP_APP_WRITE_ACTIONS,
  UVP_APP_WRITE_FIELDS,
  UVP_APP_WRITE_PRIMARY_TYPES,
  UVP_APP_WRITE_RESOURCE_FIELDS,
  UVP_APP_WRITE_TYPE_HASHES,
  UVP_ORDER_BOOK_DOMAIN_NAME,
  UVP_ORDER_BOOK_DOMAIN_VERSION,
  UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE,
  UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS,
  UVP_STAGE_INVITE_ACCEPT_TYPE_HASH,
  UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
  UVP_STAGE_INVITE_CREATE_TYPED_DATA_FIELDS,
  UVP_STAGE_INVITE_CREATE_TYPE_HASH,
  buildOrderBookDomain,
  buildUVPAppBackendDomain,
  buildUVPAppWriteTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  hashAppWritePayload,
  validateUVPStageInviteAcceptTypedData,
  validateUVPStageInviteCreateTypedData,
  type BuildUVPAppWriteTypedDataInput,
  type BuildUVPStageInviteAcceptTypedDataInput,
  type BuildUVPStageInviteCreateTypedDataInput,
  type OrderBookDomain,
  type OrderBookTypedDataField,
  type UvpAppBackendDomain,
  type UvpAppWriteAction,
  type UvpAppWritePrimaryType,
  type UvpAppWriteTypedData,
  type UVPStageInviteAcceptTypedData,
  type UVPStageInviteCreateTypedData
} from "@uvp-eth/protocol-bindings";
import { hashEvidenceBytes, hashEvidenceJson, hashEvidenceText } from "@uvp-eth/canonical-json";
import type {
  AttachOrderInput,
  CreateEvidenceRequestDTO,
  CreateOrderDraftInput,
  CreateStageInviteInput,
  EvidenceContentDTO,
  UpdateOrderDraftInput,
  WriteSignatureEnvelope as BaseWriteSignatureEnvelope
} from "@uvp-eth/product-dto";
import type { Eip1193Provider } from "./wallet/provider.js";
import { signTypedDataWithProvider } from "./write.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const DECIMAL_PATTERN = /^[0-9]+$/u;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/u;
const DEFAULT_DEADLINE_WINDOW_SECONDS = 300;

export interface WriteSignatureEnvelope extends BaseWriteSignatureEnvelope {
  /** App 域带 bodyHash 动作的客户端声明值；invite.* 不写（backend 400）。 */
  readonly bodyHash?: Hex | undefined;
}

export type BigUint = bigint | number | string;

export type WritePlanAction = UvpAppWriteAction | "invite.create" | "invite.accept";

export type BodyHashWriteAction = Extract<
  UvpAppWriteAction,
  | "draft.create"
  | "draft.update"
  | "order.attach"
  | "evidence.upload"
  | "joint.child_order"
  | "joint.child_settle"
>;

export type NoBodyHashWriteAction = Exclude<WritePlanAction, BodyHashWriteAction>;

export type WritePlanTypedData =
  | UvpAppWriteTypedData
  | UVPStageInviteCreateTypedData
  | UVPStageInviteAcceptTypedData;

export type WritePlanErrorCode =
  | "invalid_chain"
  | "invalid_nonce"
  | "invalid_deadline"
  | "invalid_signature"
  | "invalid_draft_id"
  | "invalid_invite_id"
  | "invalid_token"
  | "invalid_write_message"
  | "invalid_evidence_content"
  | "invitee_required"
  | "invitee_mismatch"
  | "expires_at_required"
  | "expires_at_mismatch"
  | "domain_chain_mismatch";

export class WritePlanError extends Error {
  override readonly name = "WritePlanError";
  readonly code: WritePlanErrorCode;

  constructor(code: WritePlanErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface WritePlanBase<Payload extends object, Action extends WritePlanAction> {
  readonly action: Action;
  readonly payload: Payload;
  readonly typedData: WritePlanTypedData;
  readonly nonce: string;
  readonly deadline: string;
}

export interface BodyHashWritePlan<Payload extends object> extends WritePlanBase<
  Payload,
  BodyHashWriteAction
> {
  readonly bodyHash: Hex;
}

export interface NoBodyHashWritePlan<Payload extends object> extends WritePlanBase<
  Payload,
  NoBodyHashWriteAction
> {
  readonly bodyHash?: undefined;
}

export type WritePlan<Payload extends object> =
  | BodyHashWritePlan<Payload>
  | NoBodyHashWritePlan<Payload>;

export type WriteSignedBody<Payload> = Payload & {
  readonly writeSignature: WriteSignatureEnvelope;
};

export type BodyHashWriteSignatureEnvelope = WriteSignatureEnvelope & {
  readonly bodyHash: Hex;
};

export type BodyHashSignedBody<Payload> = Payload & {
  readonly writeSignature: BodyHashWriteSignatureEnvelope;
};

export interface WriteSignatureOnlyBody {
  readonly writeSignature: WriteSignatureEnvelope;
}

export interface InviteAcceptWriteBody {
  readonly token: string;
  readonly invitee?: string | undefined;
  readonly writeSignature: WriteSignatureEnvelope;
}

export interface InviteRejectWriteBody {
  readonly token: string;
  readonly writeSignature: WriteSignatureEnvelope;
}

export type DraftCreateBody = CreateOrderDraftInput & {
  readonly draftId: string;
  readonly configHash: string;
};

export type EvidenceUploadBody = CreateEvidenceRequestDTO & {
  readonly contentHash: string;
};

export interface WriteTimingInput {
  readonly nonce?: BigUint | undefined;
  readonly deadline?: BigUint | undefined;
}

export function newDraftId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new WritePlanError("invalid_draft_id", "没有可用的 crypto 随机源，不能生成 draftId。");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newWriteNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new WritePlanError("invalid_nonce", "没有可用的 crypto 随机源，不能生成写 nonce。");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString(10);
}

export function writeDeadline(
  input: { readonly nowSeconds?: number | undefined; readonly windowSeconds?: number | undefined } = {}
): string {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const windowSeconds = input.windowSeconds ?? DEFAULT_DEADLINE_WINDOW_SECONDS;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new WritePlanError("invalid_deadline", "nowSeconds 必须是非负安全整数。");
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
    throw new WritePlanError("invalid_deadline", "deadline 窗口必须是正整数秒。");
  }
  return String(nowSeconds + windowSeconds);
}

export function writeSignatureEnvelope(input: {
  readonly signature: Hex | string;
  readonly nonce: BigUint;
  readonly deadline: BigUint;
  readonly bodyHash?: Hex | string | undefined;
}): WriteSignatureEnvelope {
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new WritePlanError("invalid_signature", "signature 必须是 0x + 130 位十六进制（65 字节）。");
  }
  return {
    scheme: "eip712",
    signature,
    nonce: decimalOf(input.nonce, "nonce"),
    deadline: decimalOf(input.deadline, "deadline"),
    ...(input.bodyHash === undefined
      ? {}
      : { bodyHash: hash32Of(input.bodyHash, "bodyHash") })
  };
}

export function completeSignedWrite<Payload extends object>(
  plan: BodyHashWritePlan<Payload>,
  signature: Hex | string
): BodyHashSignedBody<Payload>;
export function completeSignedWrite<Payload extends object>(
  plan: NoBodyHashWritePlan<Payload>,
  signature: Hex | string
): WriteSignedBody<Payload>;
export function completeSignedWrite<Payload extends object>(
  plan: WritePlan<Payload>,
  signature: Hex | string
): WriteSignedBody<Payload> | BodyHashSignedBody<Payload> {
  return buildSignedWriteBody(plan, signature);
}

function buildSignedWriteBody<Payload extends object>(
  plan: WritePlan<Payload>,
  signature: Hex | string
): WriteSignedBody<Payload> | BodyHashSignedBody<Payload> {
  const bodyHash = envelopeBodyHashOf(plan);
  return {
    ...plan.payload,
    writeSignature: writeSignatureEnvelope({
      signature,
      nonce: plan.nonce,
      deadline: plan.deadline,
      ...(bodyHash === undefined ? {} : { bodyHash })
    })
  } as WriteSignedBody<Payload> | BodyHashSignedBody<Payload>;
}

function envelopeBodyHashOf(plan: {
  readonly action: WritePlanAction;
  readonly bodyHash?: Hex | undefined;
}): Hex | undefined {
  const action = plan.action;
  if (!isAppWriteAction(action)) {
    if (plan.bodyHash !== undefined) {
      throw new WritePlanError("invalid_write_message", `${action} 不接受 writeSignature.bodyHash。`);
    }
    return undefined;
  }
  const takesBodyHash = UVP_APP_WRITE_FIELDS[action].some((field) => field.name === "bodyHash");
  if (!takesBodyHash) {
    if (plan.bodyHash !== undefined) {
      throw new WritePlanError("invalid_write_message", `${action} 不接受 writeSignature.bodyHash。`);
    }
    return undefined;
  }
  if (plan.bodyHash === undefined) {
    throw new WritePlanError("invalid_write_message", `${action} 需要 writeSignature.bodyHash。`);
  }
  return plan.bodyHash;
}

function isAppWriteAction(action: WritePlanAction): action is UvpAppWriteAction {
  return (UVP_APP_WRITE_ACTIONS as readonly string[]).includes(action);
}

export function signWritePlan<Payload extends object>(
  plan: BodyHashWritePlan<Payload>,
  input: { readonly provider: Eip1193Provider; readonly signer: Address | string }
): Promise<BodyHashSignedBody<Payload>>;
export function signWritePlan<Payload extends object>(
  plan: NoBodyHashWritePlan<Payload>,
  input: { readonly provider: Eip1193Provider; readonly signer: Address | string }
): Promise<WriteSignedBody<Payload>>;
export async function signWritePlan<Payload extends object>(
  plan: WritePlan<Payload>,
  input: { readonly provider: Eip1193Provider; readonly signer: Address | string }
): Promise<WriteSignedBody<Payload> | BodyHashSignedBody<Payload>> {
  const signature = await signTypedDataWithProvider(
    input.provider,
    plan.typedData as unknown as TypedDataDefinition,
    input.signer
  );
  return buildSignedWriteBody(plan, signature);
}

export async function recoverWriteSigner(
  plan: WritePlan<object>,
  signature: Hex | string
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: plan.typedData.domain,
    types: plan.typedData.types,
    primaryType: plan.typedData.primaryType,
    message: plan.typedData.message,
    signature: signature as Hex
  } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
}

export function appWriteDomainExpectation(chainId: number): UvpAppBackendDomain {
  return buildUVPAppBackendDomain({ chainId });
}

export function orderBookDomainExpectation(input: {
  readonly chainId: number;
  readonly stateMachineAddress: string;
}): OrderBookDomain {
  return buildOrderBookDomain({
    chainId: input.chainId,
    verifyingContract: input.stateMachineAddress
  });
}

export function planDraftCreate(
  input: {
    readonly chainId: number;
    readonly payload: CreateOrderDraftInput;
    readonly configHash: Hex | string;
    readonly draftId?: string | undefined;
  } & WriteTimingInput
): BodyHashWritePlan<DraftCreateBody> {
  const chainId = chainIdOf(input.chainId);
  const draftId = draftIdOf(input.draftId ?? input.payload.draftId ?? newDraftId());
  const configHash = hash32Of(input.configHash, "configHash");
  const payload: DraftCreateBody = { ...input.payload, draftId, configHash };
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const bodyHash = hashAppWritePayload(payload);
  return {
    action: "draft.create",
    payload,
    typedData: appTypedData("draft.create", chainId, {
      draftId,
      configId: payload.configId,
      configVersion: payload.configVersion,
      configHash,
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export function planDraftUpdate(
  input: {
    readonly chainId: number;
    readonly draftId: string;
    readonly payload: UpdateOrderDraftInput;
  } & WriteTimingInput
): BodyHashWritePlan<UpdateOrderDraftInput> {
  const chainId = chainIdOf(input.chainId);
  const draftId = draftIdOf(input.draftId);
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const bodyHash = hashAppWritePayload(input.payload);
  return {
    action: "draft.update",
    payload: input.payload,
    typedData: appTypedData("draft.update", chainId, {
      draftId,
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export function planInviteCreate(input: {
  readonly chainId: number;
  readonly payload: CreateStageInviteInput;
  readonly typedData: unknown;
}): NoBodyHashWritePlan<CreateStageInviteInput> {
  const chainId = chainIdOf(input.chainId);
  let typedData: UVPStageInviteCreateTypedData;
  try {
    typedData = validateUVPStageInviteCreateTypedData(input.typedData);
  } catch (error) {
    throw new WritePlanError("invalid_write_message", errorMessage(error));
  }
  if (typedData.domain.chainId !== chainId) {
    throw new WritePlanError(
      "domain_chain_mismatch",
      `邀请 typed data 的 chainId ${typedData.domain.chainId} 与动作链 ${chainId} 不一致。`
    );
  }
  const stageKey = input.payload.stageKey.trim();
  if (stageKey !== "" && stageKey !== typedData.message.stageKey) {
    throw new WritePlanError(
      "invalid_write_message",
      "邀请请求的 stageKey 与 prepare typed data 的 stageKey 不一致。"
    );
  }
  const slotKey = input.payload.slotKey.trim();
  if (slotKey !== "" && slotKey !== typedData.message.slotKey) {
    throw new WritePlanError(
      "invalid_write_message",
      "邀请请求的 slotKey 与 prepare typed data 的 slotKey 不一致。"
    );
  }
  const wallet = input.payload.wallet?.trim() ?? "";
  if (wallet !== "" && wallet.toLowerCase() !== typedData.message.invitee.toLowerCase()) {
    throw new WritePlanError(
      "invitee_mismatch",
      "邀请请求的 wallet 与 prepare typed data 的 invitee 不一致。"
    );
  }
  const expiresAt = input.payload.expiresAt?.trim() ?? "";
  if (expiresAt === "") {
    throw new WritePlanError(
      "expires_at_required",
      "invite.create 必须在请求体里带 expiresAt（与 prepare 的 deadline 一致）。"
    );
  }
  const expiresAtMillis = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMillis) ||
    String(Math.floor(expiresAtMillis / 1000)) !== typedData.message.deadline
  ) {
    throw new WritePlanError(
      "expires_at_mismatch",
      "邀请请求的 expiresAt 与 prepare typed data 的 deadline 不一致。"
    );
  }
  return {
    action: "invite.create",
    payload: input.payload,
    typedData,
    nonce: decimalOf(typedData.message.nonce, "nonce"),
    deadline: decimalOf(typedData.message.deadline, "deadline")
  };
}

export function planInviteRevoke(
  input: {
    readonly chainId: number;
    readonly inviteId: string;
  } & WriteTimingInput
): NoBodyHashWritePlan<Record<string, never>> {
  const chainId = chainIdOf(input.chainId);
  const inviteId = inviteIdOf(input.inviteId);
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  return {
    action: "invite.revoke",
    payload: {},
    typedData: appTypedData("invite.revoke", chainId, { inviteId, nonce, deadline }),
    nonce,
    deadline
  };
}

export function planInviteAccept(input: {
  readonly chainId: number;
  readonly token: string;
  readonly invitee?: string | undefined;
  readonly typedData: unknown;
}): NoBodyHashWritePlan<{ readonly token: string; readonly invitee?: string | undefined }> {
  const chainId = chainIdOf(input.chainId);
  const token = tokenOf(input.token);
  let typedData: UVPStageInviteAcceptTypedData;
  try {
    typedData = validateUVPStageInviteAcceptTypedData(input.typedData);
  } catch (error) {
    throw new WritePlanError("invalid_write_message", errorMessage(error));
  }
  if (typedData.domain.chainId !== chainId) {
    throw new WritePlanError(
      "domain_chain_mismatch",
      `邀请 typed data 的 chainId ${typedData.domain.chainId} 与动作链 ${chainId} 不一致。`
    );
  }
  const resolved = resolveAcceptInvitee(typedData, input.invitee);
  return {
    action: "invite.accept",
    payload:
      resolved.invitee === undefined ? { token } : { token, invitee: resolved.invitee },
    typedData: resolved.typedData,
    nonce: decimalOf(resolved.typedData.message.nonce, "nonce"),
    deadline: decimalOf(resolved.typedData.message.deadline, "deadline")
  };
}

export function planInviteReject(input: {
  readonly chainId: number;
  readonly inviteId: string;
  readonly token: string;
  readonly nonce: BigUint;
  readonly deadline: BigUint;
}): NoBodyHashWritePlan<{ readonly token: string }> {
  const chainId = chainIdOf(input.chainId);
  const inviteId = inviteIdOf(input.inviteId);
  const token = tokenOf(input.token);
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  return {
    action: "invite.reject",
    payload: { token },
    typedData: appTypedData("invite.reject", chainId, { inviteId, nonce, deadline }),
    nonce,
    deadline
  };
}

export function planAttachOrder(
  input: {
    readonly chainId: number;
    readonly draftId: string;
    readonly payload: AttachOrderInput;
  } & WriteTimingInput
): BodyHashWritePlan<AttachOrderInput> {
  const chainId = chainIdOf(input.chainId);
  const draftId = draftIdOf(input.draftId);
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const bodyHash = hashAppWritePayload(input.payload);
  return {
    action: "order.attach",
    payload: input.payload,
    typedData: appTypedData("order.attach", chainId, {
      draftId,
      orderId: hash32Of(input.payload.orderId, "orderId"),
      planId: hash32Of(input.payload.planId, "planId"),
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export function planEvidenceUpload(
  input: {
    readonly chainId: number;
    readonly payload: CreateEvidenceRequestDTO;
  } & WriteTimingInput
): BodyHashWritePlan<EvidenceUploadBody> {
  const chainId = chainIdOf(input.chainId);
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const contentHash = evidenceContentHashOf(input.payload);
  const payload: EvidenceUploadBody = { ...input.payload, contentHash };
  const bodyHash = hashAppWritePayload(payload);
  return {
    action: "evidence.upload",
    payload,
    typedData: appTypedData("evidence.upload", chainId, {
      orderId: hash32Of(payload.orderId ?? ZERO_BYTES32, "orderId"),
      draftId: payload.draftId?.trim() ?? "",
      documentType: payload.documentType?.trim() ?? "",
      contentHash,
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export interface JointChildOrderParent {
  readonly planId: string;
  readonly orderId: string;
  readonly stageKey: string;
}

export interface JointChildOrderParticipant {
  readonly stageKey: string;
  readonly signalName: string;
  readonly submitter: Address | string;
}

export interface JointChildOrderChild {
  readonly planId: string;
  readonly creator: Address | string;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
  /** child order 自身的 deadline（进转发 body，不是签名窗口）。 */
  readonly deadline: BigUint;
  readonly participants: readonly JointChildOrderParticipant[];
}

/** 转发给 relayer /dock/child-order 的 body：parent + child 两层，字段形状是 app wire。 */
export interface JointChildOrderPayload {
  readonly parent: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly stageKey: string;
  };
  readonly child: {
    readonly planId: Hex;
    readonly creator: Address;
    readonly payloadHash: Hex;
    readonly idempotencyKey: Hex;
    readonly deadline: string;
    readonly participants: readonly JointChildOrderParticipant[];
  };
}

export function planJointChildOrder(
  input: {
    readonly chainId: number;
    readonly parent: JointChildOrderParent;
    readonly child: JointChildOrderChild;
  } & WriteTimingInput
): BodyHashWritePlan<JointChildOrderPayload> {
  const chainId = chainIdOf(input.chainId);
  const parentPlanId = hash32Of(input.parent.planId, "parent.planId");
  const parentOrderId = hash32Of(input.parent.orderId, "parent.orderId");
  const parentStageKey = fieldText(input.parent.stageKey, "parent.stageKey", 36);
  const childPlanId = hash32Of(input.child.planId, "child.planId");
  const creator = addressOf(input.child.creator, "child.creator");
  const payloadHash = hash32Of(input.child.payloadHash, "child.payloadHash");
  const idempotencyKey = hash32Of(input.child.idempotencyKey, "child.idempotencyKey");
  const childDeadline = decimalOf(input.child.deadline, "deadline");
  const participants = input.child.participants.map((participant, index) => ({
    stageKey: fieldText(participant.stageKey, `child.participants[${index}].stageKey`, 36),
    signalName: fieldText(participant.signalName, `child.participants[${index}].signalName`, 64),
    submitter: addressOf(participant.submitter, `child.participants[${index}].submitter`)
  }));
  const payload: JointChildOrderPayload = {
    parent: { planId: parentPlanId, orderId: parentOrderId, stageKey: parentStageKey },
    child: {
      planId: childPlanId,
      creator,
      payloadHash,
      idempotencyKey,
      deadline: childDeadline,
      participants
    }
  };
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const bodyHash = hashAppWritePayload(payload);
  return {
    action: "joint.child_order",
    payload,
    typedData: appTypedData("joint.child_order", chainId, {
      parentPlanId,
      parentOrderId,
      parentStageKey,
      childPlanId,
      creator,
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export interface JointChildSettleParent {
  readonly planId: string;
  readonly orderId: string;
  readonly stageKey: string;
}

export interface JointChildSettleChild {
  readonly planId: string;
  readonly creator: Address | string;
  readonly jointRef: string;
  /** child 自身的 deadline（进转发 body，不是签名窗口）。 */
  readonly deadline: BigUint;
}

/** 转发给 relayer /dock/child-settle 的 body：parent + child 两层，字段形状是 app wire。 */
export interface JointChildSettlePayload {
  readonly parent: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly stageKey: string;
  };
  readonly child: {
    readonly planId: Hex;
    readonly creator: Address;
    readonly jointRef: Hex;
    readonly deadline: string;
  };
}

export function planJointChildSettle(
  input: {
    readonly chainId: number;
    readonly parent: JointChildSettleParent;
    readonly child: JointChildSettleChild;
  } & WriteTimingInput
): BodyHashWritePlan<JointChildSettlePayload> {
  const chainId = chainIdOf(input.chainId);
  const parentPlanId = hash32Of(input.parent.planId, "parent.planId");
  const parentOrderId = hash32Of(input.parent.orderId, "parent.orderId");
  const parentStageKey = fieldText(input.parent.stageKey, "parent.stageKey", 36);
  const childPlanId = hash32Of(input.child.planId, "child.planId");
  const creator = addressOf(input.child.creator, "child.creator");
  const jointRef = hash32Of(input.child.jointRef, "child.jointRef");
  const childDeadline = decimalOf(input.child.deadline, "deadline");
  const payload: JointChildSettlePayload = {
    parent: { planId: parentPlanId, orderId: parentOrderId, stageKey: parentStageKey },
    child: { planId: childPlanId, creator, jointRef, deadline: childDeadline }
  };
  const nonce = nonceOf(input.nonce);
  const deadline = deadlineOf(input.deadline);
  const bodyHash = hashAppWritePayload(payload);
  return {
    action: "joint.child_settle",
    payload,
    typedData: appTypedData("joint.child_settle", chainId, {
      parentPlanId,
      parentOrderId,
      parentStageKey,
      childPlanId,
      creator,
      jointRef,
      bodyHash,
      nonce,
      deadline
    }),
    bodyHash,
    nonce,
    deadline
  };
}

export async function signDraftCreate(
  input: Parameters<typeof planDraftCreate>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<BodyHashSignedBody<DraftCreateBody>> {
  return signWritePlan(planDraftCreate(input), input);
}

export async function signDraftUpdate(
  input: Parameters<typeof planDraftUpdate>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<BodyHashSignedBody<UpdateOrderDraftInput>> {
  return signWritePlan(planDraftUpdate(input), input);
}

export async function signInviteCreate(
  input: Parameters<typeof planInviteCreate>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<WriteSignedBody<CreateStageInviteInput>> {
  return signWritePlan(planInviteCreate(input), input);
}

export async function signInviteRevoke(
  input: Parameters<typeof planInviteRevoke>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<WriteSignatureOnlyBody> {
  return signWritePlan(planInviteRevoke(input), input);
}

export async function signInviteAccept(
  input: Parameters<typeof planInviteAccept>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<InviteAcceptWriteBody> {
  return signWritePlan(planInviteAccept(input), input);
}

export async function signInviteReject(
  input: Parameters<typeof planInviteReject>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<InviteRejectWriteBody> {
  return signWritePlan(planInviteReject(input), input);
}

export async function signAttachOrder(
  input: Parameters<typeof planAttachOrder>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<BodyHashSignedBody<AttachOrderInput>> {
  return signWritePlan(planAttachOrder(input), input);
}

export async function signEvidenceUpload(
  input: Parameters<typeof planEvidenceUpload>[0] & {
    readonly provider: Eip1193Provider;
    readonly signer: Address | string;
  }
): Promise<BodyHashSignedBody<EvidenceUploadBody>> {
  return signWritePlan(planEvidenceUpload(input), input);
}

export {
  UVP_APP_BACKEND_DOMAIN_NAME,
  UVP_APP_BACKEND_DOMAIN_VERSION,
  UVP_APP_WRITE_ACTIONS,
  UVP_APP_WRITE_FIELDS,
  UVP_APP_WRITE_PRIMARY_TYPES,
  UVP_APP_WRITE_RESOURCE_FIELDS,
  UVP_APP_WRITE_TYPE_HASHES,
  UVP_ORDER_BOOK_DOMAIN_NAME,
  UVP_ORDER_BOOK_DOMAIN_VERSION,
  UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE,
  UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS,
  UVP_STAGE_INVITE_ACCEPT_TYPE_HASH,
  UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
  UVP_STAGE_INVITE_CREATE_TYPED_DATA_FIELDS,
  UVP_STAGE_INVITE_CREATE_TYPE_HASH,
  buildOrderBookDomain,
  buildUVPAppBackendDomain,
  buildUVPAppWriteTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  hashAppWritePayload,
  validateUVPStageInviteAcceptTypedData,
  validateUVPStageInviteCreateTypedData,
  type BuildUVPAppWriteTypedDataInput,
  type BuildUVPStageInviteAcceptTypedDataInput,
  type BuildUVPStageInviteCreateTypedDataInput,
  type OrderBookDomain,
  type OrderBookTypedDataField,
  type UvpAppBackendDomain,
  type UvpAppWriteAction,
  type UvpAppWritePrimaryType,
  type UvpAppWriteTypedData,
  type UVPStageInviteAcceptTypedData,
  type UVPStageInviteCreateTypedData
};

function appTypedData(
  action: UvpAppWriteAction,
  chainId: number,
  message: Readonly<Record<string, unknown>>
): UvpAppWriteTypedData {
  try {
    return buildUVPAppWriteTypedData({ action, chainId, message });
  } catch (error) {
    throw new WritePlanError("invalid_write_message", `${action}: ${errorMessage(error)}`);
  }
}

function resolveAcceptInvitee(
  typedData: UVPStageInviteAcceptTypedData,
  invitee: string | undefined
): { readonly typedData: UVPStageInviteAcceptTypedData; readonly invitee?: string | undefined } {
  const provided = invitee?.trim() ?? "";
  if (provided !== "" && !ADDRESS_PATTERN.test(provided)) {
    throw new WritePlanError("invitee_mismatch", "invitee 必须是 0x 20 字节地址。");
  }
  const isOpenLink = typedData.message.invitee.toLowerCase() === ZERO_ADDRESS;
  if (isOpenLink) {
    if (provided === "") {
      throw new WritePlanError(
        "invitee_required",
        "open link 接受必须在 body 与 typed data 里带 invitee（签名钱包）。"
      );
    }
    const rebuilt = buildUVPStageInviteAcceptTypedData({
      chainId: typedData.domain.chainId,
      verifyingContract: typedData.domain.verifyingContract,
      ...typedData.message,
      invitee: provided
    });
    return { typedData: rebuilt, invitee: rebuilt.message.invitee };
  }
  if (provided !== "" && provided.toLowerCase() !== typedData.message.invitee.toLowerCase()) {
    throw new WritePlanError(
      "invitee_mismatch",
      "传入的 invitee 与 preview typed data 的 invitee 不一致。"
    );
  }
  return {
    typedData,
    ...(provided === "" ? {} : { invitee: typedData.message.invitee })
  };
}

function evidenceContentHashOf(payload: CreateEvidenceRequestDTO): Hex {
  if (payload.content !== undefined) {
    return evidenceContentHash(payload.content);
  }
  if (typeof payload.textPayload === "string") {
    return hashEvidenceText(payload.textPayload).evidenceHash;
  }
  if (typeof payload.base64Payload === "string") {
    return evidenceContentHash({ encoding: "base64", value: payload.base64Payload });
  }
  if (payload.jsonPayload !== undefined) {
    return hashEvidenceJson(payload.jsonPayload).evidenceHash;
  }
  throw new WritePlanError(
    "invalid_evidence_content",
    "evidence.upload 需要 content/textPayload/base64Payload/jsonPayload 之一才能计算 contentHash。"
  );
}

function evidenceContentHash(content: EvidenceContentDTO): Hex {
  if (content.encoding === "text") {
    return hashEvidenceText(content.value).evidenceHash;
  }
  if (content.encoding === "json") {
    return hashEvidenceJson(content.value).evidenceHash;
  }
  return hashEvidenceBytes(decodeBase64(content.value)).evidenceHash;
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s/g, "");
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new WritePlanError("invalid_evidence_content", "base64 证据内容不合法，不能计算 contentHash。");
  }
}

function chainIdOf(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WritePlanError("invalid_chain", "chainId 必须是正整数。");
  }
  return value;
}

function decimalOf(value: BigUint, field: string): string {
  const text = typeof value === "bigint" ? value.toString(10) : String(value).trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new WritePlanError(
      field === "nonce" ? "invalid_nonce" : "invalid_deadline",
      `${field} 必须是非负十进制 uint256。`
    );
  }
  return text;
}

function nonceOf(value: BigUint | undefined): string {
  return value === undefined ? newWriteNonce() : decimalOf(value, "nonce");
}

function deadlineOf(value: BigUint | undefined): string {
  return value === undefined ? writeDeadline() : decimalOf(value, "deadline");
}

function draftIdOf(value: string): string {
  const draftId = value.trim();
  if (draftId === "") {
    throw new WritePlanError("invalid_draft_id", "draftId 不能为空。");
  }
  return draftId;
}

function inviteIdOf(value: string): string {
  const inviteId = value.trim();
  if (inviteId === "") {
    throw new WritePlanError("invalid_invite_id", "inviteId 不能为空。");
  }
  return inviteId;
}

function tokenOf(value: string): string {
  const token = value.trim();
  if (token === "") {
    throw new WritePlanError("invalid_token", "邀请 token 不能为空。");
  }
  return token;
}

function hash32Of(value: string, field: string): Hex {
  const text = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(text)) {
    throw new WritePlanError("invalid_write_message", `${field} 必须是 0x 32 字节 hex。`);
  }
  return text.toLowerCase() as Hex;
}

function addressOf(value: Address | string, field: string): Address {
  const text = typeof value === "string" ? value.trim() : "";
  if (!ADDRESS_PATTERN.test(text)) {
    throw new WritePlanError("invalid_write_message", `${field} 必须是 0x 20 字节地址。`);
  }
  return text as Address;
}

function fieldText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (text === "" || text.length > maxLength) {
    throw new WritePlanError(
      "invalid_write_message",
      `${field} 必须非空且不超过 ${maxLength} 个字符。`
    );
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
