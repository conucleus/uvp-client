// 开单草稿映射：宿主友好的 stage 选择（每段金额/验收方式/期限/标准）→
// 服务端 CreateOrderDraftInput。服务端 slot 集合来自配置，不接受客户端自造角色
// 入参（slot 由配置派生），映射不上的字段显式报错而不是静默丢弃；期限由
// 宿主给出，kernel 不替买家默认。

import type {
  CreateOrderDraftInput,
  StageStandardRef,
  StageTermsInput
} from "@uvp-eth/product-dto";
import { flatStageByKey } from "./config.js";
import type { FlatConfig, FlatStage } from "./config.js";

export interface StageSelection {
  readonly stageKey: string;
  /** 本段冻款金额（base units 十进制字符串，服务端 normalizeAmount 同口径）。 */
  readonly amountBaseUnits: string;
  /** 本段参与的 slot（slotKey → 值）；缺省不提交。 */
  readonly slots?: Readonly<Record<string, string>> | undefined;
  readonly workDeadline?: string | undefined;
  readonly inviteDeadline?: string | undefined;
  /** 本段最终标准；缺省时取配置可解析的默认标准，配置无 hash 则报错。 */
  readonly standardRef?: StageStandardRef | undefined;
}

export type DraftMappingProblemCode =
  | "missing_title"
  | "missing_currency"
  | "empty_stages"
  | "duplicate_stage"
  | "unknown_stage"
  | "stage_subset_mismatch"
  | "invalid_amount"
  | "missing_invite_deadline"
  | "missing_work_deadline"
  | "invalid_deadline"
  | "deadline_order"
  | "standard_hash_missing";

export interface DraftMappingProblem {
  readonly code: DraftMappingProblemCode;
  readonly message: string;
  readonly detail?: unknown;
}

export type DraftMappingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: DraftMappingProblem };

const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/u;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-fA-F]{64}$/u;

export function mapStageSelection(
  selection: StageSelection,
  stage: FlatStage
): DraftMappingResult<StageTermsInput> {
  if (!AMOUNT_PATTERN.test(selection.amountBaseUnits)) {
    return fail("invalid_amount", `stage ${selection.stageKey} 的金额必须是 base units 十进制整数字符串`, {
      amountBaseUnits: selection.amountBaseUnits
    });
  }
  if (selection.amountBaseUnits.length > 78) {
    return fail("invalid_amount", `stage ${selection.stageKey} 的金额超出 uint256 范围`);
  }
  const inviteDeadline = selection.inviteDeadline;
  if (inviteDeadline === undefined || inviteDeadline.trim().length === 0) {
    return fail("missing_invite_deadline", `stage ${selection.stageKey} 缺少邀请截止时间（服务端必填，kernel 不替买家默认）`);
  }
  const workDeadline = selection.workDeadline;
  if (workDeadline === undefined || workDeadline.trim().length === 0) {
    return fail("missing_work_deadline", `stage ${selection.stageKey} 缺少履约截止时间（服务端必填，kernel 不替买家默认）`);
  }
  const inviteMs = Date.parse(inviteDeadline);
  const workMs = Date.parse(workDeadline);
  if (!Number.isFinite(inviteMs)) {
    return fail("invalid_deadline", `stage ${selection.stageKey} 的 inviteDeadline 不是 ISO-8601 时间`, { inviteDeadline });
  }
  if (!Number.isFinite(workMs)) {
    return fail("invalid_deadline", `stage ${selection.stageKey} 的 workDeadline 不是 ISO-8601 时间`, { workDeadline });
  }
  if (workMs <= inviteMs) {
    return fail("deadline_order", `stage ${selection.stageKey} 的 workDeadline 必须晚于 inviteDeadline`, {
      inviteDeadline,
      workDeadline
    });
  }
  let standard: StageStandardRef | undefined;
  if (selection.standardRef !== undefined) {
    const problem = standardProblem(selection.standardRef);
    if (problem !== undefined) {
      return fail("standard_hash_missing", `stage ${selection.stageKey} 的标准引用不可用：${problem}`, {
        standardRef: selection.standardRef
      });
    }
    standard = selection.standardRef;
  } else if (stage.defaultStandard?.resolvable !== true) {
    return fail(
      "standard_hash_missing",
      `stage ${selection.stageKey} 的配置标准没有可解析 hash，必须显式提供 standardRef（含 hash）`
    );
  }

  return {
    ok: true,
    value: {
      stageKey: selection.stageKey,
      amount: selection.amountBaseUnits,
      inviteDeadline,
      workDeadline,
      ...(standard !== undefined ? { standard } : {}),
      ...(selection.slots !== undefined ? { slots: selection.slots } : {})
    }
  };
}

export interface CreateOrderDraftPlanInput {
  readonly config: FlatConfig;
  readonly title: string;
  readonly stages: readonly StageSelection[];
  /** 缺省按 stages 顺序派生；显式给出时必须与 stages 完全一致（服务端会忽略多余条款）。 */
  readonly stageSubset?: readonly string[] | undefined;
  readonly currency?: string | undefined;
}

export function buildCreateOrderDraftInput(
  input: CreateOrderDraftPlanInput
): DraftMappingResult<CreateOrderDraftInput> {
  const title = input.title.trim();
  if (title.length === 0) {
    return fail("missing_title", "订单标题不能为空");
  }
  if (input.stages.length === 0) {
    return fail("empty_stages", "至少要选择一个阶段");
  }
  const currency = (input.currency ?? input.config.currency)?.trim();
  if (currency === undefined || currency.length === 0) {
    return fail("missing_currency", "配置与输入都没有声明 currency，无法开单");
  }
  const seen = new Set<string>();
  const stageTerms: StageTermsInput[] = [];
  for (const selection of input.stages) {
    if (seen.has(selection.stageKey)) {
      return fail("duplicate_stage", `阶段 ${selection.stageKey} 重复出现`, { stageKey: selection.stageKey });
    }
    seen.add(selection.stageKey);
    const stage = flatStageByKey(input.config, selection.stageKey);
    if (stage === undefined) {
      return fail("unknown_stage", `配置 ${input.config.configId}@${input.config.version} 没有阶段 ${selection.stageKey}`, {
        stageKey: selection.stageKey
      });
    }
    const mapped = mapStageSelection(selection, stage);
    if (!mapped.ok) {
      return mapped;
    }
    stageTerms.push(mapped.value);
  }
  const derivedSubset = input.stages.map((selection) => selection.stageKey);
  if (input.stageSubset !== undefined) {
    const requested = input.stageSubset;
    const sameLength = requested.length === derivedSubset.length;
    const sameSet = sameLength && requested.every((stageKey) => derivedSubset.includes(stageKey));
    if (!sameSet) {
      return fail("stage_subset_mismatch", "stageSubset 必须与 stages 一一对应（顺序/数量/集合一致）", {
        requested,
        derived: derivedSubset
      });
    }
  }
  return {
    ok: true,
    value: {
      configId: input.config.configId,
      configVersion: input.config.version,
      title,
      currency,
      stageSubset: derivedSubset,
      stageTerms
    }
  };
}

function standardProblem(standard: StageStandardRef): string | undefined {
  if (standard.name.trim().length === 0) {
    return "缺少 name";
  }
  if (!BYTES32_PATTERN.test(standard.hash) && !SHA256_PATTERN.test(standard.hash)) {
    return "hash 必须是 0x 32 字节摘要或 sha256:<64 hex>";
  }
  return undefined;
}


function fail(
  code: DraftMappingProblemCode,
  message: string,
  detail?: unknown
): { readonly ok: false; readonly problem: DraftMappingProblem } {
  return {
    ok: false,
    problem: {
      code,
      message,
      ...(detail !== undefined ? { detail } : {})
    }
  };
}
