// 订单域传输类型：DTO 单源是 @uvp-eth/product-dto（服务端同一份），这里只
// 定义内核客户端的选项/请求附加参数，并原样再导出宿主需要的 DTO 名称。

import type {
  ProductFetcher,
  ProductRequestOptions,
  ProductSessionTokenProvider
} from "../../../core/transport.js";
import type {
  AcceptStageInviteInput,
  AcceptStageInviteResult,
  ConfigBundle,
  ConfigFileResourceRef,
  ConfigSlotKind,
  ConfigSlot,
  ConfigSlotVisibility,
  ConfigStage,
  ConfigVersion,
  CreateOrderDraftInput,
  CreateStageInviteInput,
  FinalizeOrderDraftInput,
  FinalizeOrderDraftPreparation,
  FinalizeOrderDraftResult,
  Invite,
  OrderBirthStatus,
  OrderDraftDetail,
  OrderDraftStatus,
  OrderDraft,
  OrderStage,
  Order,
  OrderStageDetail,
  RejectStageInviteInput,
  StageInviteCreated,
  StageInvitePreview,
  StageInviteStatus,
  StageSlotStatus,
  StageSlot,
  StageStandardRef,
  StageTermsInput,
  StageTerms,
  StageWindowValues,
  UpdateOrderDraftInput
} from "@uvp-eth/product-dto";

export type {
  ProductFetcher,
  ProductRequestOptions,
  ProductSessionTokenProvider,
  AcceptStageInviteInput,
  AcceptStageInviteResult,
  ConfigBundle,
  ConfigFileResourceRef,
  ConfigSlotKind,
  ConfigSlot,
  ConfigSlotVisibility,
  ConfigStage,
  ConfigVersion,
  CreateOrderDraftInput as CreateOrderDraftKernelInput,
  CreateStageInviteInput,
  FinalizeOrderDraftInput,
  FinalizeOrderDraftPreparation,
  FinalizeOrderDraftResult,
  Invite,
  OrderBirthStatus,
  OrderDraftDetail,
  OrderDraftStatus,
  OrderDraft,
  OrderStage,
  Order,
  OrderStageDetail,
  RejectStageInviteInput,
  StageInviteCreated,
  StageInvitePreview,
  StageInviteStatus,
  StageSlotStatus,
  StageSlot,
  StageStandardRef,
  StageTermsInput,
  StageTerms,
  StageWindowValues,
  UpdateOrderDraftInput as UpdateOrderDraftKernelInput
};

/**
 * 配置发布入参：服务端接受 `{config, status?, configHash?}`（也接受裸 bundle，
 * 内核只暴露带 `config` 的显式形态，避免与状态字段混淆）。
 */
export interface PublishConfigInput {
  readonly config: ConfigBundle;
  readonly status?: "draft" | "published" | undefined;
  /** 可选：客户端已有权威 hash 时回呈，服务端不一致会 422 config_hash_mismatch。 */
  readonly configHash?: string | undefined;
  /** 发布时登记已编译/注册的 UVP plan；与 planHash 必须成对出现，订单复用它。 */
  readonly planId?: string | undefined;
  readonly planHash?: string | undefined;
}

export interface ProductClientOptions {
  /** 参与者服务基地址；缺省直接抛错，不回退任何样例数据。 */
  readonly baseUrl?: string | undefined;
  readonly fetcher?: ProductFetcher | undefined;
  /** 单个请求的超时毫秒数；默认对齐现有 product client 的 6s 口径。 */
  readonly timeoutMs?: number | undefined;
  /** 固定会话 token（与 getSessionToken 二选一，getSessionToken 优先）。 */
  readonly sessionToken?: string | undefined;
  /** 每次请求前读取会话 token（接已有客户端的 proveWalletControl 结果）。 */
  readonly getSessionToken?: ProductSessionTokenProvider | undefined;
}

// ---------------------------------------------------------------------------
// 读投影（服务端按可见性 scope 裁剪后的形状）：字段由服务端裁剪，
// 客户端只做结构校验与展示，不自行放行/补字段。
// ---------------------------------------------------------------------------

export type DataState = "ok" | "none" | "pending" | "unknown";

export interface StandardView {
  readonly name: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface SlotView {
  readonly slotKey: string;
  readonly required: boolean;
  readonly subjectLabel?: string;
  readonly status: string;
  readonly wallet?: string;
  readonly contactRef?: string;
}

export interface HandleView {
  readonly handleKey: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface OrderStageView {
  readonly stageKey: string;
  readonly stageId: string;
  readonly index: number;
  readonly status: string;
  readonly amount?: string;
  readonly feeBps?: number;
  readonly finalStandardHash?: string;
  readonly inviteDeadline?: string;
  readonly workDeadline?: string;
  readonly standard?: StandardView;
  readonly slots?: readonly SlotView[];
  readonly fileResources?: readonly HandleView[];
}

export interface OrderView {
  readonly orderId: string;
  readonly planId?: string;
  readonly chainId?: number;
  readonly stateMachine?: string;
  readonly status?: string;
  readonly title?: string;
  readonly currency?: string;
  readonly buyerWallet?: string;
  readonly termsHash?: string;
  readonly txHash?: string;
  readonly draftId?: string;
  readonly dataState: DataState;
  readonly stages: readonly OrderStageView[];
}

export interface StageViewResponse {
  readonly order: OrderView;
  readonly stage: OrderStageView;
  readonly dataState: DataState;
}

export interface ResourceListView {
  readonly dataState: DataState;
  readonly stageKey: string;
  readonly items: readonly HandleView[];
  readonly reason?: string;
}

export interface TaskView {
  readonly taskId: string;
  readonly orderId: string;
  readonly stageKey: string;
  readonly slotKey: string;
  readonly wallet: string;
  readonly kind: "accept_invite" | "fund_stage" | "perform_stage" | "verify_stage" | "settle_stage";
  readonly status: "open" | "blocked" | "done";
  readonly nextAction: string;
  readonly dueAt?: string;
  readonly actionRef?: string;
  readonly blockedBy?: readonly string[];
}

export interface TaskListView {
  readonly dataState: DataState;
  readonly orderId?: string;
  readonly stageKey?: string;
  readonly items: readonly TaskView[];
}
