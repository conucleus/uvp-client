// 内核测试夹具：一个三阶段配置版本 + 一份邀请预览/typed data。地址与
// hash 都是固定的公开测试值，不含任何私钥或凭据。

import type {
  ConfigBundle,
  ConfigVersion,
  StageInvitePreview,
  StageTerms
} from "@uvp-eth/product-dto";
import { buildUVPStageInviteAcceptTypedData } from "../../src/browser/product/kernel/typedData.js";

export const BUYER = "0x1111111111111111111111111111111111111111";
export const PERFORMER = "0x2222222222222222222222222222222222222222";
export const VERIFIER = "0x3333333333333333333333333333333333333333";
export const STATE_MACHINE = "0x4444444444444444444444444444444444444444";
export const CHAIN_ID = 31337;
export const STANDARD_HASH = `0x${"dd".repeat(32)}`;
export const ALT_STANDARD_HASH = `sha256:${"ee".repeat(32)}`;
export const CONFIG_HASH = `0x${"cc".repeat(32)}`;
export const PLAN_ID = `0x${"0a".repeat(32)}`;
export const PLAN_HASH = `0x${"0b".repeat(32)}`;
export const STAGE_ID_STAGE_A = `0x${"a1".repeat(32)}`;
export const STAGE_ID_STAGE_B = `0x${"b2".repeat(32)}`;
export const STAGE_ID_STAGE_C = `0x${"c3".repeat(32)}`;

export function configBundleFixture(): ConfigBundle {
  return {
    schema: "uvp.order-config/v3",
    configId: "example/order-config",
    version: "1.0.0",
    status: "published",
    title: "示例订单",
    currency: "USDT",
    chain: { chainId: CHAIN_ID, network: "example-chain" },
    slots: [
      { key: "slot-a", label: "slot A", kind: "participant" },
      { key: "slot-b", label: "slot B", kind: "participant" },
      { key: "slot-c", label: "slot C", kind: "participant" },
      { key: "contract-account", label: "合约账户", kind: "contract" }
    ],
    stages: [
      {
        key: "stage-a",
        name: "示例阶段 A",
        index: 1,
        optional: false,
        funded: false,
        slots: { "slot-a": "阶段 A" },
        senders: ["slot-a"],
        signals: [{ name: "completed", by: "slot-a" }],
        time: [{ name: "stage_a_window", expr: "completed +3d" }]
      },
      {
        key: "stage-b",
        name: "示例阶段 B",
        index: 2,
        optional: true,
        funded: true,
        slots: { "slot-b": "阶段 B" },
        senders: ["slot-a", "slot-b"],
        time: [{ name: "stage_b_window", expr: "approved +14d" }],
        fileResources: ["std/stage-b"],
      },
      {
        key: "stage-c",
        name: "示例阶段 C",
        index: 3,
        optional: true,
        funded: true,
        slots: { "slot-c": "阶段 C" },
        senders: ["slot-a", "slot-b"],
        fileResources: [{ ref: "std/stage-c" }],
      }
    ],
    fileResources: [
      { name: "std/stage-b", version: "1.0.0", hash: STANDARD_HASH, ref: "standards/stage-b.md" },
      { name: "std/stage-c", version: "1.0.0", hash: ALT_STANDARD_HASH, ref: "standards/stage-c.md" }
    ],
    stageProfiles: { default: ["stage-a", "stage-b", "stage-c"] },
    defaultProfile: "default"
  };
}

export function configVersionFixture(): ConfigVersion {
  return {
    configId: "example/order-config",
    version: "1.0.0",
    status: "published",
    configHash: CONFIG_HASH,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    title: "示例订单",
    currency: "USDT",
    createdBy: BUYER,
    createdAt: "2026-10-25T00:00:00.000Z",
    publishedAt: "2026-10-25T00:00:00.000Z",
    bundle: configBundleFixture()
  };
}

export function stageTermsFixture(): StageTerms {
  const bundle = configBundleFixture();
  return {
    orderDraftId: "draft-1",
    configId: bundle.configId,
    configVersion: bundle.version,
    configHash: CONFIG_HASH,
    stageKey: "stage-b",
    stageId: STAGE_ID_STAGE_B,
    slots: { "slot-b": PERFORMER },
    amount: "1200000000",
    standard: { name: "std/stage-b", version: "1.0.0", hash: STANDARD_HASH, ref: "standards/stage-b.md" },
    finalStandardHash: STANDARD_HASH,
    inviteDeadline: "2026-11-01T00:00:00.000Z",
    workDeadline: "2026-11-20T00:00:00.000Z",
    termsHash: `0x${"f0".repeat(32)}`
  };
}

export function inviteTypedDataFixture() {
  return buildUVPStageInviteAcceptTypedData({
    chainId: CHAIN_ID,
    verifyingContract: STATE_MACHINE,
    draftId: "draft-1",
    inviteId: "invite-1",
    stageKey: "stage-b",
    stageId: STAGE_ID_STAGE_B,
    slotKey: "slot-b",
    invitee: PERFORMER,
    amount: "1200000000",
    finalStandardHash: STANDARD_HASH,
    workDeadline: Math.floor(Date.parse("2026-11-20T00:00:00.000Z") / 1000),
    termsHash: `0x${"f0".repeat(32)}`,
    nonce: "123456789",
    deadline: Math.floor(Date.parse("2026-11-01T00:00:00.000Z") / 1000)
  });
}

export function invitePreviewFixture(): StageInvitePreview {
  const terms = stageTermsFixture();
  return {
    invite: {
      inviteId: "invite-1",
      draftId: "draft-1",
      stageKey: "stage-b",
      stageId: STAGE_ID_STAGE_B,
      slotKey: "slot-b",
      subjectLabel: "某某车商",
      status: "active",
      expiresAt: "2026-11-01T00:00:00.000Z",
      createdAt: "2026-10-25T00:00:00.000Z"
    },
    draftId: "draft-1",
    title: "示例订单",
    stageId: STAGE_ID_STAGE_B,
    terms,
    typedData: inviteTypedDataFixture(),
    chainId: CHAIN_ID,
    stateMachineAddress: STATE_MACHINE,
    signNonce: "123456789",
    termsHash: terms.termsHash!
  };
}
