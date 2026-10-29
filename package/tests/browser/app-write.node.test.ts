// D4b 写签名面：9 个动作的 typed data 绑定（资源 id/bodyHash/nonce/deadline）、
// canonical-json bodyHash、accept/reject 用 preview 签发值、evidence contentHash
// 三态、以及签名后能由恢复函数还原 signer。编码/域由 protocol-bindings 拥有，
// 本文件只测 client 组合行为，不镜像 typehash/字段表。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashEvidenceBytes, hashEvidenceJson, hashEvidenceText } from "@uvp-eth/canonical-json";
import {
  buildUVPAppWriteTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  UVP_APP_WRITE_PRIMARY_TYPES,
  completeSignedWrite,
  hashAppWritePayload,
  newDraftId,
  newWriteNonce,
  planAttachOrder,
  planDraftCreate,
  planDraftUpdate,
  planEvidenceUpload,
  planInviteAccept,
  planInviteCreate,
  planInviteReject,
  planInviteRevoke,
  planJointChildOrder,
  recoverWriteSigner,
  signWritePlan,
  writeDeadline,
  writeSignatureEnvelope,
  WritePlanError
} from "../../src/browser/index.js";

const account = privateKeyToAccount(keccak256(stringToBytes("uvp-client.app-write.test")));
const CHAIN_ID = 31337;
const STATE_MACHINE = "0x4444444444444444444444444444444444444444";
const CONFIG_HASH = `0x${"cc".repeat(32)}`;
const STAGE_ID = `0x${"a1".repeat(32)}`;
const ORDER_ID = `0x${"0a".repeat(32)}`;
const PLAN_ID = `0x${"0b".repeat(32)}`;
const TERMS_HASH = `0x${"f0".repeat(32)}`;
const STANDARD_HASH = `0x${"dd".repeat(32)}`;
const TOKEN = "invite-token-1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const draftPayload = {
  configId: "example/order-config",
  configVersion: "1.0.0",
  title: "示例订单",
  currency: "USDT",
  stageSubset: ["stage-a", "stage-b"],
  stageTerms: [
    {
      stageKey: "stage-a",
      amount: "0",
      inviteDeadline: "2026-11-01T00:00:00.000Z",
      workDeadline: "2026-11-20T00:00:00.000Z"
    }
  ]
};

function planError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WritePlanError && error.code === code;
}

async function signWithAccount(typedData: object): Promise<`0x${string}`> {
  return account.signTypedData(
    typedData as unknown as Parameters<typeof account.signTypedData>[0]
  );
}

describe("write signature plans", () => {
  it("draft.create 固定 client draftId/configHash 进 bodyHash 与 typed data，签名可恢复 buyer", async () => {
    const plan = planDraftCreate({
      chainId: CHAIN_ID,
      payload: draftPayload,
      configHash: CONFIG_HASH
    });
    assert.equal(plan.action, "draft.create");
    assert.match(plan.payload.draftId, /^[0-9a-f]{8}-[0-9a-f]{4}-/u);
    assert.equal(plan.payload.configHash, CONFIG_HASH);
    assert.equal(plan.bodyHash, hashAppWritePayload(plan.payload));
    assert.equal(plan.typedData.primaryType, UVP_APP_WRITE_PRIMARY_TYPES["draft.create"]);
    assert.equal(plan.typedData.message.draftId, plan.payload.draftId);
    assert.equal(plan.typedData.message.configHash, CONFIG_HASH);
    assert.equal(plan.typedData.message.bodyHash, plan.bodyHash);
    assert.equal(plan.typedData.message.nonce, plan.nonce);
    assert.equal(plan.typedData.message.deadline, plan.deadline);

    const signature = await signWithAccount(plan.typedData);
    assert.equal((await recoverWriteSigner(plan, signature)).toLowerCase(), account.address.toLowerCase());
    const body = completeSignedWrite(plan, signature);
    assert.equal(body.writeSignature.scheme, "eip712");
    assert.equal(body.writeSignature.nonce, plan.nonce);
    assert.equal(body.writeSignature.deadline, plan.deadline);
    assert.equal(body.writeSignature.signature, signature);
    assert.equal(body.writeSignature.bodyHash, plan.bodyHash);
  });

  it("draft.update/attach 的 bodyHash 覆盖整份 payload（txHash 变化即变化）", () => {
    const update = planDraftUpdate({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: { title: "改后的标题" },
      nonce: "7",
      deadline: "1800000000"
    });
    assert.equal(update.action, "draft.update");
    assert.equal(update.bodyHash, hashAppWritePayload(update.payload));
    assert.equal(update.typedData.message.draftId, "draft-1");
    assert.equal(update.typedData.message.nonce, "7");
    assert.equal(
      completeSignedWrite(update, `0x${"ab".repeat(65)}`).writeSignature.bodyHash,
      update.bodyHash
    );
    assert.equal(update.typedData.message.deadline, "1800000000");

    const withoutTx = planAttachOrder({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: { orderId: ORDER_ID, planId: PLAN_ID }
    });
    const withTx = planAttachOrder({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: { orderId: ORDER_ID, planId: PLAN_ID, txHash: `0x${"ee".repeat(32)}` }
    });
    assert.notEqual(withoutTx.bodyHash, withTx.bodyHash);
    assert.equal(withTx.bodyHash, hashAppWritePayload(withTx.payload));
    assert.equal(withTx.typedData.message.orderId, ORDER_ID);
    assert.equal(withTx.typedData.message.planId, PLAN_ID);
    assert.equal(withTx.typedData.message.draftId, "draft-1");
    assert.equal(
      completeSignedWrite(withTx, `0x${"ab".repeat(65)}`).writeSignature.bodyHash,
      withTx.bodyHash
    );
  });

  it("invite.create 用 prepare typedData 签名，stageKey/slotKey/wallet 不符具名拒绝", () => {
    const typedData = buildUVPStageInviteCreateTypedData({
      chainId: CHAIN_ID,
      verifyingContract: STATE_MACHINE,
      draftId: "draft-1",
      stageKey: "stage-b",
      stageId: STAGE_ID,
      slotKey: "slot-b",
      invitee: account.address,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: 1800000000,
      termsHash: TERMS_HASH,
      nonce: "123456789",
      deadline: "1800000000"
    });
    const payload = {
      stageKey: "stage-b",
      slotKey: "slot-b",
      subjectLabel: "承运人",
      wallet: account.address,
      expiresAt: new Date(1_800_000_000 * 1000).toISOString()
    };
    const plan = planInviteCreate({ chainId: CHAIN_ID, payload, typedData });
    assert.equal(plan.action, "invite.create");
    assert.equal(plan.typedData.primaryType, "UVPStageInviteCreate");
    assert.equal(plan.nonce, "123456789");
    assert.equal(plan.deadline, "1800000000");

    assert.throws(
      () => planInviteCreate({ chainId: CHAIN_ID, payload: { ...payload, stageKey: "stage-c" }, typedData }),
      planError("invalid_write_message")
    );
    assert.throws(
      () =>
        planInviteCreate({
          chainId: CHAIN_ID,
          payload: { ...payload, wallet: "0x9999999999999999999999999999999999999999" },
          typedData
        }),
      planError("invitee_mismatch")
    );
    assert.throws(
      () =>
        planInviteCreate({
          chainId: CHAIN_ID,
          payload: { ...payload, expiresAt: new Date(1_700_000_000 * 1000).toISOString() },
          typedData
        }),
      planError("expires_at_mismatch")
    );
    const createEnvelope = completeSignedWrite(plan, `0x${"ab".repeat(65)}`);
    assert.equal("bodyHash" in createEnvelope.writeSignature, false);
  });

  it("invite.accept open link 必须 invitee 并重建 typed data；named invite 可省略；错链拒绝", () => {
    const openTypedData = buildUVPStageInviteAcceptTypedData({
      chainId: CHAIN_ID,
      verifyingContract: STATE_MACHINE,
      draftId: "draft-1",
      inviteId: "invite-1",
      stageKey: "stage-b",
      stageId: STAGE_ID,
      slotKey: "slot-b",
      invitee: ZERO_ADDRESS,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: 1800000000,
      termsHash: TERMS_HASH,
      nonce: "123456789",
      deadline: "1800000000"
    });
    assert.throws(
      () => planInviteAccept({ chainId: CHAIN_ID, token: TOKEN, typedData: openTypedData }),
      planError("invitee_required")
    );
    const accepted = planInviteAccept({
      chainId: CHAIN_ID,
      token: TOKEN,
      invitee: account.address,
      typedData: openTypedData
    });
    assert.equal(accepted.typedData.message.invitee.toLowerCase(), account.address.toLowerCase());
    assert.equal(accepted.payload.invitee?.toLowerCase(), account.address.toLowerCase());
    assert.equal(accepted.nonce, "123456789");
    assert.equal(accepted.deadline, "1800000000");

    const namedTypedData = buildUVPStageInviteAcceptTypedData({
      chainId: CHAIN_ID,
      verifyingContract: STATE_MACHINE,
      draftId: "draft-1",
      inviteId: "invite-1",
      stageKey: "stage-b",
      stageId: STAGE_ID,
      slotKey: "slot-b",
      invitee: account.address,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: 1800000000,
      termsHash: TERMS_HASH,
      nonce: "123456789",
      deadline: "1800000000"
    });
    const named = planInviteAccept({ chainId: CHAIN_ID, token: TOKEN, typedData: namedTypedData });
    assert.equal(named.payload.invitee, undefined);
    assert.throws(
      () =>
        planInviteAccept({
          chainId: CHAIN_ID,
          token: TOKEN,
          invitee: "0x9999999999999999999999999999999999999999",
          typedData: namedTypedData
        }),
      planError("invitee_mismatch")
    );
    assert.throws(
      () => planInviteAccept({ chainId: 1, token: TOKEN, typedData: namedTypedData }),
      planError("domain_chain_mismatch")
    );
  });

  it("invite.revoke/reject 只带 writeSignature 的 body，App 域字段绑定 inviteId/nonce/deadline", () => {
    const revoke = planInviteRevoke({
      chainId: CHAIN_ID,
      inviteId: "invite-1",
      nonce: "5",
      deadline: "1800000000"
    });
    assert.deepEqual(revoke.payload, {});
    assert.equal(revoke.typedData.primaryType, UVP_APP_WRITE_PRIMARY_TYPES["invite.revoke"]);
    assert.equal(revoke.typedData.message.inviteId, "invite-1");
    const revokeBody = completeSignedWrite(revoke, `0x${"ab".repeat(65)}`);
    assert.deepEqual(Object.keys(revokeBody), ["writeSignature"]);
    assert.equal("bodyHash" in revokeBody.writeSignature, false);

    const reject = planInviteReject({
      chainId: CHAIN_ID,
      inviteId: "invite-1",
      token: TOKEN,
      nonce: "123456789",
      deadline: "1800000000"
    });
    assert.deepEqual(reject.payload, { token: TOKEN });
    assert.equal(reject.typedData.primaryType, UVP_APP_WRITE_PRIMARY_TYPES["invite.reject"]);
    assert.equal(reject.typedData.message.nonce, "123456789");
    assert.equal(reject.typedData.message.deadline, "1800000000");
    const rejectBody = completeSignedWrite(reject, `0x${"cd".repeat(65)}`);
    assert.equal(rejectBody.token, TOKEN);
    assert.equal(rejectBody.writeSignature.nonce, "123456789");
    assert.equal("bodyHash" in rejectBody.writeSignature, false);
    assert.throws(
      () =>
        completeSignedWrite(
          { ...revoke, bodyHash: `0x${"11".repeat(32)}` },
          `0x${"ab".repeat(65)}`
        ),
      planError("invalid_write_message")
    );
    const appBodyHash = planDraftUpdate({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: {},
      nonce: "1",
      deadline: "2"
    });
    assert.throws(
      () =>
        completeSignedWrite(
          { ...appBodyHash, bodyHash: undefined } as never,
          `0x${"ab".repeat(65)}`
        ),
      planError("invalid_write_message")
    );
  });

  it("evidence.upload contentHash 三态 canonical-json 同源，且进 payload/typed data/bodyHash", () => {
    const text = planEvidenceUpload({
      chainId: CHAIN_ID,
      payload: { orderId: ORDER_ID, documentType: "invoice", textPayload: "hello 证据" }
    });
    assert.equal(text.payload.contentHash, hashEvidenceText("hello 证据").evidenceHash);
    assert.equal(text.typedData.message.contentHash, text.payload.contentHash);
    assert.equal(text.typedData.message.orderId, ORDER_ID);
    assert.equal(text.typedData.message.draftId, "");
    assert.equal(text.bodyHash, hashAppWritePayload(text.payload));

    const json = planEvidenceUpload({
      chainId: CHAIN_ID,
      payload: { orderId: ORDER_ID, documentType: "invoice", jsonPayload: { b: 2, a: 1 } }
    });
    assert.equal(json.payload.contentHash, hashEvidenceJson({ b: 2, a: 1 }).evidenceHash);

    const bytes = new TextEncoder().encode("hello");
    const base64 = Buffer.from(bytes).toString("base64");
    const binary = planEvidenceUpload({
      chainId: CHAIN_ID,
      payload: { draftId: "draft-1", documentType: "photo", base64Payload: base64 }
    });
    assert.equal(binary.payload.contentHash, hashEvidenceBytes(bytes).evidenceHash);
    assert.equal(binary.typedData.message.draftId, "draft-1");
    assert.equal(
      completeSignedWrite(binary, `0x${"ab".repeat(65)}`).writeSignature.bodyHash,
      binary.bodyHash
    );

    assert.throws(
      () => planEvidenceUpload({ chainId: CHAIN_ID, payload: { documentType: "invoice" } }),
      planError("invalid_evidence_content")
    );
  });

  it("signWritePlan 用注入 provider 签名并返回含 writeSignature 的完整 body；非法输入具名", async () => {
    const plan = planDraftUpdate({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: { currency: "USDC" },
      nonce: "9",
      deadline: "1800000000"
    });
    const body = await signWritePlan(plan, {
      signer: account.address,
      provider: {
        async request(args) {
          if (args.method !== "eth_signTypedData_v4") {
            throw new Error(`unexpected method ${args.method}`);
          }
          const params = args.params as readonly [string, string];
          return account.signTypedData(JSON.parse(params[1]));
        }
      }
    });
    assert.equal(body.currency, "USDC");
    assert.equal((await recoverWriteSigner(plan, body.writeSignature.signature)).toLowerCase(), account.address.toLowerCase());

    assert.throws(
      () =>
        planDraftUpdate({
          chainId: CHAIN_ID,
          draftId: "draft-1",
          payload: {},
          nonce: "1.5"
        }),
      planError("invalid_nonce")
    );
    assert.throws(
      () => writeSignatureEnvelope({ signature: "0x1234", nonce: "1", deadline: "2" }),
      planError("invalid_signature")
    );
  });

  it("默认 nonce/deadline 可生成，显式值原样保留", () => {
    const draftId = newDraftId();
    assert.match(draftId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    assert.notEqual(newDraftId(), draftId);
    assert.match(newWriteNonce(), /^[0-9]+$/u);
    const deadline = Number(writeDeadline({ nowSeconds: 1000, windowSeconds: 60 }));
    assert.equal(deadline, 1060);

    const plan = planDraftUpdate({
      chainId: CHAIN_ID,
      draftId: "draft-1",
      payload: {},
      nonce: 42,
      deadline: "1800000000"
    });
    assert.equal(plan.nonce, "42");
    assert.equal(plan.deadline, "1800000000");

    const appTyped = buildUVPAppWriteTypedData({
      action: "invite.revoke",
      chainId: CHAIN_ID,
      message: { inviteId: "invite-1", nonce: "1", deadline: "2" }
    });
    assert.equal(appTyped.domain.name, "UVPAppBackend");
  });

  it("joint.child_order：bodyHash 覆盖转发的 parent/child body，typed data 绑定 parent/child 身份", async () => {
    const childPlanId = `0x${"0c".repeat(32)}` as const;
    const idempotencyKey = `0x${"0d".repeat(32)}` as const;
    const participants = [
      { stageKey: "propose", signalName: "proposed", submitter: account.address },
      { stageKey: "accept", signalName: "payer_signed", submitter: account.address }
    ];
    const plan = planJointChildOrder({
      chainId: CHAIN_ID,
      parent: { planId: PLAN_ID, orderId: ORDER_ID, stageKey: "acquisition" },
      child: {
        planId: childPlanId,
        creator: account.address,
        payloadHash: TERMS_HASH,
        idempotencyKey,
        deadline: "1800000000",
        participants
      },
      nonce: "71",
      deadline: "1800000300"
    });
    assert.equal(plan.action, "joint.child_order");
    assert.equal(plan.bodyHash, hashAppWritePayload(plan.payload));
    assert.deepEqual(plan.payload, {
      parent: { planId: PLAN_ID, orderId: ORDER_ID, stageKey: "acquisition" },
      child: {
        planId: childPlanId,
        creator: account.address,
        payloadHash: TERMS_HASH,
        idempotencyKey,
        deadline: "1800000000",
        participants
      }
    });
    assert.equal(plan.typedData.domain.name, "UVPAppBackend");
    assert.equal(plan.typedData.domain.chainId, CHAIN_ID);
    assert.equal(plan.typedData.primaryType, UVP_APP_WRITE_PRIMARY_TYPES["joint.child_order"]);
    const message = plan.typedData.message as Readonly<Record<string, string>>;
    assert.equal(message["parentPlanId"], PLAN_ID);
    assert.equal(message["parentOrderId"], ORDER_ID);
    assert.equal(message["parentStageKey"], "acquisition");
    assert.equal(message["childPlanId"], childPlanId);
    assert.equal(message["creator"]?.toLowerCase(), account.address.toLowerCase());
    assert.equal(message["bodyHash"], plan.bodyHash);
    assert.equal(message["nonce"], "71");
    assert.equal(message["deadline"], "1800000300");

    const signature = await signWithAccount(plan.typedData);
    assert.equal(
      (await recoverWriteSigner(plan, signature)).toLowerCase(),
      account.address.toLowerCase()
    );
    const signed = completeSignedWrite(plan, signature);
    assert.equal(signed.writeSignature.scheme, "eip712");
    assert.equal(signed.writeSignature.bodyHash, plan.bodyHash);

    const changed = planJointChildOrder({
      chainId: CHAIN_ID,
      parent: { planId: PLAN_ID, orderId: ORDER_ID, stageKey: "acquisition" },
      child: {
        planId: childPlanId,
        creator: account.address,
        payloadHash: `0x${"0e".repeat(32)}`,
        idempotencyKey,
        deadline: "1800000000",
        participants
      },
      nonce: "72",
      deadline: "1800000300"
    });
    assert.notEqual(changed.bodyHash, plan.bodyHash);
    assert.equal(changed.typedData.message.bodyHash, changed.bodyHash);
  });
});
