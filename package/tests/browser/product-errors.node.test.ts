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
  it("sends the session header and idempotency key", async () => {
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
        return jsonResponse({ draft: { draftId: "draft-1", status: "draft" }, slots: [] });
      }
    });
    await client.createOrderDraft(
      {
        configId: "example/order-config",
        configVersion: "1.0.0",
        title: "t",
        currency: "USDT",
        stageSubset: ["stage-b"],
        stageTerms: [{ stageKey: "stage-b", amount: "1", inviteDeadline: "2026-11-01T00:00:00Z", workDeadline: "2026-11-20T00:00:00Z" }]
      },
      { idempotencyKey: "idem-1" }
    );
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "https://product.test/product/v3/order-drafts");
    assert.equal(seen.headers?.["x-uvp-store-session"], "session-abc");
    assert.equal(seen.headers?.["idempotency-key"], "idem-1");
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
});
