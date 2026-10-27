// 客户端错误映射与传输口径：状态码 → kind、错误短码/详情保留、会话头、
// 超时=结果未知、拒绝跟随重定向、2xx 非 JSON 按 invalid_response。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductError,
  createProductClient,
  isProductError,
  isWalletIdentityRequiredKernel,
  type ProductFetcher
} from "../../src/browser/product/kernel/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function failingClient(body: unknown, status: number) {
  return createProductClient({
    baseUrl: "https://product.test",
    fetcher: async () => jsonResponse(body, status)
  });
}

async function expectError(
  run: () => Promise<unknown>
): Promise<ProductError> {
  try {
    await run();
  } catch (error) {
    assert.ok(isProductError(error), "expected ProductError");
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("product error mapping", () => {
  it("maps 409 to conflict with server code and message", async () => {
    const client = failingClient({ error: "invite_not_active", message: "invite is not active" }, 409);
    const error = await expectError(() => client.previewInvite("invite-1", "token-1"));
    assert.equal(error.kind, "conflict");
    assert.equal(error.status, 409);
    assert.equal(error.errorCode, "invite_not_active");
    assert.equal(error.retryable, false);
    assert.match(error.endpoint, /\/product\/v3\/invites\/invite-1\/preview$/u);
  });

  it("maps 401 wallet_identity_required and marks it as a session problem", async () => {
    const client = failingClient({ error: "wallet_identity_required", message: "session required" }, 401);
    const error = await expectError(() => client.getOrder("order-1"));
    assert.equal(error.kind, "unauthorized");
    assert.equal(isWalletIdentityRequiredKernel(error), true);
  });

  it("keeps 422 details and classifies as invalid_terms", async () => {
    const client = failingClient(
      { error: "invalid_window_value", message: "window must be within range", details: { window: "release" } },
      422
    );
    const error = await expectError(() => client.getOrderDraft("draft-1"));
    assert.equal(error.kind, "invalid_terms");
    assert.deepEqual(error.details, { window: "release" });
  });

  it("classifies 503 as retryable unavailable and 410 as gone", async () => {
    const unavailable = await expectError(() =>
      failingClient({ error: "order_anchor_unavailable", message: "anchor missing" }, 503).prepareFinalize("draft-1")
    );
    assert.equal(unavailable.kind, "unavailable");
    assert.equal(unavailable.retryable, true);

    const gone = await expectError(() =>
      failingClient({ error: "invite_expired", message: "invite has expired" }, 410).acceptInvite("invite-1", {
        token: "t",
        signature: `0x${"11".repeat(65)}`,
        termsHash: `0x${"22".repeat(32)}`,
        nonce: "1"
      })
    );
    assert.equal(gone.kind, "gone");
    assert.equal(gone.retryable, false);
  });

  it("maps finalize published-plan failures (409 missing / 503 unavailable)", async () => {
    const missing = await expectError(() =>
      failingClient(
        { error: "published_plan_missing", message: "config version has no published plan" },
        409
      ).prepareFinalize("draft-1")
    );
    assert.equal(missing.kind, "conflict");
    assert.equal(missing.errorCode, "published_plan_missing");
    assert.equal(missing.retryable, false);

    const unavailable = await expectError(() =>
      failingClient(
        { error: "published_plan_unavailable", message: "published-plan lookup failed" },
        503
      ).prepareFinalize("draft-1")
    );
    assert.equal(unavailable.kind, "unavailable");
    assert.equal(unavailable.errorCode, "published_plan_unavailable");
    assert.equal(unavailable.retryable, true);
  });

  it("rejects redirects instead of following them", async () => {
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => new Response(null, { status: 302 })
    });
    const error = await expectError(() => client.getOrder("order-1"));
    assert.equal(error.kind, "redirect_refused");
    assert.equal(error.message, "redirect_refused:302");
  });

  it("treats a 2xx non-JSON body as invalid_response", async () => {
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => new Response("<html>ok</html>", { status: 200 })
    });
    const error = await expectError(() => client.getOrder("order-1"));
    assert.equal(error.kind, "invalid_response");
  });

  it("reports timeout as unknown result instead of a retryable success", async () => {
    const hanging: ProductFetcher = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = createProductClient({ baseUrl: "https://product.test", fetcher: hanging, timeoutMs: 20 });
    const error = await expectError(() => client.getOrder("order-1"));
    assert.equal(error.kind, "timeout");
    assert.match(error.message, /服务端可能已处理/u);
  });

  it("classifies a fetch failure as transport", async () => {
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => {
        throw new Error("boom");
      }
    });
    const error = await expectError(() => client.getOrder("order-1"));
    assert.equal(error.kind, "transport");
    assert.match(error.message, /请求未送达：boom/u);
  });

  it("requires a baseUrl instead of falling back to sample data", () => {
    assert.throws(() => createProductClient({}), /订单服务地址未配置/u);
  });
});

describe("product transport", () => {
  it("sends the session header", async () => {
    const seen: {
      headers?: Record<string, string> | undefined;
      method?: string | undefined;
      url?: string | undefined;
    } = {};
    const client = createProductClient({
      baseUrl: "https://product.test",
      sessionToken: "session-abc",
      fetcher: async (input, init) => {
        seen.url = String(input);
        seen.method = init?.method;
        seen.headers = init?.headers as Record<string, string>;
        return jsonResponse({ draft: { draftId: "draft-1", status: "draft" }, slots: [], invites: [] });
      }
    });
    await client.createOrderDraft(
      {
        draftId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        configId: "example/order-config",
        configVersion: "1.0.0",
        title: "t",
        currency: "USDT",
        stageSubset: ["stage-b"],
        stageTerms: [{ stageKey: "stage-b", amount: "1", inviteDeadline: "2026-11-01T00:00:00Z", workDeadline: "2026-11-20T00:00:00Z" }]
      }
    );
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "https://product.test/product/v3/order-drafts");
    assert.equal(seen.headers?.["x-uvp-store-session"], "session-abc");
  });

  it("prefers the injected session token provider over the fixed token", async () => {
    let token = "first";
    const sessions: string[] = [];
    const client = createProductClient({
      baseUrl: "https://product.test",
      sessionToken: "fixed",
      getSessionToken: () => token,
      fetcher: async (_input, init) => {
        sessions.push((init?.headers as Record<string, string>)["x-uvp-store-session"] ?? "");
        return jsonResponse({ orderId: "order-1", dataState: "ok", stages: [] });
      }
    });
    await client.getOrder("order-1");
    token = "second";
    await client.getOrder("order-1");
    assert.deepEqual(sessions, ["first", "second"]);
  });

  it("aligns paths with the server routes", async () => {
    const urls: string[] = [];
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async (input) => {
        urls.push(String(input));
        return jsonResponse({ configId: "c", version: "1", status: "published", configHash: "0x00", bundle: {} });
      }
    });
    await client.getConfig("example/order-config", "1.0.0", { viaVersionsAlias: true });
    assert.equal(
      urls[0],
      "https://product.test/product/v3/configs/example%2Forder-config/versions/1.0.0"
    );

    const stageUrls: string[] = [];
    const stageClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async (input) => {
        stageUrls.push(String(input));
        return jsonResponse({ order: { orderId: "order-1", dataState: "ok", stages: [] }, stage: { stageKey: "stage-b" }, dataState: "ok" });
      }
    });
    await stageClient.getOrderStage("order-1", "stage-b");
    assert.equal(stageUrls[0], "https://product.test/product/v3/orders/order-1/stages/stage-b");
  });

  it("drives prepare -> sign -> finalize and keeps birth status unknown as-is", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const preparation = {
      draftId: "draft-1",
      planId: `0x${"0a".repeat(32)}`,
      planHash: `0x${"0b".repeat(32)}`,
      termsHash: `0x${"0c".repeat(32)}`,
      payloadHash: `0x${"0d".repeat(32)}`,
      fundedStageKeys: ["stage-b"],
      skippedStageKeys: ["stage-c"],
      nonce: "42",
      deadline: "2026-11-01T00:00:00.000Z",
      typedData: {
        domain: { name: "UVPOrderBook", version: "1", chainId: 31337, verifyingContract: "0x4444444444444444444444444444444444444444" },
        types: { UVPOrderFinalize: [] },
        primaryType: "UVPOrderFinalize",
        message: {}
      }
    };
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), ...(init?.method ? { method: init.method } : {}), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (String(input).endsWith("/finalize/prepare")) {
          return jsonResponse(preparation);
        }
        return jsonResponse({
          draftId: "draft-1",
          orderId: `0x${"0e".repeat(32)}`,
          planId: preparation.planId,
          planHash: preparation.planHash,
          stateMachine: "0x4444444444444444444444444444444444444444",
          status: "unknown",
          fundedStageKeys: ["stage-b"],
          skippedStageKeys: ["stage-c"]
        });
      }
    });
    const prepared = await client.prepareFinalize("draft-1");
    assert.equal(prepared.typedData.primaryType, "UVPOrderFinalize");
    const result = await client.finalizeWithSignature("draft-1", { signature: `0x${"11".repeat(65)}` });
    assert.equal(result.status, "unknown");
    assert.deepEqual(result.fundedStageKeys, ["stage-b"]);
    assert.equal(calls.length, 2, "unknown 结果不得自动重试");
    assert.equal(calls[0]?.url, "https://product.test/product/v3/order-drafts/draft-1/finalize/prepare");
    assert.equal(calls[1]?.url, "https://product.test/product/v3/order-drafts/draft-1/finalize");
    assert.deepEqual(calls[1]?.body, { signature: `0x${"11".repeat(65)}` });
  });

  it("maps fee override rejection to invalid_terms with the server code", async () => {
    const client = failingClient({ error: "fee_override_forbidden", message: "fee is fixed by the config version" }, 422);
    const error = await expectError(() =>
      client.createOrderDraft({
        configId: "example/order-config",
        configVersion: "1.0.0",
        title: "t",
        currency: "USDT",
        stageSubset: ["stage-b"],
        stageTerms: [{ stageKey: "stage-b", amount: "1", inviteDeadline: "2026-11-01T00:00:00Z", workDeadline: "2026-11-20T00:00:00Z" }]
      })
    );
    assert.equal(error.kind, "invalid_terms");
    assert.equal(error.errorCode, "fee_override_forbidden");
    assert.equal(error.retryable, false);
  });

  it("decodes only the four file resource resolution kinds", async () => {
    const external: ProductFetcher = async () =>
      jsonResponse({ kind: "external", type: "curator-doc", handle: { name: "std/inspection" } });
    const client = createProductClient({ baseUrl: "https://product.test", fetcher: external });
    assert.deepEqual(await client.resolveStageResource("order-1", "stage-1", "0xabc"), {
      kind: "external",
      type: "curator-doc",
      handle: { name: "std/inspection" }
    });

    const wrongShape = failingClient({ kind: "ok", contentHash: "0x00" }, 200);
    const error = await expectError(() => wrongShape.resolveStageResource("order-1", "stage-1", "0xabc"));
    assert.equal(error.kind, "invalid_response");
    assert.match(error.endpoint, /\/orders\/order-1\/stages\/stage-1\/resources\/0xabc$/u);
  });

  it("strictly decodes draft invites", async () => {
    const invite = {
      inviteId: "invite-1",
      draftId: "draft-1",
      stageKey: "stage-1",
      slotKey: "performer",
      status: "active",
      expiresAt: "2026-10-28T00:00:00.000Z",
      createdAt: "2026-10-27T00:00:00.000Z"
    };
    const detailClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ draft: { draftId: "draft-1" }, slots: [], invites: [invite] })
    });
    assert.equal((await detailClient.getOrderDraft("draft-1")).invites[0]?.status, "active");

    const missingInvites = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ draft: { draftId: "draft-1" }, slots: [] })
    });
    assert.equal((await expectError(() => missingInvites.getOrderDraft("draft-1"))).kind, "invalid_response");
  });

  it("strictly decodes config catalogs, my orders and attach receipts", async () => {
    const configClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () =>
        jsonResponse({
          configs: [
            {
              configId: "example/order-config",
              version: "1.0.0",
              status: "published",
              configHash: `0x${"11".repeat(32)}`,
              bundle: { configId: "example/order-config", version: "1.0.0" }
            }
          ]
        })
    });
    assert.equal((await configClient.listConfigs())[0]?.configId, "example/order-config");

    const order = {
      orderId: `0x${"31".repeat(32)}`,
      draftId: "draft-1",
      configId: "example/order-config",
      configVersion: "1.0.0",
      buyerWallet: "0x2222222222222222222222222222222222222222",
      role: "buyer",
      title: "t",
      currency: "USDT",
      status: "triggered",
      createdAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z"
    };
    const ordersClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ orders: [order] })
    });
    assert.equal((await ordersClient.listOrders())[0]?.role, "buyer");

    const badRole = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ orders: [{ ...order, role: "owner" }] })
    });
    assert.equal((await expectError(() => badRole.listOrders())).kind, "invalid_response");

    const attachClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () =>
        jsonResponse({
          draftId: "draft-1",
          orderId: order.orderId,
          planId: `0x${"32".repeat(32)}`,
          planHash: `0x${"33".repeat(32)}`,
          stateMachine: "0x1111111111111111111111111111111111111111",
          status: "triggered",
          fundedStageKeys: ["inspection"],
          skippedStageKeys: []
        })
    });
    assert.equal((await attachClient.attachOrder("draft-1", { orderId: order.orderId, planId: `0x${"32".repeat(32)}` })).status, "triggered");
  });

  it("uploads and reads evidence with strict shapes and a named 404", async () => {
    let uploadUrl = "";
    const uploadClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async (input) => {
        uploadUrl = String(input);
        return jsonResponse({
          evidence: { evidenceId: "ev_1", status: "uploaded" },
          metadata: { evidenceId: "ev_1" },
          accessPolicy: { evidenceId: "ev_1" },
          payloadHash: `0x${"11".repeat(32)}`,
          payloadRef: "uvp-evidence://product/ev_1"
        });
      }
    });
    const uploaded = await uploadClient.uploadEvidence({
      stageIdentifier: "inspection",
      content: { encoding: "text", value: "check" }
    });
    assert.equal(uploaded.evidence.evidenceId, "ev_1");
    assert.equal(uploadUrl, "https://product.test/product/evidence");

    const badUpload = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ evidence: { evidenceId: "ev_1" } })
    });
    assert.equal((await expectError(() => badUpload.uploadEvidence({}))).kind, "invalid_response");

    const notFound = failingClient({ error: "evidence_not_found", message: "evidence was not found" }, 404);
    const missing = await expectError(() => notFound.getEvidence("ev_1"));
    assert.equal(missing.kind, "not_found");
    assert.equal(missing.errorCode, "evidence_not_found");

    const proofClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () =>
        jsonResponse({
          evidenceId: "ev_1",
          payloadHash: `0x${"11".repeat(32)}`,
          contentHash: `0x${"22".repeat(32)}`,
          metadataHash: `0x${"33".repeat(32)}`,
          payloadRef: "uvp-evidence://product/ev_1",
          storageURI: "local://evidence/ev_1",
          verificationStatus: "matched"
        })
    });
    assert.equal((await proofClient.getEvidenceProof("ev_1")).verificationStatus, "matched");
  });

  it("decodes operator order views and config dry-run results strictly", async () => {
    const opsClient = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () =>
        jsonResponse({
          orderId: `0x${"31".repeat(32)}`,
          planId: `0x${"32".repeat(32)}`,
          status: "triggered",
          dataState: "ok",
          stages: [{ stageKey: "inspection", index: 0, status: "active" }],
          exceptions: []
        })
    });
    assert.equal((await opsClient.getOperatorOrder(`0x${"31".repeat(32)}`)).stages[0]?.stageKey, "inspection");

    const forbidden = failingClient({ error: "operator_required", message: "operator wallet required" }, 403);
    const denied = await expectError(() => forbidden.getOperatorOrder(`0x${"31".repeat(32)}`));
    assert.equal(denied.kind, "forbidden");
    assert.equal(denied.errorCode, "operator_required");

  });

  it("strictly decodes operator audit events", async () => {
    let seenUrl = "";
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async (input) => {
        seenUrl = String(input);
        return jsonResponse({
          events: [
            {
              eventId: "aud_1",
              chainId: 31337,
              actorWallet: "0x2222222222222222222222222222222222222222",
              action: "invite.accept",
              orderId: `0x${"31".repeat(32)}`,
              inviteId: "invite-1",
              createdAt: "2026-10-27T00:00:00.000Z"
            }
          ]
        });
      }
    });
    const events = await client.getOperatorAudit({ orderId: `0x${"31".repeat(32)}`, limit: 10 });
    assert.equal(events[0]?.action, "invite.accept");
    assert.match(seenUrl, /\/product\/v3\/ops\/audit\?orderId=/u);
    assert.match(seenUrl, /limit=10$/u);

    const wrongShape = failingClient(
      { events: [{ eventId: "aud_1", actorWallet: "0x22", action: "evil.action", createdAt: "now" }] },
      200
    );
    assert.equal((await expectError(() => wrongShape.getOperatorAudit())).kind, "invalid_response");
  });

  it("strictly decodes task action assembly and keeps named failures", async () => {
    const action = {
      orderId: `0x${"31".repeat(32)}`,
      taskId: "task:0x31:inspection:performer:perform_stage",
      stageKey: "inspection",
      slotKey: "performer",
      kind: "perform_stage",
      chainId: 31337,
      stateMachineAddress: "0x1111111111111111111111111111111111111111",
      planId: `0x${"32".repeat(32)}`,
      planHash: `0x${"33".repeat(32)}`,
      submitter: "0x2222222222222222222222222222222222222222",
      signals: [
        {
          signalName: "report_ready",
          admissionId: `0x${"44".repeat(32)}`,
          stageId: `0x${"55".repeat(32)}`,
          sourceId: `0x${"66".repeat(32)}`,
          signalId: `0x${"77".repeat(32)}`
        }
      ],
      nextAction: "履约/提交"
    };
    const client = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse(action)
    });
    assert.equal((await client.prepareTaskAction(action.orderId, action.taskId)).signals[0]?.signalName, "report_ready");

    const wrongShape = createProductClient({
      baseUrl: "https://product.test",
      fetcher: async () => jsonResponse({ ...action, chainId: "31337" })
    });
    assert.equal((await expectError(() => wrongShape.prepareTaskAction(action.orderId, action.taskId))).kind, "invalid_response");

    const noSignal = failingClient({ error: "no_signal_for_task", message: "no admission for task" }, 409);
    assert.equal((await expectError(() => noSignal.prepareTaskAction(action.orderId, action.taskId))).errorCode, "no_signal_for_task");

    const unavailable = failingClient({ error: "plan_artifact_unavailable", message: "plan artifact missing" }, 503);
    const error = await expectError(() => unavailable.prepareTaskAction(action.orderId, action.taskId));
    assert.equal(error.kind, "unavailable");
    assert.equal(error.retryable, true);
  });
});
