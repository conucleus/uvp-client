// D13 StageExecutorChange：browser 单一入口 re-export 的构造/域常量/恢复原语可加载；
// EIP-712 域、字段表与 typehash 归 protocol-bindings，本测试不 pin 编码，只验证经
// browser 入口构建的 typed data 签名后能由同一入口还原签名者。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildStageExecutorChangeTypedData,
  recoverStageExecutorChangeSigner
} from "../../src/browser/index.js";

const account = privateKeyToAccount(
  keccak256(stringToBytes("uvp-client.stage-executor-change.test"))
);
const VERIFYING_CONTRACT = "0x8888888888888888888888888888888888888888";

describe("stage executor change typed data", () => {
  it("recovers the signer of typed data built through the browser entry", async () => {
    const typedData = buildStageExecutorChangeTypedData({
      chainId: 31337,
      verifyingContract: VERIFYING_CONTRACT,
      planId: `0x${"01".repeat(32)}`,
      orderId: `0x${"02".repeat(32)}`,
      stageId: `0x${"03".repeat(32)}`,
      executor: account.address,
      signalsHash: `0x${"04".repeat(32)}`,
      deadline: 1_800_000_000n,
      patchNonce: 7n
    });

    const signature = await account.signTypedData(
      typedData as unknown as Parameters<typeof account.signTypedData>[0]
    );
    const recovered = await recoverStageExecutorChangeSigner(typedData, signature);
    assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
  });
});
