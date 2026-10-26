/**
 * Runtime-agnostic transport and auth/session seam for product-service HTTP:
 * caller-injected fetch, host-supplied session token, redirect refusal, and
 * stable error classification. Failures throw ProductError (status/error code/
 * readable message); malformed 2xx shapes become invalid_response, never an
 * empty result. Shared by browser and headless callers.
 */
export type ProductFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProductRequestOptions {
  /** 写请求的幂等键：服务端按 (wallet, operation, idempotencyKey, payload) 去重。 */
  readonly idempotencyKey?: string | undefined;
}

/** 钱包会话 token 提供者：宿主注入已有会话，core 不读取 env/localStorage。 */
export type ProductSessionTokenProvider = () => string | undefined;

export type ProductErrorKind =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "invalid_terms"
  | "unavailable"
  | "timeout"
  | "redirect_refused"
  | "invalid_response"
  | "transport"
  | "unknown";

export interface ProductErrorInput {
  readonly status: number;
  readonly endpoint: string;
  readonly message: string;
  readonly kind?: ProductErrorKind | undefined;
  readonly errorCode?: string | undefined;
  readonly details?: unknown;
  readonly bodyText?: string | undefined;
}

export class ProductError extends Error {
  override readonly name = "ProductError";
  readonly status: number;
  readonly endpoint: string;
  readonly kind: ProductErrorKind;
  /** 服务端错误体 `error` 短码；非 JSON 体或传输失败时为空。 */
  readonly errorCode?: string;
  /** 服务端错误体 `details`（如 missing slot 列表）；只在服务端给出时存在。 */
  readonly details?: unknown;
  /** 服务端错误体原文，供展开核对（message 已提取为可读文案时）。 */
  readonly bodyText?: string;

  constructor(input: ProductErrorInput) {
    super(input.message);
    this.status = input.status;
    this.endpoint = input.endpoint;
    this.kind = input.kind ?? classifyProductFailure(input.status, input.message);
    if (input.errorCode !== undefined) {
      this.errorCode = input.errorCode;
    }
    if (input.details !== undefined) {
      this.details = input.details;
    }
    if (input.bodyText !== undefined) {
      this.bodyText = input.bodyText;
    }
  }

  /** 仅 503 与超时可按「稍后重试」呈现；409/410/422 重试不会变好。 */
  get retryable(): boolean {
    return this.kind === "unavailable" || this.kind === "timeout";
  }

}

export function isProductError(value: unknown): value is ProductError {
  return value instanceof ProductError;
}

/** 401 + wallet_identity_required：宿主应切到钱包会话登录，而不是重试同一请求。 */
export function isWalletIdentityRequiredKernel(value: unknown): value is ProductError {
  return isProductError(value)
    && value.status === 401
    && (value.errorCode === undefined || value.errorCode === "wallet_identity_required");
}

export function isProductForbidden(value: unknown): value is ProductError {
  return isProductError(value) && value.kind === "forbidden";
}

export function isProductNotFound(value: unknown): value is ProductError {
  return isProductError(value) && value.kind === "not_found";
}

export function isProductConflict(value: unknown): value is ProductError {
  return isProductError(value) && value.kind === "conflict";
}

export function isProductGone(value: unknown): value is ProductError {
  return isProductError(value) && value.kind === "gone";
}

export function classifyProductFailure(status: number, message: string): ProductErrorKind {
  if (status === 0) {
    if (message.includes("请求超时")) {
      return "timeout";
    }
    if (message.startsWith("redirect_refused")) {
      return "redirect_refused";
    }
    return "invalid_response";
  }
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 410:
      return "gone";
    case 422:
      return "invalid_terms";
    case 503:
      return "unavailable";
    default:
      if (status >= 300 && status < 400) {
        return "redirect_refused";
      }
      if (status >= 500) {
        return "unavailable";
      }
      return "unknown";
  }
}


export const PRODUCT_SESSION_HEADER = "x-uvp-store-session";
export const PRODUCT_IDEMPOTENCY_HEADER = "idempotency-key";
export const DEFAULT_PRODUCT_TIMEOUT_MS = 6000;

export interface ProductTransportConfig {
  readonly baseUrl: string;
  readonly fetcher: ProductFetcher;
  readonly timeoutMs: number;
  readonly sessionToken?: string | undefined;
  readonly getSessionToken?: ProductSessionTokenProvider | undefined;
}

export class ProductTransport {
  readonly #config: ProductTransportConfig;
  #sessionToken: string | undefined;

  constructor(config: ProductTransportConfig) {
    this.#config = config;
    this.#sessionToken = config.sessionToken;
  }

  currentSessionToken(): string | undefined {
    return this.#resolveSessionToken();
  }

  restoreSessionToken(token: string | undefined): boolean {
    const changed = this.#sessionToken !== token;
    this.#sessionToken = token;
    return changed;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    pathname: string,
    body: unknown,
    options: ProductRequestOptions = {},
  ): Promise<T> {
    const timeoutMs = this.#config.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const sessionToken = this.#resolveSessionToken();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionToken !== undefined) {
      headers[PRODUCT_SESSION_HEADER] = sessionToken;
    }
    if (options.idempotencyKey !== undefined) {
      headers[PRODUCT_IDEMPOTENCY_HEADER] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await withTimeout(
        this.#config.fetcher(joinUrl(this.#config.baseUrl, pathname), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // 会话头随请求发送：3xx 会让凭据头重放到 Location 指向的任意主机。
          redirect: "manual",
          signal
        }),
        signal
      );
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
        throw new ProductError({
          status: 0,
          endpoint: pathname,
          kind: "timeout",
          message: `请求超时（${timeoutMs} 毫秒），服务端可能已处理本次请求。`
        });
      }
      throw new ProductError({
        status: 0,
        endpoint: pathname,
        kind: "transport",
        message: `请求未送达：${errorMessage(error)}`
      });
    }

    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw new ProductError({
        status: response.status,
        endpoint: pathname,
        kind: "redirect_refused",
        message: `redirect_refused:${response.status}`
      });
    }
    if (!response.ok) {
      throw await errorFromResponse(response, pathname);
    }
    try {
      return await response.json() as T;
    } catch (error) {
      throw invalidResponse(pathname, `2xx 响应不是 JSON：${errorMessage(error)}`);
    }
  }

  #resolveSessionToken(): string | undefined {
    const provided = this.#config.getSessionToken?.();
    if (provided !== undefined) {
      return provided;
    }
    return this.#sessionToken;
  }
}

export function invalidResponse(endpoint: string, message: string): ProductError {
  return new ProductError({ status: 0, endpoint, kind: "invalid_response", message });
}

export function requireRecord(value: unknown, endpoint: string, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(endpoint, message);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  record: Readonly<Record<string, unknown>>,
  field: string,
  endpoint: string,
  message?: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidResponse(endpoint, message ?? `响应缺少 ${field}`);
  }
  return value;
}

export function requireArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
  endpoint: string,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw invalidResponse(endpoint, `响应缺少 ${field} 数组`);
  }
  return value;
}

export function optionalRecord(
  record: Readonly<Record<string, unknown>>,
  field: string,
  endpoint: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, endpoint, `响应中的 ${field} 不是对象`);
}

async function errorFromResponse(response: Response, pathname: string): Promise<ProductError> {
  const text = await response.text();
  const bodyText = text.length > 0 ? text : `${response.status} ${response.statusText}`;
  let errorCode: string | undefined;
  let serverMessage: string | undefined;
  let details: unknown;
  try {
    const parsed = JSON.parse(bodyText) as { readonly error?: unknown; readonly message?: unknown; readonly details?: unknown };
    if (typeof parsed.error === "string") {
      errorCode = parsed.error;
    }
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      serverMessage = parsed.message;
    }
    if (parsed.details !== undefined) {
      details = parsed.details;
    }
  } catch {
    // 非 JSON 错误体只有文本可用。
  }
  return new ProductError({
    status: response.status,
    endpoint: pathname,
    message: serverMessage ?? bodyText,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(serverMessage !== undefined ? { bodyText } : {})
  });
}

function withTimeout(promise: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("signal aborted", "TimeoutError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
