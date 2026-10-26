/**
 * Runtime-agnostic core: product-service transport/auth seam, chain targets,
 * ABI-driven signal build/decode/submit, validation, signing helpers, evidence
 * hashing, and error classification. ABI/EIP-712 single source is
 * @uvp-eth/protocol-bindings.
 */
export * from './chain-target.js';
export * from './constants.js';
export * from './errors.js';
export * from './evidence.js';
export * from './signing.js';
export * from './signal/index.js';
export * from './transport.js';
export * from './validation.js';
