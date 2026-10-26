// 配置摊平：bundle → 宿主可渲染的 stage 列表（角色 C式、必须邀请的 slot、
// 标准句柄、时间表达式、token 小数位来源），派生规则与服务端 canonical 同口径。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flattenConfigVersion,
  flatStageByKey,
  isStandardHash,
  resolveTokenDecimals,
  slotLabel
} from "../../src/browser/product/kernel/index.js";
import {
  CONFIG_HASH,
  PLAN_HASH,
  PLAN_ID,
  STAGE_ID_STAGE_B,
  configVersionFixture
} from "./fixtures.js";

describe("flattenConfigVersion", () => {
  it("flattens every stage with stable keys and derived slot lists", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    assert.equal(flat.configId, "example/order-config");
    assert.equal(flat.version, "1.0.0");
    assert.equal(flat.configHash, CONFIG_HASH);
    assert.equal(flat.planId, PLAN_ID);
    assert.equal(flat.planHash, PLAN_HASH);
    assert.equal(flat.currency, "USDT");
    assert.deepEqual(flat.stages.map((stage) => stage.stageKey), ["stage-a", "stage-b", "stage-c"]);
    assert.equal(flat.defaultProfile, "default");
    assert.deepEqual(flat.profiles.default, ["stage-a", "stage-b", "stage-c"]);
      });

  it("derives slots and requiredSlotKeys from the stage slot map", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const stageA = flatStageByKey(flat, "stage-a");
    assert.ok(stageA);
    assert.equal(stageA.funded, false);
    assert.deepEqual(stageA.requiredSlotKeys, ["slot-a"]);
    assert.deepEqual(stageA.slots, [{ slotKey: "slot-a", label: "阶段 A" }]);

    const stageB = flatStageByKey(flat, "stage-b");
    assert.ok(stageB);
    assert.equal(stageB.funded, true);
    assert.deepEqual(stageB.requiredSlotKeys, ["slot-b"]);
    assert.deepEqual(stageB.slots, [{ slotKey: "slot-b", label: "阶段 B" }]);
    assert.equal(stageB.timeExpression, "approved +14d");

    const stageC = flatStageByKey(flat, "stage-c");
    assert.ok(stageC);
    assert.deepEqual(stageC.requiredSlotKeys, ["slot-c"]);
    assert.deepEqual(stageC.slots, [{ slotKey: "slot-c", label: "阶段 C" }]);
    assert.equal(slotLabel(flat, "slot-b"), "slot B");
  });

  it("resolves standard handles and their hashes from the bundle", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const stageB = flatStageByKey(flat, "stage-b");
    assert.ok(stageB?.defaultStandard);
    assert.equal(stageB.defaultStandard.resolvable, true);
    assert.equal(stageB.defaultStandard.ref, "standards/stage-b.md");

    const stageC = flatStageByKey(flat, "stage-c");
    assert.ok(stageC?.defaultStandard);
    assert.equal(stageC.defaultStandard.resolvable, true, "sha256:<64 hex> is accepted by the server");
    assert.equal(isStandardHash(stageC.defaultStandard.hash), true);
  });

  it("only carries stageId when the server already derived it", () => {
    const withoutIds = flattenConfigVersion(configVersionFixture());
    assert.equal(flatStageByKey(withoutIds, "stage-b")?.stageId, undefined);

    const withIds = flattenConfigVersion(configVersionFixture(), {
      stageIds: { "stage-b": STAGE_ID_STAGE_B }
    });
    assert.equal(flatStageByKey(withIds, "stage-b")?.stageId, STAGE_ID_STAGE_B);
    assert.equal(flatStageByKey(withIds, "stage-c")?.stageId, undefined);
  });

  it("derives token decimals from currency but never guesses unknown ones", () => {
    const usdt = flattenConfigVersion(configVersionFixture());
    assert.equal(usdt.tokenDecimals, 6);
    assert.equal(usdt.tokenDecimalsSource, "currency");

    const overridden = flattenConfigVersion(configVersionFixture(), { tokenDecimals: 18 });
    assert.equal(overridden.tokenDecimals, 18);
    assert.equal(overridden.tokenDecimalsSource, "override");

    const base = configVersionFixture();
    const { currency: _currency, ...withoutCurrency } = base;
    const unknown = { ...withoutCurrency, bundle: { ...base.bundle, currency: "XYZ" } };
    const flatUnknown = flattenConfigVersion(unknown);
    assert.equal(flatUnknown.tokenDecimals, undefined);
    assert.equal(flatUnknown.tokenDecimalsSource, "unknown");
    assert.ok(flatUnknown.tokenDecimalsProblem);
  });
});

describe("resolveTokenDecimals", () => {
  it("prefers an explicit per-currency override", () => {
    assert.deepEqual(resolveTokenDecimals("USDT"), { ok: true, decimals: 6, source: "currency" });
    assert.deepEqual(resolveTokenDecimals("usdt", { USDT: 18 }), { ok: true, decimals: 18, source: "override" });
    assert.deepEqual(resolveTokenDecimals(undefined), {
      ok: false,
      reason: "配置没有声明 currency，无法确定 token 小数位"
    });
  });
});
