// 订单域客户端：逐条对齐 chain-services 的 /product/v3 路由（配置注册、
// 草稿、slot 邀请、EIP-712 接受、finalize、订单/阶段读），身份只经
// x-uvp-store-session 传递；响应形状不符即 invalid_response，不降级成空。

import {
  DEFAULT_PRODUCT_TIMEOUT_MS,
  ProductError,
  ProductTransport,
  invalidResponse,
  requireArray,
  requireRecord,
  requireString
} from "../../../core/product-transport.js";
import type {
  AcceptStageInviteInput,
  AcceptStageInviteResult,
  AttachOrderResult,
  AuditEventView,
  ConfigVersion,
  FinalizeOrderDraftInput,
  CreateStageInviteInput,
  EvidenceProofDTO,
  EvidenceRecordDTO,
  EvidenceUploadResponseDTO,
  FinalizeOrderDraftPreparation,
  FinalizeOrderDraftResult,
  Invite,
  OperatorOrderView,
  OrderDraftDetail,
  OperatorAuditQuery,
  OrderSummary,
  OrderView,
  ResourceListView,
  ResourceResolutionView,
  StageViewResponse,
  TaskListView,
  ProductClientOptions,
  ProductRequestOptions,
  RejectStageInviteInput,
  StageInviteCreated,
  StageInvitePreview,
  TaskActionView
} from "./types.js";
import { AUDIT_ACTIONS } from "@uvp-eth/product-dto";
import type {
  AttachOrderInput,
  CreateEvidenceRequestDTO,
  CreateOrderDraftInput,
  UpdateOrderDraftInput
} from "@uvp-eth/product-dto";

const PRODUCT_ROOT = "/product/v3";
const PRODUCT_EVIDENCE_ROOT = "/product/evidence";

export interface GetConfigOptions {
  /** 用 /versions/:version 别名路径（服务端两条读路径等价）。 */
  readonly viaVersionsAlias?: boolean | undefined;
}

export interface ProductClient {
  getConfig(configId: string, version: string, options?: GetConfigOptions): Promise<ConfigVersion>;
  /** 已发布配置目录（只读，configId/version 稳定排序）。 */
  listConfigs(): Promise<readonly ConfigVersion[]>;
  /** 配置发布前置校验（dry-run，与 publish 共用解析逻辑；不落库/不注册 plan）。 */
  /** 我的订单（服务端按会话钱包裁剪为 buyer/participant；陌生钱包的订单不返回）。 */
  listOrders(): Promise<readonly OrderSummary[]>;
  /** operator 订单排查视图（仅 operator 钱包；非 operator 保留服务端 403 operator_required）。 */
  getOperatorOrder(orderId: string): Promise<OperatorOrderView>;
  /** operator 审计读面（白名单字段，newest first；limit 默认 50/上限 200）。 */
  getOperatorAudit(query?: OperatorAuditQuery): Promise<readonly AuditEventView[]>;
  /** 任务动作装配（signal.submit 输入；不返回签名，不代签/广播）。 */
  prepareTaskAction(orderId: string, taskId: string): Promise<TaskActionView>;
  createOrderDraft(input: CreateOrderDraftInput, options?: ProductRequestOptions): Promise<OrderDraftDetail>;
  getOrderDraft(draftId: string): Promise<OrderDraftDetail>;
  updateOrderDraft(
    draftId: string,
    input: UpdateOrderDraftInput,
    options?: ProductRequestOptions
  ): Promise<OrderDraftDetail>;
  createInvite(draftId: string, input: CreateStageInviteInput): Promise<StageInviteCreated>;
  previewInvite(inviteId: string, token: string): Promise<StageInvitePreview>;
  acceptInvite(
    inviteId: string,
    input: AcceptStageInviteInput,
    options?: ProductRequestOptions
  ): Promise<AcceptStageInviteResult>;
  rejectInvite(
    inviteId: string,
    input: RejectStageInviteInput,
    options?: ProductRequestOptions
  ): Promise<AcceptStageInviteResult>;
  revokeInvite(inviteId: string): Promise<Invite>;
  /** finalize 第一步：服务端返回 UVPOrderFinalize typed data 与 funded/skipped 段。 */
  prepareFinalize(draftId: string): Promise<FinalizeOrderDraftPreparation>;
  /** finalize 第二步：提交 buyer 对 UVPOrderFinalize 的 EIP-712 签名。 */
  finalizeWithSignature(
    draftId: string,
    input: FinalizeOrderDraftInput,
    options?: ProductRequestOptions
  ): Promise<FinalizeOrderDraftResult>;
  /** attach 已出生的链上订单到草稿（birth 仍由 buyer/relayer 完成；本方法只登记业务行）。 */
  attachOrder(
    draftId: string,
    input: AttachOrderInput,
    options?: ProductRequestOptions
  ): Promise<AttachOrderResult>;
  /** 订单读面（服务端按 scope 裁剪；字段随 scope 缺失属正常）。 */
  getOrder(orderId: string): Promise<OrderView>;
  /** 单阶段读面（服务端投影）。 */
  getOrderStage(orderId: string, stageKey: string): Promise<StageViewResponse>;
  /** 本单任务投影（服务端派生，不是状态机）。 */
  listTasks(orderId: string): Promise<TaskListView>;
  listStageTasks(orderId: string, stageKey: string): Promise<TaskListView>;
  /** 阶段 fileResources 句柄（type + type 定义字段；服务端不代抓、不担保内容）。 */
  listStageResources(orderId: string, stageKey: string): Promise<ResourceListView>;
  /** 单个句柄的解析结果（inline/link/app_evidence/external 四态；错误走 HTTP 错误码）。 */
  resolveStageResource(
    orderId: string,
    stageKey: string,
    handleKey: string
  ): Promise<ResourceResolutionView>;
  /** 上传证据（JSON body；会话与 Idempotency-Key 由 transport 透传）。 */
  uploadEvidence(
    input: CreateEvidenceRequestDTO,
    options?: ProductRequestOptions
  ): Promise<EvidenceUploadResponseDTO>;
  /** 读取证据元数据；404 由 ProductError 具名 evidence_not_found 保留，不当作空。 */
  getEvidence(evidenceId: string): Promise<EvidenceRecordDTO>;
  /** 读取证据证明（hash、绑定与 verificationStatus）。 */
  getEvidenceProof(evidenceId: string): Promise<EvidenceProofDTO>;
  /** 客户端当前会话 token（getSessionToken 注入时返回注入值）。 */
  currentSessionToken(): string | undefined;
  /** 恢复/清除本地会话 token；返回是否真的改变了持有值。 */
  restoreSessionToken(token: string | undefined): boolean;
}

export function createProductClient(options: ProductClientOptions = {}): ProductClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new Error("订单服务地址未配置：未提供 Product baseUrl，uvp-client 不回退本地样例数据。");
  }
  const transport = new ProductTransport({
    baseUrl,
    fetcher: options.fetcher ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? DEFAULT_PRODUCT_TIMEOUT_MS,
    ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
    ...(options.getSessionToken !== undefined ? { getSessionToken: options.getSessionToken } : {})
  });

  return {
    async getConfig(configId, version, configOptions = {}) {
      const pathname = configOptions.viaVersionsAlias === true
        ? `${PRODUCT_ROOT}/configs/${segment(configId)}/versions/${segment(version)}`
        : `${PRODUCT_ROOT}/configs/${segment(configId)}/${segment(version)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return configVersionFrom(body, pathname);
    },

    async listConfigs() {
      const pathname = `${PRODUCT_ROOT}/configs`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      const record = requireRecord(body, pathname, "配置目录响应不是 JSON 对象");
      const configs = requireArray(record, "configs", pathname);
      return configs.map((config) => configVersionFrom(config, pathname));
    },

    async createOrderDraft(input, requestOptions = {}) {
      const pathname = `${PRODUCT_ROOT}/order-drafts`;
      const body = await transport.request<unknown>("POST", pathname, input);
      return draftDetailFrom(body, pathname);
    },

    async getOrderDraft(draftId) {
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return draftDetailFrom(body, pathname);
    },

    async updateOrderDraft(draftId, input, requestOptions = {}) {
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}`;
      const body = await transport.request<unknown>("PATCH", pathname, input);
      return draftDetailFrom(body, pathname);
    },

    async createInvite(draftId, input) {
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}/invites`;
      const body = await transport.request<unknown>("POST", pathname, input);
      const record = requireRecord(body, pathname, "邀请创建响应不是 JSON 对象");
      requireString(record, "inviteId", pathname, "邀请创建响应缺少 inviteId");
      requireString(record, "inviteToken", pathname, "邀请创建响应缺少一次性 inviteToken");
      return record as unknown as StageInviteCreated;
    },

    async previewInvite(inviteId, token) {
      const pathname = `${PRODUCT_ROOT}/invites/${segment(inviteId)}/preview`;
      const body = await transport.request<unknown>("POST", pathname, { token });
      const record = requireRecord(body, pathname, "邀请预览响应不是 JSON 对象");
      requireRecord(record.invite, pathname, "邀请预览响应缺少 invite");
      requireRecord(record.terms, pathname, "邀请预览响应缺少 stage 条款");
      requireRecord(record.typedData, pathname, "邀请预览响应缺少 typedData");
      requireString(record, "termsHash", pathname, "邀请预览响应缺少 termsHash");
      requireString(record, "signNonce", pathname, "邀请预览响应缺少 signNonce");
      requireString(record, "stateMachineAddress", pathname, "邀请预览响应缺少 stateMachineAddress");
      if (typeof record.chainId !== "number" || !Number.isSafeInteger(record.chainId) || record.chainId <= 0) {
        throw invalidResponse(pathname, "邀请预览响应缺少合法 chainId");
      }
      return record as unknown as StageInvitePreview;
    },

    async acceptInvite(inviteId, input, requestOptions = {}) {
      const pathname = `${PRODUCT_ROOT}/invites/${segment(inviteId)}/accept`;
      const body = await transport.request<unknown>("POST", pathname, input);
      return acceptanceFrom(body, pathname);
    },

    async rejectInvite(inviteId, input, requestOptions = {}) {
      const pathname = `${PRODUCT_ROOT}/invites/${segment(inviteId)}/reject`;
      const body = await transport.request<unknown>("POST", pathname, input);
      return acceptanceFrom(body, pathname);
    },

    async revokeInvite(inviteId) {
      const pathname = `${PRODUCT_ROOT}/invites/${segment(inviteId)}/revoke`;
      const body = await transport.request<unknown>("POST", pathname, undefined);
      const record = requireRecord(body, pathname, "撤销邀请响应不是 JSON 对象");
      requireString(record, "inviteId", pathname, "撤销邀请响应缺少 inviteId");
      requireString(record, "status", pathname, "撤销邀请响应缺少 status");
      return record as unknown as Invite;
    },

    async prepareFinalize(draftId) {
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}/finalize/prepare`;
      const body = await transport.request<unknown>("POST", pathname, undefined);
      return finalizePreparationFrom(body, pathname);
    },

    async finalizeWithSignature(draftId, input, requestOptions = {}) {
      // finalize 不发送 body；建单授权由 buyer 的 UVPOrderFinalize 签名承载。
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}/finalize`;
      const body = await transport.request<unknown>("POST", pathname, { signature: input.signature });
      return finalizeResultFrom(body, pathname);
    },

    async attachOrder(draftId, input, requestOptions = {}) {
      const pathname = `${PRODUCT_ROOT}/order-drafts/${segment(draftId)}/attach-order`;
      const body = await transport.request<unknown>("POST", pathname, input);
      return attachResultFrom(body, pathname);
    },

    async getOrder(orderId) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return orderViewFrom(body, pathname);
    },

    async listOrders() {
      const pathname = `${PRODUCT_ROOT}/orders`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      const record = requireRecord(body, pathname, "订单列表响应不是 JSON 对象");
      const orders = requireArray(record, "orders", pathname);
      return orders.map((order) => orderSummaryFrom(order, pathname));
    },

    async getOperatorOrder(orderId) {
      const pathname = `${PRODUCT_ROOT}/ops/orders/${segment(orderId)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return operatorOrderFrom(body, pathname);
    },

    async getOperatorAudit(query = {}) {
      const params = new URLSearchParams();
      if (query.orderId !== undefined) {
        params.set("orderId", query.orderId);
      }
      if (query.actor !== undefined) {
        params.set("actor", query.actor);
      }
      if (query.limit !== undefined) {
        params.set("limit", String(query.limit));
      }
      const search = params.toString();
      const pathname = `${PRODUCT_ROOT}/ops/audit${search.length > 0 ? `?${search}` : ""}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      const record = requireRecord(body, pathname, "审计响应不是 JSON 对象");
      const events = requireArray(record, "events", pathname);
      return events.map((event) => auditEventFrom(event, pathname));
    },

    async prepareTaskAction(orderId, taskId) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}/tasks/${segment(taskId)}/action`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return taskActionFrom(body, pathname);
    },

    async getOrderStage(orderId, stageKey) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}/stages/${segment(stageKey)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      const record = requireRecord(body, pathname, "阶段响应不是 JSON 对象");
      orderViewFrom(record.order, pathname);
      const stage = requireRecord(record.stage, pathname, "阶段响应缺少 stage");
      requireString(stage, "stageKey", pathname, "阶段响应缺少 stage.stageKey");
      requireDataState(record, pathname);
      return record as unknown as StageViewResponse;
    },

    async listTasks(orderId) {
      const pathname = `${PRODUCT_ROOT}/tasks?orderId=${encodeURIComponent(orderId)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return taskListFrom(body, pathname);
    },

    async listStageTasks(orderId, stageKey) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}/stages/${segment(stageKey)}/tasks`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return taskListFrom(body, pathname);
    },

    async listStageResources(orderId, stageKey) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}/stages/${segment(stageKey)}/resources`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      const record = requireRecord(body, pathname, "阶段句柄响应不是 JSON 对象");
      requireString(record, "stageKey", pathname, "阶段句柄响应缺少 stageKey");
      requireArray(record, "items", pathname);
      requireDataState(record, pathname);
      return record as unknown as ResourceListView;
    },

    async resolveStageResource(orderId, stageKey, handleKey) {
      const pathname = `${PRODUCT_ROOT}/orders/${segment(orderId)}/stages/${segment(stageKey)}/resources/${segment(handleKey)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return resolutionViewFrom(body, pathname);
    },

    async uploadEvidence(input, requestOptions = {}) {
      const pathname = PRODUCT_EVIDENCE_ROOT;
      const body = await transport.request<unknown>("POST", pathname, input);
      return evidenceUploadFrom(body, pathname);
    },

    async getEvidence(evidenceId) {
      const pathname = `${PRODUCT_EVIDENCE_ROOT}/${segment(evidenceId)}`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return evidenceRecordFrom(body, pathname);
    },

    async getEvidenceProof(evidenceId) {
      const pathname = `${PRODUCT_EVIDENCE_ROOT}/${segment(evidenceId)}/proof`;
      const body = await transport.request<unknown>("GET", pathname, undefined);
      return evidenceProofFrom(body, pathname);
    },

    currentSessionToken() {
      return transport.currentSessionToken();
    },

    restoreSessionToken(token) {
      return transport.restoreSessionToken(token);
    }
  };
}

function configVersionFrom(body: unknown, pathname: string): ConfigVersion {
  const record = requireRecord(body, pathname, "配置版本响应不是 JSON 对象");
  requireString(record, "configId", pathname, "配置版本响应缺少 configId");
  requireString(record, "version", pathname, "配置版本响应缺少 version");
  requireString(record, "status", pathname, "配置版本响应缺少 status");
  requireString(record, "configHash", pathname, "配置版本响应缺少 configHash");
  requireRecord(record.bundle, pathname, "配置版本响应缺少 bundle");
  return record as unknown as ConfigVersion;
}

function draftDetailFrom(body: unknown, pathname: string): OrderDraftDetail {
  const record = requireRecord(body, pathname, "草稿响应不是 JSON 对象");
  const draft = requireRecord(record.draft, pathname, "草稿响应缺少 draft");
  requireString(draft, "draftId", pathname, "草稿响应缺少 draftId");
  requireArray(record, "slots", pathname);
  const invites = requireArray(record, "invites", pathname);
  for (const entry of invites) {
    const invite = requireRecord(entry, pathname, "草稿响应的 invites 条目不是 JSON 对象");
    for (const field of ["inviteId", "status", "stageKey", "slotKey", "expiresAt", "createdAt"] as const) {
      requireString(invite, field, pathname, `草稿响应的 invite 缺少 ${field}`);
    }
  }
  return record as unknown as OrderDraftDetail;
}

function acceptanceFrom(body: unknown, pathname: string): AcceptStageInviteResult {
  const record = requireRecord(body, pathname, "邀请接受响应不是 JSON 对象");
  const invite = requireRecord(record.invite, pathname, "邀请接受响应缺少 invite");
  requireString(invite, "inviteId", pathname, "邀请接受响应缺少 inviteId");
  requireString(invite, "status", pathname, "邀请接受响应缺少 status");
  const slot = requireRecord(record.slot, pathname, "邀请接受响应缺少 slot");
  requireString(slot, "slotKey", pathname, "邀请接受响应缺少 slotKey");
  requireString(record, "draftStatus", pathname, "邀请接受响应缺少 draftStatus");
  requireString(record, "termsHash", pathname, "邀请接受响应缺少 termsHash");
  return record as unknown as AcceptStageInviteResult;
}

function finalizePreparationFrom(body: unknown, pathname: string): FinalizeOrderDraftPreparation {
  const record = requireRecord(body, pathname, "finalize prepare 响应不是 JSON 对象");
  for (const field of ["draftId", "planId", "planHash", "termsHash", "payloadHash", "nonce", "deadline"] as const) {
    requireString(record, field, pathname, `finalize prepare 响应缺少 ${field}`);
  }
  requireArray(record, "fundedStageKeys", pathname);
  requireArray(record, "skippedStageKeys", pathname);
  const typedData = requireRecord(record.typedData, pathname, "finalize prepare 响应缺少 typedData");
  if (typedData.primaryType !== "UVPOrderFinalize") {
    throw invalidResponse(pathname, "finalize prepare 的 typedData.primaryType 不是 UVPOrderFinalize");
  }
  return record as unknown as FinalizeOrderDraftPreparation;
}

const BIRTH_STATUSES: ReadonlySet<unknown> = new Set(["confirmed", "submitted", "unknown"]);

function finalizeResultFrom(body: unknown, pathname: string): FinalizeOrderDraftResult {
  const record = requireRecord(body, pathname, "finalize 响应不是 JSON 对象");
  for (const field of ["draftId", "orderId", "planId", "planHash", "stateMachine"] as const) {
    requireString(record, field, pathname, `finalize 响应缺少 ${field}`);
  }
  if (!BIRTH_STATUSES.has(record.status)) {
    throw invalidResponse(pathname, "finalize 响应的建单状态不是 confirmed/submitted/unknown（不得当作已建单）");
  }
  requireArray(record, "fundedStageKeys", pathname);
  requireArray(record, "skippedStageKeys", pathname);
  return record as unknown as FinalizeOrderDraftResult;
}

function attachResultFrom(body: unknown, pathname: string): AttachOrderResult {
  const record = requireRecord(body, pathname, "attach 响应不是 JSON 对象");
  for (const field of ["draftId", "orderId", "planId", "planHash", "stateMachine"] as const) {
    requireString(record, field, pathname, `attach 响应缺少 ${field}`);
  }
  if (record.status !== "triggered") {
    throw invalidResponse(pathname, "attach 响应的订单状态不是 triggered");
  }
  requireArray(record, "fundedStageKeys", pathname);
  requireArray(record, "skippedStageKeys", pathname);
  return record as unknown as AttachOrderResult;
}

const DATA_STATES: ReadonlySet<unknown> = new Set(["ok", "none", "pending", "unknown"]);

function requireDataState(record: Readonly<Record<string, unknown>>, pathname: string): void {
  if (!DATA_STATES.has(record.dataState)) {
    throw invalidResponse(pathname, "响应缺少合法的 dataState（ok/none/pending/unknown）");
  }
}

function orderViewFrom(body: unknown, pathname: string): OrderView {
  const record = requireRecord(body, pathname, "订单响应不是 JSON 对象");
  requireString(record, "orderId", pathname, "订单响应缺少 orderId");
  requireArray(record, "stages", pathname);
  requireDataState(record, pathname);
  return record as unknown as OrderView;
}

const ORDER_SUMMARY_ROLES: ReadonlySet<unknown> = new Set(["buyer", "participant"]);

function orderSummaryFrom(body: unknown, pathname: string): OrderSummary {
  const record = requireRecord(body, pathname, "订单摘要不是 JSON 对象");
  for (const field of [
    "orderId",
    "draftId",
    "configId",
    "configVersion",
    "buyerWallet",
    "title",
    "currency",
    "status",
    "createdAt",
    "updatedAt"
  ] as const) {
    requireString(record, field, pathname, `订单摘要缺少 ${field}`);
  }
  if (!ORDER_SUMMARY_ROLES.has(record.role)) {
    throw invalidResponse(pathname, "订单摘要 role 不是 buyer/participant");
  }
  return record as unknown as OrderSummary;
}

function operatorOrderFrom(body: unknown, pathname: string): OperatorOrderView {
  const record = requireRecord(body, pathname, "operator 订单响应不是 JSON 对象");
  requireString(record, "orderId", pathname, "operator 订单响应缺少 orderId");
  requireDataState(record, pathname);
  const stages = requireArray(record, "stages", pathname);
  for (const entry of stages) {
    const stage = requireRecord(entry, pathname, "operator 订单 stages 条目不是 JSON 对象");
    requireString(stage, "stageKey", pathname, "operator stage 缺少 stageKey");
    requireString(stage, "status", pathname, "operator stage 缺少 status");
    if (typeof stage.index !== "number" || !Number.isSafeInteger(stage.index)) {
      throw invalidResponse(pathname, "operator stage 的 index 不是安全整数");
    }
  }
  const exceptions = requireArray(record, "exceptions", pathname);
  for (const entry of exceptions) {
    const exception = requireRecord(entry, pathname, "operator 订单 exceptions 条目不是 JSON 对象");
    requireString(exception, "code", pathname, "operator exception 缺少 code");
    if (typeof exception.count !== "number" || !Number.isSafeInteger(exception.count)) {
      throw invalidResponse(pathname, "operator exception 的 count 不是安全整数");
    }
  }
  return record as unknown as OperatorOrderView;
}


const TASK_KINDS: ReadonlySet<unknown> = new Set(["accept_invite", "perform_stage"]);

function taskActionFrom(body: unknown, pathname: string): TaskActionView {
  const record = requireRecord(body, pathname, "任务动作响应不是 JSON 对象");
  for (const field of [
    "orderId",
    "taskId",
    "stageKey",
    "slotKey",
    "stateMachineAddress",
    "planId",
    "planHash",
    "submitter",
    "nextAction"
  ] as const) {
    requireString(record, field, pathname, `任务动作响应缺少 ${field}`);
  }
  if (!TASK_KINDS.has(record.kind)) {
    throw invalidResponse(pathname, "任务动作响应的 kind 不是 accept_invite/perform_stage");
  }
  if (typeof record.chainId !== "number" || !Number.isSafeInteger(record.chainId) || record.chainId <= 0) {
    throw invalidResponse(pathname, "任务动作响应的 chainId 不是合法链 id");
  }
  const signals = requireArray(record, "signals", pathname);
  for (const entry of signals) {
    const signal = requireRecord(entry, pathname, "任务动作 signals 条目不是 JSON 对象");
    for (const field of ["signalName", "admissionId", "stageId", "sourceId", "signalId"] as const) {
      requireString(signal, field, pathname, `任务动作 signal 缺少 ${field}`);
    }
  }
  return record as unknown as TaskActionView;
}

function taskListFrom(body: unknown, pathname: string): TaskListView {
  const record = requireRecord(body, pathname, "任务响应不是 JSON 对象");
  requireArray(record, "items", pathname);
  requireDataState(record, pathname);
  return record as unknown as TaskListView;
}

function resolutionViewFrom(body: unknown, pathname: string): ResourceResolutionView {
  const record = requireRecord(body, pathname, "阶段资源解析响应不是 JSON 对象");
  switch (record.kind) {
    case "inline":
      return { kind: "inline", text: requireString(record, "text", pathname, "inline 句柄响应缺少 text") };
    case "link":
      return { kind: "link", url: requireString(record, "url", pathname, "link 句柄响应缺少 url") };
    case "app_evidence": {
      const ref = requireString(record, "ref", pathname, "app_evidence 响应缺少 ref");
      if (record.contentHash === undefined) {
        return { kind: "app_evidence", ref };
      }
      if (typeof record.contentHash !== "string") {
        throw invalidResponse(pathname, "app_evidence 响应的 contentHash 不是字符串");
      }
      return { kind: "app_evidence", ref, contentHash: record.contentHash };
    }
    case "external":
      return {
        kind: "external",
        type: requireString(record, "type", pathname, "external 句柄响应缺少 type"),
        handle: requireRecord(record.handle, pathname, "external 句柄响应缺少 handle 对象"),
      };
    default:
      throw invalidResponse(pathname, "阶段资源解析响应的 kind 不是 inline/link/app_evidence/external");
  }
}

function evidenceRecordFrom(body: unknown, pathname: string): EvidenceRecordDTO {
  const record = requireRecord(body, pathname, "证据响应不是 JSON 对象");
  const evidence = requireRecord(record.evidence, pathname, "证据响应缺少 evidence");
  requireString(evidence, "evidenceId", pathname, "证据响应缺少 evidence.evidenceId");
  requireString(evidence, "status", pathname, "证据响应缺少 evidence.status");
  requireRecord(record.metadata, pathname, "证据响应缺少 metadata");
  requireRecord(record.accessPolicy, pathname, "证据响应缺少 accessPolicy");
  return record as unknown as EvidenceRecordDTO;
}

function evidenceUploadFrom(body: unknown, pathname: string): EvidenceUploadResponseDTO {
  const record = evidenceRecordFrom(body, pathname) as unknown as Record<string, unknown>;
  requireString(record, "payloadHash", pathname, "证据上传响应缺少 payloadHash");
  requireString(record, "payloadRef", pathname, "证据上传响应缺少 payloadRef");
  return record as unknown as EvidenceUploadResponseDTO;
}

function evidenceProofFrom(body: unknown, pathname: string): EvidenceProofDTO {
  const record = requireRecord(body, pathname, "证据证明响应不是 JSON 对象");
  for (const field of [
    "evidenceId",
    "payloadHash",
    "contentHash",
    "metadataHash",
    "payloadRef",
    "storageURI",
    "verificationStatus"
  ] as const) {
    requireString(record, field, pathname, `证据证明响应缺少 ${field}`);
  }
  return record as unknown as EvidenceProofDTO;
}

const AUDIT_ACTION_SET: ReadonlySet<unknown> = new Set(AUDIT_ACTIONS);

function auditEventFrom(body: unknown, pathname: string): AuditEventView {
  const record = requireRecord(body, pathname, "审计事件不是 JSON 对象");
  for (const field of ["eventId", "actorWallet", "action", "createdAt"] as const) {
    requireString(record, field, pathname, `审计事件缺少 ${field}`);
  }
  if (!AUDIT_ACTION_SET.has(record.action)) {
    throw invalidResponse(pathname, "审计事件的 action 不在白名单词表");
  }
  if (record.chainId !== undefined && (typeof record.chainId !== "number" || !Number.isSafeInteger(record.chainId))) {
    throw invalidResponse(pathname, "审计事件的 chainId 不是安全整数");
  }
  for (const field of ["orderId", "draftId", "inviteId", "ref", "payloadHash", "requestId"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw invalidResponse(pathname, `审计事件的 ${field} 不是字符串`);
    }
  }
  return record as unknown as AuditEventView;
}

function segment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductError({
      status: 0,
      endpoint: "",
      kind: "invalid_request",
      message: "路径参数不能为空"
    });
  }
  return encodeURIComponent(trimmed);
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim().replace(/\/+$/u, "");
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
