// 邀请接受 EIP-712：type hash/域四要素来自 protocol-bindings 单源；本测试
// 固定 type hash 与域常量，验证宿主侧核对（链/合约锚/条款事实）与可读摘要。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, toHex } from "viem";
import {
  INVITE_ACCEPT_SIGNER_FIELD,
  OrderFinalizeTypedDataError,
  UVP_ORDER_FINALIZE_PRIMARY_TYPE,
  UVP_ORDER_FINALIZE_TYPE_HASH,
  buildUVPOrderFinalizeTypedData,
  summarizeOrderFinalizeTypedData,
  verifyOrderFinalizeTypedData,
  InviteAcceptTypedDataError,
  UVP_ORDER_BOOK_DOMAIN_NAME,
  UVP_ORDER_BOOK_DOMAIN_VERSION,
  UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE,
  UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS,
  UVP_STAGE_INVITE_ACCEPT_TYPE_HASH,
  buildInviteAcceptTypedDataFromPreview,
  summarizeInviteAcceptTypedData,
  verifyInviteAcceptTypedData
} from "../../src/browser/product/kernel/index.js";
import {
  BUYER,
  CHAIN_ID,
  PERFORMER,
  STANDARD_HASH,
  STATE_MACHINE,
  invitePreviewFixture,
  inviteTypedDataFixture
} from "./fixtures.js";

const EXPECTED_TYPE_HASH = "0xbe4ab67c8ccc92929271cc75bbc187c1d2776ec477d6fedd2189512662b0235e";
const ENCODE_TYPE =
  "UVPStageInviteAccept(string draftId,string inviteId,string stageKey,bytes32 stageId,string slotKey,address invitee,uint256 amount,bytes32 finalStandardHash,uint256 workDeadline,bytes32 termsHash,uint256 nonce,uint256 deadline)";

describe("UVPStageInviteAccept type hash", () => {
  it("matches the canonical encodeType and the pinned hash", () => {
    const recomputed = keccak256(toHex(ENCODE_TYPE));
    assert.equal(UVP_STAGE_INVITE_ACCEPT_TYPE_HASH, EXPECTED_TYPE_HASH);
    assert.equal(recomputed, EXPECTED_TYPE_HASH);
  });

  it("keeps the declaration order of the protocol field list", () => {
    assert.deepEqual(
      UVP_STAGE_INVITE_ACCEPT_TYPED_DATA_FIELDS.map((field) => `${field.type} ${field.name}`),
      ENCODE_TYPE.slice("UVPStageInviteAccept(".length, -1).split(",")
    );
  });
});

describe("invite accept typed data domain", () => {
  it("uses UVPOrderBook/1 with the draft state machine as verifying contract", () => {
    const typedData = inviteTypedDataFixture();
    assert.equal(typedData.domain.name, UVP_ORDER_BOOK_DOMAIN_NAME);
    assert.equal(typedData.domain.version, UVP_ORDER_BOOK_DOMAIN_VERSION);
    assert.equal(typedData.primaryType, UVP_STAGE_INVITE_ACCEPT_PRIMARY_TYPE);
    assert.equal(typedData.domain.chainId, CHAIN_ID);
    assert.equal(typedData.domain.verifyingContract.toLowerCase(), STATE_MACHINE);
    assert.equal(INVITE_ACCEPT_SIGNER_FIELD, "invitee");
  });

  it("stores deadlines and amount as uint256 decimal strings", () => {
    const typedData = inviteTypedDataFixture();
    assert.equal(typedData.message.amount, "1200000000");
    assert.equal(typedData.message.workDeadline, String(Date.parse("2026-11-20T00:00:00.000Z") / 1000));
    assert.equal(typedData.message.deadline, String(Date.parse("2026-11-01T00:00:00.000Z") / 1000));
  });
});

describe("verifyInviteAcceptTypedData", () => {
  const expectation = { chainId: CHAIN_ID, verifyingContract: STATE_MACHINE };

  it("accepts matching domain and facts", () => {
    const typedData = verifyInviteAcceptTypedData(inviteTypedDataFixture(), expectation, {
      termsHash: `0x${"f0".repeat(32)}`,
      nonce: "123456789",
      invitee: PERFORMER,
      amount: "1200000000",
      finalStandardHash: STANDARD_HASH
    });
    assert.equal(typedData.message.invitee.toLowerCase(), PERFORMER);
  });

  it("rejects a different chain id", () => {
    assert.throws(
      () => verifyInviteAcceptTypedData(inviteTypedDataFixture(), { ...expectation, chainId: 1 }),
      (error: unknown) => error instanceof InviteAcceptTypedDataError && error.code === "domain_chain_id"
    );
  });

  it("rejects a different verifying contract", () => {
    assert.throws(
      () =>
        verifyInviteAcceptTypedData(inviteTypedDataFixture(), {
          ...expectation,
          verifyingContract: "0x5555555555555555555555555555555555555555"
        }),
      (error: unknown) => error instanceof InviteAcceptTypedDataError && error.code === "domain_verifying_contract"
    );
  });

  it("rejects terms that do not match the known facts", () => {
    assert.throws(
      () => verifyInviteAcceptTypedData(inviteTypedDataFixture(), expectation, { amount: "1" }),
      (error: unknown) => error instanceof InviteAcceptTypedDataError && error.code === "fact_mismatch"
    );
  });

  it("rejects malformed typed data before any wallet use", () => {
    const broken = { ...inviteTypedDataFixture(), primaryType: "UVPStageDepositTerms" };
    assert.throws(
      () => verifyInviteAcceptTypedData(broken, expectation),
      (error: unknown) => error instanceof InviteAcceptTypedDataError && error.code === "invalid_typed_data"
    );
  });
});

describe("invite accept summary", () => {
  it("exposes display fields without assuming token decimals", () => {
    const withoutDecimals = summarizeInviteAcceptTypedData(inviteTypedDataFixture());
    assert.equal(withoutDecimals.amountDisplay, undefined);
    assert.equal(withoutDecimals.workDeadlineIso, "2026-11-20T00:00:00.000Z");
    assert.equal(withoutDecimals.deadlineIso, "2026-11-01T00:00:00.000Z");
    assert.equal(withoutDecimals.signerField, "invitee");

    const withDecimals = summarizeInviteAcceptTypedData(inviteTypedDataFixture(), { tokenDecimals: 6 });
    assert.equal(withDecimals.amountDisplay, "1,200.000000");
  });
});

describe("rebuild from server preview", () => {
  it("reproduces the server typed data exactly", () => {
    const preview = invitePreviewFixture();
    const rebuilt = buildInviteAcceptTypedDataFromPreview(preview, PERFORMER);
    assert.deepEqual(rebuilt, preview.typedData);
  });
});

describe("UVPOrderFinalize typed data", () => {
  const typedData = () => buildUVPOrderFinalizeTypedData({
    chainId: CHAIN_ID,
    verifyingContract: STATE_MACHINE,
    draftId: "draft-1",
    planId: `0x${"0a".repeat(32)}`,
    configId: "example/order-config",
    configVersion: "1.0.0",
    configHash: `0x${"cc".repeat(32)}`,
    buyer: PERFORMER,
    termsHash: `0x${"0c".repeat(32)}`,
    nonce: "42",
    deadline: Math.floor(Date.parse("2026-11-01T00:00:00.000Z") / 1000)
  });

  it("uses the UVPOrderBook/1 domain and the shared type hash", () => {
    const value = typedData();
    assert.equal(value.primaryType, UVP_ORDER_FINALIZE_PRIMARY_TYPE);
    assert.equal(value.domain.name, "UVPOrderBook");
    assert.equal(value.domain.version, "1");
    assert.equal(UVP_ORDER_FINALIZE_TYPE_HASH, "0x87839ea85d602eb765b6212de2265acae60f4652e9ca17df45111c78c1dc1cb1");
    assert.equal(value.message.buyer.toLowerCase(), PERFORMER);
  });

  it("verifies the domain and buyer/terms facts", () => {
    const expectation = { chainId: CHAIN_ID, verifyingContract: STATE_MACHINE };
    const verified = verifyOrderFinalizeTypedData(typedData(), expectation, {
      draftId: "draft-1",
      buyer: PERFORMER,
      termsHash: `0x${"0c".repeat(32)}`,
      nonce: "42"
    });
    assert.equal(verified.message.nonce, "42");
    assert.throws(
      () => verifyOrderFinalizeTypedData(typedData(), expectation, { buyer: BUYER }),
      (error: unknown) => error instanceof OrderFinalizeTypedDataError && error.code === "fact_mismatch"
    );
    const summary = summarizeOrderFinalizeTypedData(typedData());
    assert.equal(summary.signerField, "buyer");
    assert.equal(summary.deadlineIso, "2026-11-01T00:00:00.000Z");
  });
});
