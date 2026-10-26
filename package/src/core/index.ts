/**
 * Runtime-agnostic core: operation vocabulary/prepare/sign engine and
 * direct/relay transports (the one write path shared by browser, headless and
 * CLI), product-service transport/auth seam, chain targets, ABI-driven signal
 * build/decode/submit, order-birth intent/authorization split, validation,
 * signing helpers, evidence hashing, and error classification. ABI/EIP-712
 * single source is @uvp-eth/protocol-bindings.
 */
export * from './birth.js';
export * from './chain-target.js';
export * from './constants.js';
export * from './errors.js';
export * from './evidence.js';
export * from './operations.js';
export * from './order-birth.js';
export * from './product-transport.js';
export * from './registration.js';
export * from './signing.js';
export * from './signal/index.js';
export * from './transport.js';
export * from './typed-data.js';
export * from './validation.js';
