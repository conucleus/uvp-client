/**
 * Product V3 kernel surface: order-domain client, config flattening, draft
 * mapping, invite/finalize typed-data verification, and view/DTO types. DTO
 * source is product-dto; transport and product API errors come from core.
 */
export * from "./types.js";
export * from "./client.js";
export * from "./config.js";
export * from "./draft.js";
export * from "./typedData.js";

export {
  ProductError,
  classifyProductFailure,
  invalidResponse,
  isProductConflict,
  isProductError,
  isProductForbidden,
  isProductGone,
  isProductNotFound,
  isWalletIdentityRequiredKernel,
  requireArray,
  requireRecord,
  requireString,
  DEFAULT_PRODUCT_TIMEOUT_MS,
  PRODUCT_IDEMPOTENCY_HEADER,
  PRODUCT_SESSION_HEADER,
  ProductTransport,
  type ProductErrorInput,
  type ProductErrorKind,
  type ProductFetcher,
  type ProductRequestOptions,
  type ProductSessionTokenProvider,
  type ProductTransportConfig,
} from "../../../core/product-transport.js";
