// D4b 写传输口径：签名写请求带 body（含 writeSignature）但不带 wallet-proof
// 会话头；读请求仍带会话头；prepare 私有读校验 UVPStageInviteCreate typed data；
// preview 校验 D4b 新增的 App 域 rejectTypedData。响应/请求形状是 client 契约，
// 本文件不复制协议字段表。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductError,
  createProductClient,
  isProductError,
  type ProductFetcher
} from "../../src/browser/product/kernel/index.js";
import {
  buildUVPAppWriteTypedData,
  buildUVPStageInviteAcceptTypedData,
  buildUVPStageInviteCreateTypedData,
  writeSignatureEnvelope
} from "../../src/browser/app-write.js";

const CHAIN_ID = 31337;
const STATE_MACHINE = "0x4444444444444444444444444444444444444444";
const INVITEE = "0x2222222222222222222222222222222222222222";
const STAGE_ID = `0x${"a1".repeat(32)}`;
const TERMS_HASH = `0x${"f0".repeat(32)}`;
const STANDARD_HASH = `0x${"dd".repeat(32)}`;
const SIGNATURE = `0x${"ab".repeat(65)}`;
const SESSION_TOKEN = "session-token-1";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createCapture(fetcher: ProductFetcher): {
  readonly client: ReturnType<typeof createProductClient>;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const client = createProductClient({
    baseUrl: "https://product.test",
    sessionToken: SESSION_TOKEN,
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string> | undefined) ?? {},
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
      });
      return fetcher(input, init);
    }
  });
  return { client, requests };
}

function requestOf(requests: readonly CapturedRequest[], suffix: string): CapturedRequest {
  const found = requests.find((request) => request.url.endsWith(suffix));
  assert.ok(found, `missing request ${suffix}`);
  return found;
}

async function expectProductError(run: () => Promise<unknown>): Promise<ProductError> {
  try {
    await run();
  } catch (error) {
    assert.ok(isProductError(error), "expected ProductError");
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("D4b write transport", () => {
  it("写请求发带 writeSignature 的 body 且不带会话头；读请求仍带会话头", async () => {
    const { client, requests } = createCapture(async (input) => {
      const url = String(input);
      if (url.endsWith("/revoke")) {
        return jsonResponse({ inviteId: "invite-1", status: "revoked" });
      }
      return jsonResponse({ stageKey: "sourcing", dataState: "ok", items: [] });
    });

    const writeSignature = writeSignatureEnvelope({
      signature: SIGNATURE,
      nonce: "7",
      deadline: "1800000000"
    });
    const revoked = await client.revokeInvite("invite-1", { writeSignature });
    assert.equal(revoked.inviteId, "invite-1");
    const write = requestOf(requests, "/invites/invite-1/revoke");
    assert.equal(write.method, "POST");
    assert.deepEqual(write.body, { writeSignature });
    assert.equal(write.headers["x-uvp-store-session"], undefined);

    await client.listStageResources("order-1", "sourcing");
    const read = requestOf(requests, "/orders/order-1/stages/sourcing/resources");
    assert.equal(read.method, "GET");
    assert.equal(read.headers["x-uvp-store-session"], SESSION_TOKEN);
  });

  it("prepareInvite 是带会话头的私有读，返回校验后的 UVPStageInviteCreate typed data", async () => {
    const typedData = buildUVPStageInviteCreateTypedData({
      chainId: CHAIN_ID,
      verifyingContract: STATE_MACHINE,
      draftId: "draft-1",
      stageKey: "stage-b",
      stageId: STAGE_ID,
      slotKey: "slot-b",
      invitee: INVITEE,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: 1800000000,
      termsHash: TERMS_HASH,
      nonce: "123456789",
      deadline: "1800000000"
    });
    const prepared = {
      typedData,
      termsHash: TERMS_HASH,
      stageId: STAGE_ID,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: "1800000000",
      nonce: "123456789",
      deadline: "1800000000",
      chainId: CHAIN_ID,
      stateMachineAddress: STATE_MACHINE
    };
    const { client, requests } = createCapture(async () =>
      jsonResponse(prepared)
    );

    const result = await client.prepareInvite("draft-1", {
      stageKey: "stage-b",
      slotKey: "slot-b",
      invitee: INVITEE,
      expiresAt: "2027-01-15T08:00:00.000Z"
    });
    assert.equal(result.typedData.primaryType, "UVPStageInviteCreate");
    assert.equal(result.nonce, "123456789");
    assert.equal(result.typedData.domain.verifyingContract.toLowerCase(), STATE_MACHINE);
    const request = requestOf(requests, "/order-drafts/draft-1/invites/prepare");
    assert.equal(request.headers["x-uvp-store-session"], SESSION_TOKEN);
    assert.deepEqual(request.body, {
      stageKey: "stage-b",
      slotKey: "slot-b",
      expiresAt: "2027-01-15T08:00:00.000Z",
      invitee: INVITEE
    });

    const mismatched = createCapture(async () =>
      jsonResponse({ ...prepared, chainId: CHAIN_ID + 1 })
    );
    const error = await expectProductError(() =>
      mismatched.client.prepareInvite("draft-1", {
        stageKey: "stage-b",
        slotKey: "slot-b",
        expiresAt: "2027-01-15T08:00:00.000Z"
      })
    );
    assert.equal(error.kind, "invalid_response");
  });

  it("previewInvite 用 token bearer 发 invitee，并要求 D4b 的 App 域 rejectTypedData", async () => {
    const acceptTypedData = buildUVPStageInviteAcceptTypedData({
      chainId: CHAIN_ID,
      verifyingContract: STATE_MACHINE,
      draftId: "draft-1",
      inviteId: "invite-1",
      stageKey: "stage-b",
      stageId: STAGE_ID,
      slotKey: "slot-b",
      invitee: "0x0000000000000000000000000000000000000000",
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH,
      workDeadline: 1800000000,
      termsHash: TERMS_HASH,
      nonce: "123456789",
      deadline: "1800000000"
    });
    const rejectTypedData = buildUVPAppWriteTypedData({
      action: "invite.reject",
      chainId: CHAIN_ID,
      message: { inviteId: "invite-1", nonce: "123456789", deadline: "1800000000" }
    });
    const preview = {
      invite: {
        inviteId: "invite-1",
        draftId: "draft-1",
        stageKey: "stage-b",
        stageId: STAGE_ID,
        slotKey: "slot-b",
        subjectLabel: "承运人",
        status: "active",
        expiresAt: "2027-01-01T00:00:00.000Z",
        createdAt: "2026-10-25T00:00:00.000Z"
      },
      draftId: "draft-1",
      title: "示例订单",
      stageId: STAGE_ID,
      terms: { stageKey: "stage-b" },
      typedData: acceptTypedData,
      rejectTypedData,
      chainId: CHAIN_ID,
      stateMachineAddress: STATE_MACHINE,
      signNonce: "123456789",
      termsHash: TERMS_HASH
    };
    const { client, requests } = createCapture(async () => jsonResponse(preview));

    const result = await client.previewInvite("invite-1", "token-1", INVITEE);
    assert.equal(result.typedData.primaryType, "UVPStageInviteAccept");
    assert.equal(result.rejectTypedData.primaryType, "UVPInviteReject");
    const request = requestOf(requests, "/invites/invite-1/preview");
    assert.deepEqual(request.body, { token: "token-1", invitee: INVITEE });

    const missingReject = createCapture(async () => {
      const { rejectTypedData: _drop, ...rest } = preview;
      return jsonResponse(rest);
    });
    const error = await expectProductError(() =>
      missingReject.client.previewInvite("invite-1", "token-1")
    );
    assert.equal(error.kind, "invalid_response");
  });
});
