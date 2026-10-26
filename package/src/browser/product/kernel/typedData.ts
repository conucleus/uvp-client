// 邀请接受 EIP-712：域与类型单源是 @uvp-eth/protocol-bindings（UVPOrderBook/1、
// UVPStageInviteAccept），本模块只做「按独立已知事实核对服务端下发的 typed data」
// 与「给宿主可读摘要的字段」，不重复定义类型，也不在客户端重算 termsHash。

import {
  ORDER_BOOK_ZERO_ADDRESS,
  UVP_ORDER_BOOK_DOMAIN_NAME,
  UVP_ORDER_FINALIZE_PRIMARY_TYPE,
  UVP_ORDER_FINALIZE_TYPED_DATA_FIELDS,
  UVP_ORDER_FINALIZE_TYPE_HASH,
  buildUVPOrderFinalizeTypedData,
  validateUVPOrderFinalizeTypedData,
  UVP_ORDER_BOOK_DOMAIN_VERSION,
  UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE,
  UVP_STAGE_INVITE_ACCEPT_TYPE_HASH,
  UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS,
  buildOrderBookDomain,
  buildUVPStageInviteAcceptTypedData,
  validateUVPStageInviteAcceptTypedData,
  type BuildUVPOrderFinalizeTypedDataInput,
  type BuildUVPStageInviteAcceptTypedDataInput,
  type OrderBookDomain,
  type OrderBookTypedDataField,
  type UVPOrderFinalizeTypedData,
  type UVPStageInviteAcceptTypedData
} from "@uvp-eth/protocol-bindings";
import type { StageInvitePreview } from "@uvp-eth/product-dto";
import { formatBaseUnits } from "../../format/index.js";

export {
  ORDER_BOOK_ZERO_ADDRESS,
  UVP_ORDER_BOOK_DOMAIN_NAME,
  UVP_ORDER_BOOK_DOMAIN_VERSION,
  UVP_ORDER_FINALIZE_PRIMARY_TYPE,
  UVP_ORDER_FINALIZE_TYPED_DATA_FIELDS,
  UVP_ORDER_FINALIZE_TYPE_HASH,
  UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE,
  UVP_STAGE_INVITE_ACCEPT_TYPE_HASH,
  UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS,
  buildOrderBookDomain,
  buildUVPOrderFinalizeTypedData,
  buildUVPStageInviteAcceptTypedData,
  validateUVPOrderFinalizeTypedData,
  validateUVPStageInviteAcceptTypedData
};
export type {
  BuildUVPOrderFinalizeTypedDataInput,
  BuildUVPStageInviteAcceptTypedDataInput,
  OrderBookDomain,
  OrderBookTypedDataField,
  UVPOrderFinalizeTypedData,
  UVPStageInviteAcceptTypedData
};

/** typed data 里承载签名者地址的字段名（与协议字段表一致）。 */
export const INVITE_ACCEPT_SIGNER_FIELD = "invitee" as const;

/** 独立已知事实：chainId/verifyingContract 必须来自草稿或预览响应之外的可信来源。 */
export interface InviteAcceptDomainExpectation {
  readonly chainId: number;
  readonly verifyingContract: string;
}

export interface InviteAcceptFacts {
  readonly draftId?: string | undefined;
  readonly inviteId?: string | undefined;
  readonly stageKey?: string | undefined;
  readonly stageId?: string | undefined;
  readonly slotKey?: string | undefined;
  readonly invitee?: string | undefined;
  readonly amount?: string | undefined;
  readonly finalStandardHash?: string | undefined;
  readonly termsHash?: string | undefined;
  readonly nonce?: string | undefined;
  readonly workDeadline?: string | undefined;
  readonly deadline?: string | undefined;
}

export type InviteAcceptMismatchCode =
  | "invalid_expectation"
  | "invalid_typed_data"
  | "domain_chain_id"
  | "domain_verifying_contract"
  | "fact_mismatch";

export class InviteAcceptTypedDataError extends Error {
  override readonly name = "InviteAcceptTypedDataError";
  readonly code: InviteAcceptMismatchCode;
  readonly detail?: unknown;

  constructor(code: InviteAcceptMismatchCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/**
 * 校验服务端下发的邀请接受 typed data：结构/字段表单源交给 protocol-bindings，
 * 这里只补两件宿主侧必须自己判断的事——域是否指向本次订单的链与状态机锚，
 * 以及消息里的条款是否与调用方从别处拿到的条款一致（防被换单/换金额）。
 */
export function verifyInviteAcceptTypedData(
  value: unknown,
  expectation: InviteAcceptDomainExpectation,
  facts: InviteAcceptFacts = {}
): UVPStageInviteAcceptTypedData {
  if (!Number.isSafeInteger(expectation.chainId) || expectation.chainId <= 0) {
    throw new InviteAcceptTypedDataError("invalid_expectation", "expected chainId 必须是正整数");
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(expectation.verifyingContract)) {
    throw new InviteAcceptTypedDataError("invalid_expectation", "expected verifyingContract 必须是 EVM 地址");
  }
  let typedData: UVPStageInviteAcceptTypedData;
  try {
    typedData = validateUVPStageInviteAcceptTypedData(value);
  } catch (error) {
    throw new InviteAcceptTypedDataError(
      "invalid_typed_data",
      `签名对象不是合法的 UVPStageInviteAccept：${errorMessage(error)}`
    );
  }
  if (typedData.domain.chainId !== expectation.chainId) {
    throw new InviteAcceptTypedDataError(
      "domain_chain_id",
      `domain.chainId ${typedData.domain.chainId} 与本次订单链 ${expectation.chainId} 不一致`,
      { expected: expectation.chainId, actual: typedData.domain.chainId }
    );
  }
  if (typedData.domain.verifyingContract.toLowerCase() !== expectation.verifyingContract.toLowerCase()) {
    throw new InviteAcceptTypedDataError(
      "domain_verifying_contract",
      `domain.verifyingContract ${typedData.domain.verifyingContract} 与订单状态机锚 ${expectation.verifyingContract} 不一致`,
      { expected: expectation.verifyingContract, actual: typedData.domain.verifyingContract }
    );
  }
  assertFacts(typedData, facts);
  return typedData;
}

export interface InviteAcceptSummary {
  readonly primaryType: typeof UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE;
  readonly domainName: typeof UVP_ORDER_BOOK_DOMAIN_NAME;
  readonly domainVersion: typeof UVP_ORDER_BOOK_DOMAIN_VERSION;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly draftId: string;
  readonly inviteId: string;
  readonly stageKey: string;
  readonly stageId: string;
  readonly slotKey: string;
  readonly invitee: string;
  /** 签名者字段名：宿主用它与当前连接钱包比对。 */
  readonly signerField: typeof INVITE_ACCEPT_SIGNER_FIELD;
  readonly amountBaseUnits: string;
  /** 只有调用方给出 tokenDecimals 时才格式化；否则不猜位数。 */
  readonly amountDisplay?: string;
  readonly finalStandardHash: string;
  readonly termsHash: string;
  readonly nonce: string;
  readonly workDeadlineUnix: string;
  readonly workDeadlineIso?: string;
  readonly deadlineUnix: string;
  readonly deadlineIso?: string;
}

export function summarizeInviteAcceptTypedData(
  value: unknown,
  options: { readonly tokenDecimals?: number | undefined } = {}
): InviteAcceptSummary {
  const typedData = validateUVPStageInviteAcceptTypedData(value);
  const { message, domain } = typedData;
  const tokenDecimals = options.tokenDecimals;
  const workDeadlineIso = isoFromUnix(message.workDeadline);
  const deadlineIso = isoFromUnix(message.deadline);
  return {
    primaryType: typedData.primaryType,
    domainName: domain.name,
    domainVersion: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
    draftId: message.draftId,
    inviteId: message.inviteId,
    stageKey: message.stageKey,
    stageId: message.stageId,
    slotKey: message.slotKey,
    invitee: message.invitee,
    signerField: INVITE_ACCEPT_SIGNER_FIELD,
    amountBaseUnits: message.amount,
    ...(tokenDecimals !== undefined ? { amountDisplay: formatBaseUnits(message.amount, tokenDecimals) } : {}),
    finalStandardHash: message.finalStandardHash,
    termsHash: message.termsHash,
    nonce: message.nonce,
    workDeadlineUnix: message.workDeadline,
    ...(workDeadlineIso !== undefined ? { workDeadlineIso } : {}),
    deadlineUnix: message.deadline,
    ...(deadlineIso !== undefined ? { deadlineIso } : {})
  };
}

/**
 * 从服务端预览重建同一份 typed data（用于核对服务端响应自洽、离线测试或
 * 展示前二次确认）。服务端 preview.typedData 仍是权威来源；重建结果应与它
 * 逐字段相等，宿主不应把重建值当作新事实。
 */
export function buildInviteAcceptTypedDataFromPreview(
  preview: StageInvitePreview,
  invitee: string
): UVPStageInviteAcceptTypedData {
  const terms = preview.terms;
  return buildUVPStageInviteAcceptTypedData({
    chainId: preview.chainId,
    verifyingContract: preview.stateMachineAddress,
    draftId: preview.draftId,
    inviteId: preview.invite.inviteId,
    stageKey: terms.stageKey,
    stageId: preview.stageId,
    slotKey: preview.invite.slotKey,
    invitee,
    amount: terms.amount,
    finalStandardHash: terms.finalStandardHash,
    workDeadline: isoToUnixSeconds(terms.workDeadline, "workDeadline"),
    termsHash: preview.termsHash,
    nonce: preview.signNonce,
    deadline: isoToUnixSeconds(preview.invite.expiresAt, "invite.expiresAt")
  });
}

function assertFacts(typedData: UVPStageInviteAcceptTypedData, facts: InviteAcceptFacts): void {
  const message = typedData.message;
  const entries: readonly (readonly [keyof InviteAcceptFacts, string | undefined, string, boolean])[] = [
    ["draftId", facts.draftId, message.draftId, false],
    ["inviteId", facts.inviteId, message.inviteId, false],
    ["stageKey", facts.stageKey, message.stageKey, false],
    ["stageId", facts.stageId, message.stageId, true],
    ["slotKey", facts.slotKey, message.slotKey, false],
    ["invitee", facts.invitee, message.invitee, true],
    ["amount", facts.amount, message.amount, false],
    ["finalStandardHash", facts.finalStandardHash, message.finalStandardHash, true],
    ["termsHash", facts.termsHash, message.termsHash, true],
    ["nonce", facts.nonce, message.nonce, false],
    ["workDeadline", facts.workDeadline, message.workDeadline, false],
    ["deadline", facts.deadline, message.deadline, false]
  ];
  for (const [field, expected, actual, caseInsensitive] of entries) {
    if (expected === undefined) {
      continue;
    }
    const matches = caseInsensitive
      ? expected.toLowerCase() === actual.toLowerCase()
      : expected === actual;
    if (!matches) {
      throw new InviteAcceptTypedDataError(
        "fact_mismatch",
        `签名内容里的 ${field} 与已知条款不一致`,
        { field, expected, actual }
      );
    }
  }
}

/** UVPOrderFinalize 的域预期与条款事实（buyer 的建单授权）。 */
export interface OrderFinalizeDomainExpectation {
  readonly chainId: number;
  readonly verifyingContract: string;
}

export interface OrderFinalizeFacts {
  readonly draftId?: string | undefined;
  readonly planId?: string | undefined;
  readonly configId?: string | undefined;
  readonly configVersion?: string | undefined;
  readonly configHash?: string | undefined;
  readonly buyer?: string | undefined;
  readonly termsHash?: string | undefined;
  readonly nonce?: string | undefined;
  readonly deadline?: string | undefined;
}

export type OrderFinalizeMismatchCode =
  | "invalid_expectation"
  | "invalid_typed_data"
  | "domain_chain_id"
  | "domain_verifying_contract"
  | "fact_mismatch";

export class OrderFinalizeTypedDataError extends Error {
  override readonly name = "OrderFinalizeTypedDataError";
  readonly code: OrderFinalizeMismatchCode;
  readonly detail?: unknown;

  constructor(code: OrderFinalizeMismatchCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/** 校验服务端下发的 UVPOrderFinalize：结构单源交给 protocol-bindings，这里补域与事实核对。 */
export function verifyOrderFinalizeTypedData(
  value: unknown,
  expectation: OrderFinalizeDomainExpectation,
  facts: OrderFinalizeFacts = {}
): UVPOrderFinalizeTypedData {
  if (!Number.isSafeInteger(expectation.chainId) || expectation.chainId <= 0) {
    throw new OrderFinalizeTypedDataError("invalid_expectation", "expected chainId 必须是正整数");
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(expectation.verifyingContract)) {
    throw new OrderFinalizeTypedDataError("invalid_expectation", "expected verifyingContract 必须是 EVM 地址");
  }
  let typedData: UVPOrderFinalizeTypedData;
  try {
    typedData = validateUVPOrderFinalizeTypedData(value);
  } catch (error) {
    throw new OrderFinalizeTypedDataError(
      "invalid_typed_data",
      `签名对象不是合法的 UVPOrderFinalize：${errorMessage(error)}`
    );
  }
  if (typedData.domain.chainId !== expectation.chainId) {
    throw new OrderFinalizeTypedDataError(
      "domain_chain_id",
      `domain.chainId ${typedData.domain.chainId} 与本次订单链 ${expectation.chainId} 不一致`,
      { expected: expectation.chainId, actual: typedData.domain.chainId }
    );
  }
  if (typedData.domain.verifyingContract.toLowerCase() !== expectation.verifyingContract.toLowerCase()) {
    throw new OrderFinalizeTypedDataError(
      "domain_verifying_contract",
      `domain.verifyingContract ${typedData.domain.verifyingContract} 与订单状态机锚 ${expectation.verifyingContract} 不一致`,
      { expected: expectation.verifyingContract, actual: typedData.domain.verifyingContract }
    );
  }
  const entries: readonly (readonly [keyof OrderFinalizeFacts, string | undefined, string, boolean])[] = [
    ["draftId", facts.draftId, typedData.message.draftId, false],
    ["planId", facts.planId, typedData.message.planId, true],
    ["configId", facts.configId, typedData.message.configId, false],
    ["configVersion", facts.configVersion, typedData.message.configVersion, false],
    ["configHash", facts.configHash, typedData.message.configHash, true],
    ["buyer", facts.buyer, typedData.message.buyer, true],
    ["termsHash", facts.termsHash, typedData.message.termsHash, true],
    ["nonce", facts.nonce, typedData.message.nonce, false],
    ["deadline", facts.deadline, typedData.message.deadline, false]
  ];
  for (const [field, expected, actual, caseInsensitive] of entries) {
    if (expected === undefined) {
      continue;
    }
    const matches = caseInsensitive
      ? expected.toLowerCase() === actual.toLowerCase()
      : expected === actual;
    if (!matches) {
      throw new OrderFinalizeTypedDataError("fact_mismatch", `签名内容里的 ${field} 与已知条款不一致`, {
        field,
        expected,
        actual
      });
    }
  }
  return typedData;
}

export interface OrderFinalizeSummary {
  readonly primaryType: typeof UVP_ORDER_FINALIZE_PRIMARY_TYPE;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly draftId: string;
  readonly planId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: string;
  readonly buyer: string;
  readonly termsHash: string;
  readonly nonce: string;
  readonly deadlineUnix: string;
  readonly deadlineIso?: string;
  /** 宿主用它与当前连接钱包比对（签名者 = buyer）。 */
  readonly signerField: "buyer";
}

export function summarizeOrderFinalizeTypedData(value: unknown): OrderFinalizeSummary {
  const typedData = validateUVPOrderFinalizeTypedData(value);
  const deadlineIso = isoFromUnix(typedData.message.deadline);
  return {
    primaryType: typedData.primaryType,
    chainId: typedData.domain.chainId,
    verifyingContract: typedData.domain.verifyingContract,
    draftId: typedData.message.draftId,
    planId: typedData.message.planId,
    configId: typedData.message.configId,
    configVersion: typedData.message.configVersion,
    configHash: typedData.message.configHash,
    buyer: typedData.message.buyer,
    termsHash: typedData.message.termsHash,
    nonce: typedData.message.nonce,
    deadlineUnix: typedData.message.deadline,
    ...(deadlineIso !== undefined ? { deadlineIso } : {}),
    signerField: "buyer"
  };
}

function isoToUnixSeconds(value: string, fieldName: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new InviteAcceptTypedDataError("invalid_typed_data", `${fieldName} 不是 ISO-8601 时间`);
  }
  return Math.floor(millis / 1000).toString(10);
}

function isoFromUnix(value: string): string | undefined {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
