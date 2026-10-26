// 开单草稿映射：宿主选择 → 服务端 CreateOrderDraftInput。服务端没有
// performerSlotId/verifierSlotId 入参，映射不上的字段显式报错而不是静默丢弃。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCreateOrderDraftInput,
  flattenConfigVersion,
  flatStageByKey,
  mapStageSelection,
  type StageSelection
} from "../../src/browser/product/kernel/index.js";
import { STANDARD_HASH, configVersionFixture } from "./fixtures.js";

const INVITE_DEADLINE = "2026-11-01T00:00:00.000Z";
const WORK_DEADLINE = "2026-11-20T00:00:00.000Z";

function selection(overrides: Partial<StageSelection> = {}): StageSelection {
  return {
    stageKey: "stage-b",
    amountBaseUnits: "1200000000",
    inviteDeadline: INVITE_DEADLINE,
    workDeadline: WORK_DEADLINE,
    ...overrides
  };
}

function stageB() {
  const flat = flattenConfigVersion(configVersionFixture());
  const stage = flatStageByKey(flat, "stage-b");
  assert.ok(stage);
  return stage;
}

describe("mapStageSelection", () => {
  it("maps a funded stage to the server term shape without invented fields", () => {
    const result = mapStageSelection(selection(), stageB());
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.value, {
      stageKey: "stage-b",
      amount: "1200000000",
      inviteDeadline: INVITE_DEADLINE,
      workDeadline: WORK_DEADLINE
    });
    assert.equal("stageId" in result.value, false);
  });

  it("passes an explicit standard handle through and requires its hash", () => {
    const stage = stageB();
    const mapped = mapStageSelection(
      selection({ standardRef: { name: "std/custom", version: "1", hash: STANDARD_HASH, ref: "standards/custom.md" } }),
      stage
    );
    assert.equal(mapped.ok, true);
    if (mapped.ok) {
      assert.deepEqual(mapped.value.standard, {
        name: "std/custom",
        version: "1",
        hash: STANDARD_HASH,
        ref: "standards/custom.md"
      });
    }

    const missingHash = mapStageSelection(
      selection({ standardRef: { name: "std/custom", hash: "not-a-hash" } }),
      stage
    );
    assert.equal(missingHash.ok, false);
    if (!missingHash.ok) {
      assert.equal(missingHash.problem.code, "standard_hash_missing");
    }
  });

  it("requires both deadlines and their order", () => {
    const stage = stageB();
    const missingInvite = mapStageSelection(selection({ inviteDeadline: undefined }), stage);
    assert.equal(missingInvite.ok, false);
    if (!missingInvite.ok) {
      assert.equal(missingInvite.problem.code, "missing_invite_deadline");
    }
    const missingWork = mapStageSelection(selection({ workDeadline: undefined }), stage);
    assert.equal(missingWork.ok, false);
    if (!missingWork.ok) {
      assert.equal(missingWork.problem.code, "missing_work_deadline");
    }
    const inverted = mapStageSelection(
      selection({ inviteDeadline: WORK_DEADLINE, workDeadline: INVITE_DEADLINE }),
      stage
    );
    assert.equal(inverted.ok, false);
    if (!inverted.ok) {
      assert.equal(inverted.problem.code, "deadline_order");
    }
  });

  it("requires a standard handle when the config has no resolvable hash", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const requirements = flatStageByKey(flat, "stage-a");
    assert.ok(requirements);
    const result = mapStageSelection(
      selection({ stageKey: "stage-a" }),
      requirements
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "standard_hash_missing");
    }
  });
});

describe("buildCreateOrderDraftInput", () => {
  it("derives the stage subset from the selected stages in order", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const result = buildCreateOrderDraftInput({
      config: flat,
      title: "  示例订单  ",
      stages: [selection(), selection({ stageKey: "stage-c" })]
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.title, "示例订单");
    assert.equal(result.value.currency, "USDT");
    assert.equal(result.value.configId, "example/order-config");
    assert.equal(result.value.configVersion, "1.0.0");
    assert.deepEqual(result.value.stageSubset, ["stage-b", "stage-c"]);
    assert.deepEqual(result.value.stageTerms.map((term) => term.stageKey), ["stage-b", "stage-c"]);
  });

  it("rejects duplicate and unknown stages", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const duplicate = buildCreateOrderDraftInput({
      config: flat,
      title: "t",
      stages: [selection(), selection()]
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) {
      assert.equal(duplicate.problem.code, "duplicate_stage");
    }

    const unknown = buildCreateOrderDraftInput({
      config: flat,
      title: "t",
      stages: [selection({ stageKey: "not_a_stage" })]
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.problem.code, "unknown_stage");
    }
  });

  it("rejects a stageSubset that does not match the terms one-to-one", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const result = buildCreateOrderDraftInput({
      config: flat,
      title: "t",
      stages: [selection()],
      stageSubset: ["stage-b", "stage-c"]
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "stage_subset_mismatch");
    }
  });

  it("surfaces the first stage mapping problem with its code", () => {
    const flat = flattenConfigVersion(configVersionFixture());
    const result = buildCreateOrderDraftInput({
      config: flat,
      title: "t",
      stages: [selection({ amountBaseUnits: "abc" })]
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "invalid_amount");
    }
  });
});
